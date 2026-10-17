package agent

import (
	"sort"
	"strings"
)

type toolCallDelta struct {
	Index    *int         `json:"index"`
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function functionCall `json:"function"`
}

type chatToolCalls struct {
	calls map[int]*toolCall
	ids   map[string]int
}

func (s *chatToolCalls) append(delta toolCallDelta) error {
	if delta.Index == nil {
		return toolProtocolError("missing_index", nil)
	}
	if *delta.Index < 0 {
		return toolProtocolError("invalid_index", delta.Index)
	}
	if delta.Type != "" && delta.Type != "function" {
		return toolProtocolError("unsupported_type", delta.Index)
	}
	if s.calls == nil {
		s.calls, s.ids = map[int]*toolCall{}, map[string]int{}
	}
	call := s.calls[*delta.Index]
	if call == nil {
		call = &toolCall{Type: "function"}
		s.calls[*delta.Index] = call
	}
	if delta.ID != "" {
		if call.ID != "" && call.ID != delta.ID {
			return toolProtocolError("conflicting_id", delta.Index)
		}
		if previous, found := s.ids[delta.ID]; found && previous != *delta.Index {
			return toolProtocolError("duplicate_id", delta.Index)
		}
		call.ID, s.ids[delta.ID] = delta.ID, *delta.Index
	}
	call.Function.Name += delta.Function.Name
	call.Function.Arguments += delta.Function.Arguments
	return nil
}

func (s *chatToolCalls) complete() ([]toolCall, error) {
	indexes := make([]int, 0, len(s.calls))
	for index := range s.calls {
		indexes = append(indexes, index)
	}
	// Gateways can retain upstream output indexes that also count reasoning
	// items. Only declared calls matter; a gap is not an incomplete call.
	sort.Ints(indexes)
	calls := make([]toolCall, 0, len(indexes))
	ids := map[string]bool{}
	for _, index := range indexes {
		call := *s.calls[index]
		if err := validateToolIdentity(call, &index, ids); err != nil {
			return nil, err
		}
		calls = append(calls, call)
	}
	return calls, nil
}

func validateToolIdentity(call toolCall, index *int, ids map[string]bool) error {
	if strings.TrimSpace(call.ID) == "" {
		return toolProtocolError("missing_id", index)
	}
	if ids[call.ID] {
		return toolProtocolError("duplicate_id", index)
	}
	ids[call.ID] = true
	if strings.TrimSpace(call.Function.Name) == "" {
		return toolProtocolError("missing_name", index)
	}
	return nil
}

func toolProtocolError(code string, index *int) *ModelError {
	return &ModelError{Class: "tool_protocol", Code: code, ToolIndex: index}
}
