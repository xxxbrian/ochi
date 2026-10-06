package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ToolArgumentError lets the loop report correctable contract failures without
// confusing them with an executed operation or transient transport failure.
type ToolArgumentError struct {
	Tool    string `json:"tool,omitempty"`
	Code    string `json:"code"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

func (e *ToolArgumentError) Error() string {
	return fmt.Sprintf("%s at %s: %s", e.Code, e.Path, e.Message)
}

func schemaError(code, path, message string) error {
	return &ToolArgumentError{Code: code, Path: path, Message: message}
}

func decodeToolJSON(raw json.RawMessage) (any, error) {
	if !utf8.Valid(raw) {
		return nil, fmt.Errorf("JSON must use valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeToolValue(decoder, 0)
	if err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("expected one JSON value")
	}
	return value, nil
}

func decodeToolValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, fmt.Errorf("JSON nesting exceeds 64 levels")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, compound := token.(json.Delim)
	if !compound {
		if _, number := token.(json.Number); number {
			if _, valid := exactToolNumber(token); !valid {
				return nil, fmt.Errorf("number exceeds supported finite range")
			}
		}
		return token, nil
	}
	if delim == '{' {
		object := map[string]any{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, fmt.Errorf("object property must be a string")
			}
			if _, duplicate := object[name]; duplicate {
				return nil, fmt.Errorf("duplicate JSON property: %s", name)
			}
			child, err := decodeToolValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[name] = child
		}
		_, err = decoder.Token()
		return object, err
	}
	if delim == '[' {
		array := []any{}
		for decoder.More() {
			child, err := decodeToolValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, child)
		}
		_, err = decoder.Token()
		return array, err
	}
	return nil, fmt.Errorf("unexpected JSON delimiter")
}

// ValidateToolSchema rejects unsupported predicates instead of silently treating
// them as valid. Format and other documented annotations are not assertions.
func ValidateToolSchema(raw json.RawMessage) error {
	root, err := decodeToolJSON(raw)
	if err != nil {
		return schemaError("invalid_schema", "$", "schema must be valid JSON")
	}
	return checkToolSchema(root, root, "$", 0)
}

func ValidateToolArguments(def ToolDefinition, raw json.RawMessage) error {
	if err := ValidateToolSchema(def.Parameters); err != nil {
		if classified, ok := err.(*ToolArgumentError); ok {
			classified.Tool = def.Name
		}
		return err
	}
	value, err := decodeToolJSON(raw)
	if err != nil {
		return &ToolArgumentError{Tool: def.Name, Code: "invalid_arguments", Path: "$", Message: "arguments must be valid JSON"}
	}
	if _, ok := value.(map[string]any); !ok {
		return &ToolArgumentError{Tool: def.Name, Code: "invalid_arguments", Path: "$", Message: "tool arguments must be an object"}
	}
	root, _ := decodeToolJSON(def.Parameters)
	if err := checkToolValue(root, root, value, "$", 0); err != nil {
		if classified, ok := err.(*ToolArgumentError); ok {
			classified.Tool = def.Name
		}
		return err
	}
	return nil
}

var schemaAnnotations = map[string]bool{
	"$schema": true, "$id": true, "$comment": true, "title": true,
	"description": true, "default": true, "examples": true, "deprecated": true,
	"readOnly": true, "writeOnly": true, "format": true,
}

func checkToolSchema(root, schema any, path string, depth int) error {
	if depth > 64 {
		return schemaError("invalid_schema", path, "schema nesting exceeds 64 levels")
	}
	if _, ok := schema.(bool); ok {
		return nil
	}
	s, ok := schema.(map[string]any)
	if !ok {
		return schemaError("invalid_schema", path, "schema must be an object or boolean")
	}
	for _, key := range sortedSchemaKeys(s) {
		v, p := s[key], path+"."+key
		if schemaAnnotations[key] {
			switch key {
			case "$schema", "$id", "$comment", "title", "description", "format":
				if _, valid := v.(string); !valid {
					return schemaError("invalid_schema", p, "annotation must be a string")
				}
			case "deprecated", "readOnly", "writeOnly":
				if _, valid := v.(bool); !valid {
					return schemaError("invalid_schema", p, "annotation must be boolean")
				}
			case "examples":
				if _, valid := v.([]any); !valid {
					return schemaError("invalid_schema", p, "examples must be an array")
				}
			}
			continue
		}
		switch key {
		case "type":
			types, valid := schemaTypes(v)
			if !valid || len(types) == 0 {
				return schemaError("invalid_schema", p, "type must name supported JSON types")
			}
		case "properties", "$defs", "definitions":
			members, valid := v.(map[string]any)
			if !valid {
				return schemaError("invalid_schema", p, "expected an object of schemas")
			}
			for _, name := range sortedSchemaKeys(members) {
				if err := checkToolSchema(root, members[name], p+"."+name, depth+1); err != nil {
					return err
				}
			}
		case "items", "additionalProperties":
			if err := checkToolSchema(root, v, p, depth+1); err != nil {
				return err
			}
		case "required":
			list, valid := v.([]any)
			if !valid {
				return schemaError("invalid_schema", p, "required must be a list of strings")
			}
			seen := map[string]bool{}
			for _, item := range list {
				name, valid := item.(string)
				if !valid || seen[name] {
					return schemaError("invalid_schema", p, "required must contain distinct strings")
				}
				seen[name] = true
			}
		case "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties":
			n, valid := exactToolNumber(v)
			if !valid || n.Sign() < 0 || !n.IsInt() {
				return schemaError("invalid_schema", p, "expected a nonnegative integer")
			}
		case "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf":
			n, valid := exactToolNumber(v)
			if !valid || (key == "multipleOf" && n.Sign() <= 0) {
				return schemaError("invalid_schema", p, "expected a finite number (multipleOf must be positive)")
			}
		case "pattern":
			// Go RE2 and Python re do not share JSON Schema's ECMA-262
			// semantics. Do not silently weaken an extension's predicate.
			return schemaError("unsupported_schema", p, "regular-expression predicates are not supported")
		case "uniqueItems":
			if _, valid := v.(bool); !valid {
				return schemaError("invalid_schema", p, "uniqueItems must be boolean")
			}
		case "enum":
			list, valid := v.([]any)
			if !valid || len(list) == 0 {
				return schemaError("invalid_schema", p, "enum must be a nonempty array")
			}
			for i, item := range list {
				for _, earlier := range list[:i] {
					if toolJSONEqual(item, earlier) {
						return schemaError("invalid_schema", p, "enum must contain distinct values")
					}
				}
			}
		case "const":
		case "anyOf", "oneOf", "allOf":
			list, valid := v.([]any)
			if !valid || len(list) == 0 {
				return schemaError("invalid_schema", p, "expected a nonempty array of schemas")
			}
			for i, member := range list {
				if err := checkToolSchema(root, member, fmt.Sprintf("%s[%d]", p, i), depth+1); err != nil {
					return err
				}
			}
		case "$ref":
			ref, valid := v.(string)
			if !valid {
				return schemaError("invalid_schema", p, "$ref must be a string")
			}
			if !strings.HasPrefix(ref, "#/$defs/") && !strings.HasPrefix(ref, "#/definitions/") {
				return schemaError("unsupported_schema", p, "only local $defs/definitions references are supported")
			}
			target, err := resolveToolRef(root, ref)
			if err != nil {
				return schemaError("invalid_schema", p, err.Error())
			}
			if _, object := target.(map[string]any); !object {
				if _, boolean := target.(bool); !boolean {
					return schemaError("invalid_schema", p, "reference must target a schema")
				}
			}
		default:
			return schemaError("unsupported_schema", p, "unsupported JSON Schema keyword: "+key)
		}
	}
	return nil
}

func sortedSchemaKeys(s map[string]any) []string {
	keys := make([]string, 0, len(s))
	for k := range s {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func schemaTypes(v any) ([]string, bool) {
	var names []string
	switch value := v.(type) {
	case string:
		names = []string{value}
	case []any:
		for _, item := range value {
			name, ok := item.(string)
			if !ok {
				return nil, false
			}
			names = append(names, name)
		}
	default:
		return nil, false
	}
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] || (name != "object" && name != "array" && name != "string" && name != "number" && name != "integer" && name != "boolean" && name != "null") {
			return nil, false
		}
		seen[name] = true
	}
	return names, true
}

func schemaNumber(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func resolveToolRef(root any, ref string) (any, error) {
	value := root
	for _, token := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		key := strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		members, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("unresolved local reference %s", ref)
		}
		value, ok = members[key]
		if !ok {
			return nil, fmt.Errorf("unresolved local reference %s", ref)
		}
	}
	return value, nil
}

func matchesToolType(name string, value any) bool {
	switch name {
	case "null":
		return value == nil
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "number", "integer":
		n, ok := exactToolNumber(value)
		return ok && (name != "integer" || n.IsInt())
	}
	return false
}

func toolJSONEqual(a, b any) bool {
	if x, ok := exactToolNumber(a); ok {
		y, valid := exactToolNumber(b)
		return valid && x.Cmp(y) == 0
	}
	if x, ok := a.([]any); ok {
		y, valid := b.([]any)
		if !valid || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !toolJSONEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	if x, ok := a.(map[string]any); ok {
		y, valid := b.(map[string]any)
		if !valid || len(x) != len(y) {
			return false
		}
		for key, value := range x {
			other, exists := y[key]
			if !exists || !toolJSONEqual(value, other) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

func checkToolValue(root, schema, value any, path string, depth int) error {
	fail := func(message string) error { return schemaError("invalid_arguments", path, message) }
	if depth > 64 {
		return fail("argument/schema nesting exceeds 64 levels")
	}
	if _, number := value.(json.Number); number {
		if _, valid := exactToolNumber(value); !valid {
			return fail("number exceeds supported finite range")
		}
	}
	if allowed, ok := schema.(bool); ok {
		if !allowed {
			return fail("value is not allowed")
		}
		return nil
	}
	s, ok := schema.(map[string]any)
	if !ok {
		return schemaError("invalid_schema", path, "referenced schema must be an object or boolean")
	}
	if ref, ok := s["$ref"].(string); ok {
		target, _ := resolveToolRef(root, ref)
		if err := checkToolValue(root, target, value, path, depth+1); err != nil {
			return err
		}
	}
	if expected, exists := s["type"]; exists {
		types, _ := schemaTypes(expected)
		matched := false
		for _, name := range types {
			matched = matched || matchesToolType(name, value)
		}
		if !matched {
			return fail("expected " + strings.Join(types, " or "))
		}
	}
	if expected, exists := s["const"]; exists && !toolJSONEqual(expected, value) {
		return fail("value does not match const")
	}
	if options, exists := s["enum"].([]any); exists {
		matched := false
		for _, option := range options {
			matched = matched || toolJSONEqual(option, value)
		}
		if !matched {
			return fail("value is not in enum")
		}
	}
	for _, keyword := range []string{"allOf", "anyOf", "oneOf"} {
		if alternatives, exists := s[keyword].([]any); exists {
			matches := 0
			for _, alternative := range alternatives {
				if checkToolValue(root, alternative, value, path, depth+1) == nil {
					matches++
				}
			}
			if (keyword == "allOf" && matches != len(alternatives)) || (keyword == "anyOf" && matches == 0) || (keyword == "oneOf" && matches != 1) {
				return fail("value does not satisfy " + keyword)
			}
		}
	}
	if object, ok := value.(map[string]any); ok {
		if required, ok := s["required"].([]any); ok {
			for _, name := range required {
				if _, exists := object[name.(string)]; !exists {
					return fail("missing required property: " + name.(string))
				}
			}
		}
		if err := checkToolLength(s, len(object), "Properties", fail); err != nil {
			return err
		}
		properties, _ := s["properties"].(map[string]any)
		for _, name := range sortedSchemaKeys(object) {
			child, exists := properties[name]
			if !exists {
				child, exists = s["additionalProperties"]
				if !exists {
					continue
				}
			}
			if err := checkToolValue(root, child, object[name], path+"."+name, depth+1); err != nil {
				return err
			}
		}
	}
	if array, ok := value.([]any); ok {
		if err := checkToolLength(s, len(array), "Items", fail); err != nil {
			return err
		}
		if unique, _ := s["uniqueItems"].(bool); unique {
			for i, item := range array {
				for _, earlier := range array[:i] {
					if toolJSONEqual(item, earlier) {
						return fail("array items must be unique")
					}
				}
			}
		}
		if child, exists := s["items"]; exists {
			for i, item := range array {
				if err := checkToolValue(root, child, item, fmt.Sprintf("%s[%d]", path, i), depth+1); err != nil {
					return err
				}
			}
		}
	}
	if text, ok := value.(string); ok {
		if err := checkToolLength(s, utf8.RuneCountInString(text), "Length", fail); err != nil {
			return err
		}
	}
	if n, ok := exactToolNumber(value); ok {
		for _, key := range []string{"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"} {
			if bound, exists := exactToolNumber(s[key]); exists {
				valid := true
				switch key {
				case "minimum":
					valid = n.Cmp(bound) >= 0
				case "maximum":
					valid = n.Cmp(bound) <= 0
				case "exclusiveMinimum":
					valid = n.Cmp(bound) > 0
				case "exclusiveMaximum":
					valid = n.Cmp(bound) < 0
				case "multipleOf":
					valid = new(big.Rat).Quo(n, bound).IsInt()
				}
				if !valid {
					return fail("number violates " + key)
				}
			}
		}
	}
	return nil
}

func exactToolNumber(value any) (*big.Rat, bool) {
	n, ok := value.(json.Number)
	if !ok || len(n.String()) > 128 {
		return nil, false
	}
	// Finite float range alone does not catch huge negative exponents: those
	// underflow to zero but would allocate an enormous rational denominator.
	if i := strings.IndexAny(n.String(), "eE"); i >= 0 {
		exponent, err := strconv.Atoi(n.String()[i+1:])
		if err != nil || exponent < -400 || exponent > 400 {
			return nil, false
		}
	}
	if _, valid := schemaNumber(value); !valid {
		return nil, false
	}
	r, valid := new(big.Rat).SetString(n.String())
	return r, valid
}

func checkToolLength(s map[string]any, length int, suffix string, fail func(string) error) error {
	value := new(big.Rat).SetInt64(int64(length))
	if n, ok := exactToolNumber(s["min"+suffix]); ok && value.Cmp(n) < 0 {
		return fail("value is shorter than min" + suffix)
	}
	if n, ok := exactToolNumber(s["max"+suffix]); ok && value.Cmp(n) > 0 {
		return fail("value is longer than max" + suffix)
	}
	return nil
}
