"""Installed skill metadata, demand-loaded bodies, and management operations."""
from __future__ import annotations

import os
import json
import re
import shutil
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

from workspace_extensions import EXTENSIONS_ROOT, EXTENSIONS_LOCK, _extension_id, _load_extensions, _save_extensions
from workspace_plugins import extension_allowed
from workspace_runtime import _run_command, _safe_relative, _truncate

def _skill_content(path: Path) -> tuple[dict[str, Any], str, str]:
    import yaml
    content = (path / "SKILL.md").read_text(encoding="utf-8")
    if len(content) > 200_000:
        raise ValueError("SKILL.md exceeds 200,000 characters")
    match = re.match(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", content, re.DOTALL)
    if not match:
        raise ValueError("SKILL.md requires YAML frontmatter with name and description")
    metadata = yaml.safe_load(match.group(1))
    if not isinstance(metadata, dict):
        raise ValueError("skill frontmatter must be an object")
    name, description = metadata.get("name"), metadata.get("description")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
        raise ValueError("skill name must be lowercase kebab-case (max 64 characters)")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        raise ValueError("skill description must be 1-1024 characters")
    return metadata, content, match.group(2).strip()


def _skill_public(skill: dict[str, Any]) -> dict[str, Any]:
    value = {key: skill.get(key) for key in ("id", "name", "description", "version", "source", "path", "ref", "subdir", "enabled", "installed_at", "updated_at", "compatibility")}
    root = Path(skill.get("path", "")) if skill.get("path") else None
    files = []
    if root and root.is_dir():
        for path in sorted(root.rglob("*")):
            if path.is_file() and not any(part.startswith(".") for part in path.relative_to(root).parts):
                try:
                    files.append({"path": str(path.relative_to(root)), "size": path.stat().st_size})
                except OSError:
                    pass
                if len(files) >= 500:
                    break
    value["files"] = files
    return value


def _extract_bundle(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            total = 0
            for item in archive.infolist():
                destination = (target / item.filename).resolve()
                destination.relative_to(target.resolve())
                if (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("skill bundle symlinks are unsupported")
                total += item.file_size
                if total > 100 * 1024 * 1024:
                    raise ValueError("expanded skill bundle exceeds 100 MB")
                if item.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as src, destination.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        return
    with tarfile.open(source) as archive:
        total = 0
        for item in archive:
            destination = (target / item.name).resolve()
            destination.relative_to(target.resolve())
            if item.issym() or item.islnk():
                raise ValueError("skill bundle links are unsupported")
            total += item.size
            if total > 100 * 1024 * 1024:
                raise ValueError("expanded skill bundle exceeds 100 MB")
            if item.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif item.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(item) as src, destination.open("wb") as dst:
                    shutil.copyfileobj(src, dst)


def install_skill(args: dict[str, Any]) -> dict[str, Any]:
    if args.get("id"):
        previous = _load_extensions()["skills"].get(_extension_id(args["id"]), {})
        args = {**{key: previous.get(key) for key in ("source", "ref", "subdir", "enabled") if previous.get(key) is not None}, **args}
    source = args.get("source") or args.get("path") or "inline"
    content = args.get("content")
    EXTENSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="skill-", dir=EXTENSIONS_ROOT) as tmp:
        staged = Path(tmp) / "source"
        version = "local"
        if isinstance(content, str) and content.strip():
            staged.mkdir()
            (staged / "SKILL.md").write_text(content, encoding="utf-8")
            metadata, _, _ = _skill_content(staged)
            existing_id = _extension_id(args.get("id") or metadata["name"])
            existing = _load_extensions()["skills"].get(existing_id, {})
            existing_path = EXTENSIONS_ROOT / "skills" / existing_id
            if existing and existing_path.is_dir():
                # Editing instructions or toggling a bundled skill must retain
                # its scripts, references and assets, not reinstall one file.
                shutil.copytree(existing_path, staged, dirs_exist_ok=True)
                (staged / "SKILL.md").write_text(content, encoding="utf-8")
                source = args.get("source") or args.get("path") or existing.get("source", source)
                version = existing.get("version", version)
        elif isinstance(source, str) and (source.startswith(("https://", "http://", "git@", "ssh://"))):
            command = ["git", "clone", "--depth", "1"]
            if args.get("ref"):
                command.extend(["--branch", str(args["ref"])])
            command.extend(["--", source, str(staged)])
            cloned = _run_command(command, timeout_ms=120_000)
            if cloned.returncode:
                raise ValueError(_truncate(cloned.stderr, 4000)[0] or "git clone failed")
            version = _run_command(["git", "rev-parse", "HEAD"], cwd=staged).stdout.strip()
        elif isinstance(source, str):
            local = _safe_relative(source)
            if local.is_dir():
                shutil.copytree(local, staged, symlinks=False)
            elif local.is_file():
                if local.name.upper() == "SKILL.MD":
                    staged.mkdir()
                    shutil.copyfile(local, staged / "SKILL.md")
                else:
                    _extract_bundle(local, staged)
            else:
                raise ValueError("skill source path does not exist")
        else:
            raise ValueError("provide source (git URL, bundle or directory), or content (SKILL.md)")
        root = staged
        if args.get("subdir") and not (isinstance(content, str) and content.strip()):
            root = (staged / str(args["subdir"])).resolve()
            root.relative_to(staged.resolve())
        if not (root / "SKILL.md").is_file():
            manifests = list(root.rglob("SKILL.md"))[:20]
            if len(manifests) == 1:
                root = manifests[0].parent
            else:
                raise ValueError("source must contain one SKILL.md; use subdir to select a skill")
        metadata, _, _ = _skill_content(root)
        skill_id = _extension_id(args.get("id") or metadata["name"])
        destination = EXTENSIONS_ROOT / "skills" / skill_id
        with EXTENSIONS_LOCK:
            data = _load_extensions()
            existing = data["skills"].get(skill_id, {})
            if destination.exists():
                shutil.rmtree(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(root, destination, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__", ".venv"))
            now = time.time()
            extra_metadata = metadata.get("metadata") if isinstance(metadata.get("metadata"), dict) else {}
            skill = {"id": skill_id, "name": metadata["name"], "description": metadata["description"], "version": extra_metadata.get("version") or version, "source": source, "path": str(destination), "ref": args.get("ref", ""), "subdir": args.get("subdir", ""), "enabled": bool(args.get("enabled", existing.get("enabled", True))), "installed_at": existing.get("installed_at", now), "updated_at": now, "compatibility": metadata.get("compatibility", "")}
            data["skills"][skill_id] = skill
            _save_extensions(data)
        return _skill_public(skill)


def skills_index() -> dict[str, Any]:
    enabled = [(key, skill) for key, skill in sorted(_load_extensions()["skills"].items())
               if skill.get("enabled", True) and extension_allowed("skills", key)]
    values: list[dict[str, Any]] = []
    for key, skill in enabled:
        # Metadata is installed from frontmatter; no instruction/body/file walk
        # is needed merely to make a skill discoverable in this run's prompt.
        item = {"id": key, "name": str(skill.get("name", key))[:64], "description": str(skill.get("description", ""))[:240]}
        candidate = {"skills": values + [item], "total": len(enabled), "truncated": True}
        if len(values) >= 32 or len(json.dumps(candidate, ensure_ascii=True).encode()) > 8 * 1024:
            break
        values.append(item)
    return {"skills": values, "total": len(enabled), "truncated": len(values) < len(enabled)}


def tool_skills_list(_: dict[str, Any]) -> dict[str, Any]:
    return skills_index()


def tool_skills_read(args: dict[str, Any]) -> dict[str, Any]:
    skill_id = _extension_id(args.get("id"))
    skill = _load_extensions()["skills"].get(skill_id)
    if not skill or not skill.get("enabled", True) or not extension_allowed("skills", skill_id):
        raise ValueError("skill is unavailable or disabled")
    _, content, instructions = _skill_content(Path(skill["path"]))
    return {**_skill_public(skill), "content": content, "instructions": instructions}


