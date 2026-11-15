"""Bounded, disposable text extraction for files_read document previews."""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

from workspace_runtime import MAX_DOCUMENT_XML_BYTES


def extract(path: Path, max_chars: int, max_pages: int) -> dict:
    blocks: list[str] = []
    length = 0
    truncated = False

    def append(text: str) -> bool:
        nonlocal length, truncated
        remaining = max_chars - length
        blocks.append(text[:remaining])
        length += min(len(text), remaining)
        if len(text) > remaining or length >= max_chars:
            truncated = True
            return False
        return True

    extra = {}
    if path.suffix.lower() == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        extra["pages"] = len(reader.pages)
        truncated = len(reader.pages) > max_pages
        for index, page in enumerate(reader.pages[:max_pages]):
            if not append(f"[Page {index + 1}]\n{page.extract_text() or ''}\n\n"):
                break
    else:
        suffix = path.suffix.lower()
        scanned = 0
        with zipfile.ZipFile(path) as archive:
            names = ["word/document.xml"] if suffix == ".docx" else sorted(
                name for name in archive.namelist()
                if (suffix == ".pptx" and re.fullmatch(r"ppt/slides/slide\d+\.xml", name))
                or (suffix == ".xlsx" and (name == "xl/sharedStrings.xml" or re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name))))
            for name in names[:100]:
                size = archive.getinfo(name).file_size
                if scanned + size > MAX_DOCUMENT_XML_BYTES:
                    truncated = True
                    continue
                scanned += size
                with archive.open(name) as source:
                    for _, node in ET.iterparse(source, events=("end",)):
                        keep = True
                        if node.tag.rsplit("}", 1)[-1] in {"t", "v"} and node.text:
                            keep = append(node.text + "\n")
                        node.clear()
                        if not keep:
                            break
                if length >= max_chars:
                    break
            truncated = truncated or len(names) > 100
    return {"content": "".join(blocks), "truncated": truncated, **extra}


def main() -> None:
    # Parsers may expand compressed document streams; keep that work outside the
    # long-lived bridge with concrete CPU, address-space and wall-clock budgets.
    if sys.platform == "linux":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512 << 20, 512 << 20))
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    try:
        path, chars, pages = sys.argv[1:]
        result = extract(Path(path), int(chars), int(pages))
    except Exception:
        result = {"content": "", "truncated": True, "extraction": "Automatic text extraction could not finish within the preview budget; use exec for targeted analysis."}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
