"""The bridge's explicit JSON Schema subset, matching the Go tool preflight.

Unknown assertions (including regex/draft-specific predicates) fail closed.
Descriptions, defaults and formats are annotations, not assertions.
"""
from __future__ import annotations

import json
import math
from decimal import Decimal
from fractions import Fraction
from typing import Any


class ToolArgumentError(ValueError):
    def __init__(self, code: str, path: str, message: str, tool: str = "") -> None:
        super().__init__(f"{code} at {path}: {message}")
        self.detail = {"code": code, "path": path, "message": message, "tool": tool}


def strict_json(raw: bytes | str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate JSON property: {key}")
            result[key] = value
        return result

    def reject(value: str) -> None:
        raise ValueError(f"invalid JSON number: {value}")

    def number(value: str) -> Decimal:
        if len(value) > 128:
            raise ValueError("number exceeds supported finite range")
        parsed = Decimal(value)
        if _number(parsed) is None:
            raise ValueError("number exceeds supported finite range")
        return parsed

    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=reject,
                       parse_float=number, parse_int=number)
    _domain(value)
    return value


ANNOTATIONS = {"$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "format"}
TYPES = {"object", "array", "string", "number", "integer", "boolean", "null"}
LENGTHS = {"minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"}
NUMBERS = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"}


def _number(value: Any) -> Fraction | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    if len(str(value)) > 128:
        return None
    try:
        text = str(value)
        if "e" in text.casefold() and not -400 <= int(text.casefold().split("e")[1]) <= 400:
            return None
        if not math.isfinite(float(value)):
            return None
        return Fraction(str(value))
    except (OverflowError, ValueError):
        return None


def _domain(value: Any, path: str = "$", depth: int = 0, code: str = "invalid_arguments") -> None:
    if depth > 64:
        raise ToolArgumentError(code, path, "JSON nesting exceeds 64 levels")
    if not isinstance(value, bool) and isinstance(value, (int, float, Decimal)) and _number(value) is None:
        raise ToolArgumentError(code, path, "number exceeds supported finite range")
    if isinstance(value, dict):
        for name, child in value.items():
            _domain(child, path + "." + name, depth + 1, code)
    if isinstance(value, list):
        for i, child in enumerate(value):
            _domain(child, f"{path}[{i}]", depth + 1, code)


def _types(value: Any) -> list[str]:
    return [value] if isinstance(value, str) else value if isinstance(value, list) else []


def _ref(root: Any, ref: str) -> Any:
    target = root
    try:
        for token in ref[2:].split("/"):
            target = target[token.replace("~1", "/").replace("~0", "~")]
    except (KeyError, TypeError):
        raise ValueError(f"unresolved local reference {ref}") from None
    return target


def validate_schema(schema: Any, root: Any = None, path: str = "$", depth: int = 0) -> None:
    if root is None:
        _domain(schema, code="invalid_schema")
    root = schema if root is None else root
    def fail(message: str, code: str = "invalid_schema", where: str = path) -> None:
        raise ToolArgumentError(code, where, message)
    if depth > 64:
        fail("schema nesting exceeds 64 levels")
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        fail("schema must be an object or boolean")
    for key, value in sorted(schema.items()):
        p = path + "." + key
        if key in ANNOTATIONS:
            if key in {"$schema", "$id", "$comment", "title", "description", "format"} and not isinstance(value, str):
                fail("annotation must be a string", where=p)
            if key in {"deprecated", "readOnly", "writeOnly"} and not isinstance(value, bool):
                fail("annotation must be boolean", where=p)
            if key == "examples" and not isinstance(value, list):
                fail("examples must be an array", where=p)
            continue
        if key == "type":
            names = _types(value)
            if not names or not all(isinstance(n, str) and n in TYPES for n in names) or len(set(names)) != len(names):
                fail("type must name supported JSON types", where=p)
        elif key in {"properties", "$defs", "definitions"}:
            if not isinstance(value, dict):
                fail("expected an object of schemas", where=p)
            for name, child in sorted(value.items()):
                validate_schema(child, root, p + "." + name, depth + 1)
        elif key in {"items", "additionalProperties"}:
            validate_schema(value, root, p, depth + 1)
        elif key == "required":
            if not isinstance(value, list) or not all(isinstance(n, str) for n in value) or len(set(value)) != len(value):
                fail("required must contain distinct strings", where=p)
        elif key in LENGTHS:
            n = _number(value)
            if n is None or n < 0 or n.denominator != 1:
                fail("expected a nonnegative integer", where=p)
        elif key in NUMBERS:
            n = _number(value)
            if n is None or (key == "multipleOf" and n <= 0):
                fail("expected a finite number (multipleOf must be positive)", where=p)
        elif key == "uniqueItems":
            if not isinstance(value, bool):
                fail("uniqueItems must be boolean", where=p)
        elif key == "enum":
            if not isinstance(value, list) or not value:
                fail("enum must be a nonempty array", where=p)
            if any(_equal(item, earlier) for i, item in enumerate(value) for earlier in value[:i]):
                fail("enum must contain distinct values", where=p)
        elif key == "const":
            pass
        elif key in {"anyOf", "oneOf", "allOf"}:
            if not isinstance(value, list) or not value:
                fail("expected a nonempty array of schemas", where=p)
            for i, child in enumerate(value):
                validate_schema(child, root, f"{p}[{i}]", depth + 1)
        elif key == "$ref":
            if not isinstance(value, str):
                fail("$ref must be a string", where=p)
            if not value.startswith(("#/$defs/", "#/definitions/")):
                fail("only local $defs/definitions references are supported", "unsupported_schema", p)
            try:
                target = _ref(root, value)
            except ValueError as exc:
                fail(str(exc), where=p)
            if not isinstance(target, (dict, bool)):
                fail("reference must target a schema", where=p)
        elif key == "pattern":
            fail("regular-expression predicates are not supported", "unsupported_schema", p)
        else:
            fail("unsupported JSON Schema keyword: " + key, "unsupported_schema", p)


def _matches(name: str, value: Any) -> bool:
    if name == "null":
        return value is None
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "boolean":
        return isinstance(value, bool)
    n = _number(value)
    return n is not None and (name == "number" or (name == "integer" and n.denominator == 1))


def _equal(a: Any, b: Any) -> bool:
    if (n := _number(a)) is not None:
        return n == _number(b)
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_equal(a[k], b[k]) for k in a)
    return a == b


def _value(schema: Any, root: Any, value: Any, path: str, depth: int) -> None:
    def fail(message: str) -> None:
        raise ToolArgumentError("invalid_arguments", path, message)
    if depth > 64:
        fail("argument/schema nesting exceeds 64 levels")
    if not isinstance(value, bool) and isinstance(value, (int, float, Decimal)) and _number(value) is None:
        fail("number exceeds supported finite range")
    if isinstance(schema, bool):
        if not schema:
            fail("value is not allowed")
        return
    if "$ref" in schema:
        _value(_ref(root, schema["$ref"]), root, value, path, depth + 1)
    if "type" in schema and not any(_matches(name, value) for name in _types(schema["type"])):
        fail("expected " + " or ".join(_types(schema["type"])))
    if "const" in schema and not _equal(schema["const"], value):
        fail("value does not match const")
    if "enum" in schema and not any(_equal(option, value) for option in schema["enum"]):
        fail("value is not in enum")
    for keyword in ("allOf", "anyOf", "oneOf"):
        if keyword in schema:
            count = 0
            for child in schema[keyword]:
                try:
                    _value(child, root, value, path, depth + 1)
                    count += 1
                except ToolArgumentError:
                    pass
            if (keyword == "allOf" and count != len(schema[keyword])) or (keyword == "anyOf" and count == 0) or (keyword == "oneOf" and count != 1):
                fail("value does not satisfy " + keyword)
    suffix = "Properties" if isinstance(value, dict) else "Items" if isinstance(value, list) else "Length" if isinstance(value, str) else ""
    if suffix:
        for kind in ("min", "max"):
            if kind + suffix in schema:
                bound = _number(schema[kind + suffix])
                if (kind == "min" and len(value) < bound) or (kind == "max" and len(value) > bound):
                    fail(f"value is {'shorter' if kind == 'min' else 'longer'} than {kind}{suffix}")
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                fail("missing required property: " + name)
        properties = schema.get("properties", {})
        for name, child in sorted(value.items()):
            _value(properties.get(name, schema.get("additionalProperties", True)), root, child, path + "." + name, depth + 1)
    if isinstance(value, list):
        if schema.get("uniqueItems") and any(_equal(item, earlier) for i, item in enumerate(value) for earlier in value[:i]):
            fail("array items must be unique")
        for i, item in enumerate(value):
            _value(schema.get("items", True), root, item, f"{path}[{i}]", depth + 1)
    if (n := _number(value)) is not None:
        for key in NUMBERS:
            if key not in schema:
                continue
            bound = _number(schema[key])
            valid = {"minimum": lambda: n >= bound, "maximum": lambda: n <= bound,
                     "exclusiveMinimum": lambda: n > bound, "exclusiveMaximum": lambda: n < bound,
                     "multipleOf": lambda: (n / bound).denominator == 1}[key]()
            if not valid:
                fail("number violates " + key)


def validate_arguments(definition: dict[str, Any], args: Any) -> None:
    try:
        schema = definition["parameters"]
        validate_schema(schema)
        if not isinstance(args, dict):
            raise ToolArgumentError("invalid_arguments", "$", "tool arguments must be an object")
        _domain(args)
        _value(schema, schema, args, "$", 0)
    except ToolArgumentError as exc:
        exc.detail["tool"] = definition.get("name", "")
        raise
