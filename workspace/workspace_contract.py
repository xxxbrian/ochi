"""Image contract copied from the server's single source at build time."""
from __future__ import annotations

import json
import hashlib
from pathlib import Path

_path = Path(__file__).with_name("contract.json")
if not _path.is_file():
    _path = Path(__file__).resolve().parents[1] / "server/internal/workspace/contract.json"
CONTRACT = json.loads(_path.read_text(encoding="utf-8"))
CONTRACT["contract_sha256"] = hashlib.sha256(_path.read_bytes()).hexdigest()
