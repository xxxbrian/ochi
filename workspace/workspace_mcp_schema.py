"""Validate external schemas without restricting them to Ochi's intrinsic subset."""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from workspace_schema import ToolArgumentError


@lru_cache(maxsize=128)
def _validator(encoded: str):
    from jsonschema import Draft202012Validator, validators
    from jsonschema.exceptions import SchemaError
    from referencing import Registry
    from referencing.exceptions import NoSuchResource

    schema = json.loads(encoded)
    if not isinstance(schema, dict):
        raise ToolArgumentError("invalid_schema", "$", "MCP input schema must be an object")
    validator = validators.validator_for(schema, default=None) if "$schema" in schema else Draft202012Validator
    if validator is None:
        raise ToolArgumentError("unsupported_schema", "$", "unknown JSON Schema dialect")
    try:
        validator.check_schema(schema)
    except SchemaError as exc:
        raise ToolArgumentError("invalid_schema", "$", str(exc.message)[:500]) from None

    def unavailable(uri: str):
        # References must be bundled in this schema. Validation never performs
        # network requests or reads arbitrary local files to resolve a schema.
        raise NoSuchResource(ref=uri)

    return validator(schema, registry=Registry(retrieve=unavailable))


def validate_mcp_schema(schema: Any) -> None:
    _validator(json.dumps(schema, sort_keys=True, separators=(",", ":")))


def validate_mcp_arguments(name: str, schema: Any, arguments: dict[str, Any]) -> None:
    if not isinstance(arguments, dict):
        raise ToolArgumentError("invalid_arguments", "$", "tool arguments must be an object", name)
    validator = _validator(json.dumps(schema, sort_keys=True, separators=(",", ":")))
    try:
        error = next(validator.iter_errors(arguments), None)
    except Exception as exc:
        raise ToolArgumentError("invalid_schema", "$", "schema reference cannot be resolved", name) from exc
    if error is not None:
        path = "$" + "".join(f"[{item}]" if isinstance(item, int) else "." + str(item) for item in error.absolute_path)
        raise ToolArgumentError("invalid_arguments", path, str(error.message)[:500], name)
