"""Bounded one-shot AT-SPI worker, run by the system Python with distro GI."""
from __future__ import annotations

import contextlib
import json
import signal
import sys
import time
from typing import Any


def _identity(node: Any) -> dict[str, str] | None:
    # AT-SPI object addresses survive traversal reordering but not app restarts.
    # Never issue actionable refs if the toolkit cannot expose that identity.
    path = getattr(node, "path", None)
    app = getattr(node, "app", None)
    bus = getattr(app, "bus_name", None)
    if not isinstance(path, str) or not path or not isinstance(bus, str) or not bus:
        return None
    return {"bus": bus, "path": path}


def _label(node: Any) -> tuple[str, str]:
    return str(node.getRoleName())[:100], str(node.name or "")[:240]


def _state(node: Any, api: Any, state: str) -> bool:
    return bool(node.getState().contains(getattr(api, "STATE_" + state)))


def _bounds(node: Any, api: Any, width: int = 1280, height: int = 800) -> dict[str, int] | None:
    try:
        rect = node.queryComponent().getExtents(api.DESKTOP_COORDS)
        x, y, w, h = int(rect.x), int(rect.y), int(rect.width), int(rect.height)
        if w <= 0 or h <= 0 or x >= width or y >= height or x + w <= 0 or y + h <= 0:
            return None
        left, right = max(0, x), min(width, x + w)
        top, bottom = max(0, y), min(height, y + h)
        return {"x": x, "y": y, "width": w, "height": h,
                "center_x": (left + right) // 2, "center_y": (top + bottom) // 2}
    except Exception:
        return None


def _actions(node: Any) -> list[str]:
    try:
        actions = node.queryAction()
        return [str(actions.getName(i))[:80] for i in range(min(16, actions.nActions))]
    except Exception:
        return []


def _snapshot(api: Any, args: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + 5
    max_nodes, max_depth, max_chars = args["max_nodes"], args["max_depth"], args["max_chars"]
    width, height = args.get("width", 1280), args.get("height", 800)
    desktop = api.Registry.getDesktop(0)
    elements = []
    remaining = max_chars
    visited, truncated = 0, False
    applications = min(desktop.childCount, 80)
    # Stack entries contain an index path plus exact ancestor object addresses.
    stack = []
    apps = []
    for i in range(applications):
        if time.monotonic() >= deadline:
            truncated = True
            break
        with contextlib.suppress(Exception):
            apps.append((i, desktop.getChildAtIndex(i)))
    # Foreground windows must not lose the output budget to older background
    # apps. Probe only top-level states; keep original indices for ref identity.
    priority_deadline = min(deadline, started + 1)
    app_priority, window_priority = {}, {}
    probes = 0

    def priority(node: Any) -> int:
        try:
            state = node.getState()
            return 0 if state.contains(api.STATE_ACTIVE) or state.contains(api.STATE_FOCUSED) else 1
        except Exception:
            return 1

    for index, app in apps:
        if time.monotonic() >= priority_deadline or probes >= 400:
            break
        app_priority[index] = priority(app)
        probes += 1
        with contextlib.suppress(Exception):
            for child_index in range(min(app.childCount, 400)):
                if time.monotonic() >= priority_deadline or probes >= 400:
                    break
                probes += 1
                rank = priority(app.getChildAtIndex(child_index))
                if rank == 0:
                    app_priority[index] = 0
                    window_priority[(index, child_index)] = 0
    for index, app in reversed(sorted(apps, key=lambda item: app_priority.get(item[0], 1))):
        stack.append((app, [index], [], 0))
    if desktop.childCount > applications:
        truncated = True
    while stack:
        if len(elements) >= max_nodes or visited >= 3000 or remaining < 100 or time.monotonic() >= deadline:
            truncated = True
            break
        node, indices, ancestors, depth = stack.pop()
        visited += 1
        try:
            if _state(node, api, "DEFUNCT"):
                continue
            role, name = _label(node)
            identity = _identity(node)
            is_container = depth == 0 or role in {"frame", "window", "dialog", "application"}
            showing = _state(node, api, "SHOWING")
            if not showing and not is_container:
                continue
            bounds = _bounds(node, api, width, height) if showing else None
            actions = _actions(node) if showing else []
            editable, focused = _state(node, api, "EDITABLE"), _state(node, api, "FOCUSED")
            focusable, enabled = _state(node, api, "FOCUSABLE"), _state(node, api, "ENABLED")
            protected = "password" in role.casefold()
            text = ""
            if not protected and showing and role not in {"application", "frame", "window", "dialog"}:
                with contextlib.suppress(Exception):
                    text_iface = node.queryText()
                    text = str(text_iface.getText(0, min(text_iface.characterCount, 600)))
                    if text == name:
                        text = ""
            if showing and (name or text or actions or editable or focusable or is_container):
                cost = len(role) + len(name) + len(text) + 80
                if cost > remaining:
                    text = text[:max(0, remaining - len(role) - len(name) - 80)]
                    cost = len(role) + len(name) + len(text) + 80
                    if cost > remaining:
                        truncated = True
                        break
                item = {"role": role, "name": name, "depth": depth, "enabled": enabled,
                        "focused": focused, "editable": editable, "actions": actions}
                if text:
                    item["text"] = text
                if protected:
                    item["protected"] = True
                if bounds:
                    item["bounds"] = bounds
                if identity and all(ancestors) and bounds and enabled and (actions or editable or focusable or is_container):
                    item["locator"] = {"indices": indices, "identity": identity, "ancestors": ancestors,
                                       "role": role, "name": name}
                elements.append(item)
                remaining -= cost
            if depth >= max_depth:
                if node.childCount:
                    truncated = True
                continue
            children = min(node.childCount, 400)
            if node.childCount > children:
                truncated = True
            # Missing stable ancestors disqualify child refs, not readable text.
            next_ancestors = ancestors + [identity]
            order = range(children)
            if depth == 0:
                order = sorted(order, key=lambda i: window_priority.get((indices[0], i), 1))
            for i in reversed(order):
                if time.monotonic() >= deadline:
                    truncated = True
                    break
                with contextlib.suppress(Exception):
                    stack.append((node.getChildAtIndex(i), indices + [i], next_ancestors, depth + 1))
        except Exception:
            continue
    return {"available": True, "elements": elements, "truncated": truncated, "visited": visited,
            "duration_ms": round((time.monotonic() - started) * 1000), "ref_lifetime_seconds": 180,
            "note": "Observe again after UI changes. Protected field contents are omitted."}


def _resolve(api: Any, locator: dict[str, Any]) -> Any:
    indices = locator.get("indices")
    if (not isinstance(indices, list) or not 1 <= len(indices) <= 18
            or any(isinstance(i, bool) or not isinstance(i, int) or i < 0 for i in indices)):
        raise ValueError("invalid desktop ref locator")
    node = api.Registry.getDesktop(0)
    expected_ancestors = locator.get("ancestors", [])
    for depth, index in enumerate(indices):
        if depth:
            previous = _identity(node)
            if depth - 1 >= len(expected_ancestors) or previous is None or previous != expected_ancestors[depth - 1]:
                raise ValueError("desktop element ancestry changed; observe again")
        if index >= node.childCount:
            raise ValueError("desktop element disappeared; observe again")
        node = node.getChildAtIndex(index)
        if node is None:
            raise ValueError("desktop element disappeared; observe again")
    role, name = _label(node)
    identity = _identity(node)
    if identity is None or identity != locator.get("identity") or role != locator.get("role") or name != locator.get("name"):
        raise ValueError("desktop element changed; observe again")
    if _state(node, api, "DEFUNCT") or not _state(node, api, "SHOWING") or not _state(node, api, "ENABLED"):
        raise ValueError("desktop element is no longer visible and enabled; observe again")
    return node


def _fallback(node: Any, api: Any) -> dict[str, int]:
    bounds = _bounds(node, api)
    if bounds is None:
        raise ValueError("desktop element has no visible bounds; use a fresh screenshot")
    return {"x": bounds["center_x"], "y": bounds["center_y"]}


def _act(api: Any, args: dict[str, Any]) -> dict[str, Any]:
    node = _resolve(api, args["locator"])
    action = args["action"]
    if action == "point":
        return {"acted": False, "fallback": _fallback(node, api)}
    if action == "click":
        with contextlib.suppress(NotImplementedError, AttributeError):
            iface = node.queryAction()
            for i in range(min(16, iface.nActions)):
                if str(iface.getName(i)).casefold() in {"click", "press", "activate", "toggle", "open"}:
                    if iface.doAction(i):
                        return {"acted": True}
                    raise ValueError("desktop accessibility click failed; observe again")
        return {"acted": False, "fallback": _fallback(node, api)}
    if action not in {"type", "fill"}:
        raise ValueError("unsupported desktop accessibility action")
    text = args.get("text")
    if not isinstance(text, str) or len(text) > 20_000 or "\x00" in text:
        raise ValueError("invalid desktop text")
    if not _state(node, api, "EDITABLE"):
        raise ValueError("desktop element is not editable; use a fresh snapshot")
    focused = False
    with contextlib.suppress(Exception):
        focused = bool(node.queryComponent().grabFocus())
    try:
        editable = node.queryEditableText()
    except NotImplementedError:
        return {"acted": False, "focused": focused, "fallback": _fallback(node, api)}
    if action == "fill":
        if not editable.setTextContents(text):
            raise ValueError("desktop accessibility fill failed; observe again")
        with contextlib.suppress(Exception):
            node.queryText().setCaretOffset(len(text))
    else:
        current = node.queryText()
        offset = current.caretOffset
        if offset < 0:
            offset = current.characterCount
        # InsertText's length is UTF-8 bytes; caret offsets remain characters.
        if not editable.insertText(offset, text, len(text.encode("utf-8"))):
            raise ValueError("desktop accessibility type failed; observe again")
        with contextlib.suppress(Exception):
            current.setCaretOffset(offset + len(text))
    return {"acted": True, "focused": focused}


def handle(args: dict[str, Any], api: Any) -> dict[str, Any]:
    return _snapshot(api, args) if args.get("action") == "snapshot" else _act(api, args)


def main() -> None:
    signal.alarm(9)
    args = json.loads(sys.stdin.read(200_000))
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        import pyatspi
        Atspi.set_timeout(500, 2000)
        value = handle(args, pyatspi)
    except ImportError:
        value = {"available": False, "elements": [], "error": "AT-SPI is unavailable; use desktop screenshot coordinates"}
    except Exception as exc:
        value = {"available": False, "elements": [], "error": str(exc)[:1000] or "desktop accessibility is unavailable"}
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
