"""Create the "Corresponding Source" archive shipped with every build (AGPL-3.0 §6).

    python scripts/make-source-archive.py [output-dir]

Packs everything needed to rebuild the application: the app's own source,
build scripts, tests, documentation, licences, bundled fonts and OCR language
data. Third-party packages (node_modules, the Python runtime and wheels) are
excluded: they are pinned in package-lock.json and backend/requirements.txt
and fetched by the documented build (docs/INSTALL.md).
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDE_DIRS = {"node_modules", ".venv", "build", "release", "dist", "dist-electron", ".git", "__pycache__",
                ".pytest_cache", ".work", "generated"}
EXCLUDE_SUFFIXES = {".pyc", ".log"}


def included(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in EXCLUDE_DIRS for part in rel.parts):
        return False
    return path.is_file() and path.suffix not in EXCLUDE_SUFFIXES


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build" / "source"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*-source.zip"):
        old.unlink()
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    target = out_dir / f"offline-pdf-editor-{version}-source.zip"
    files = sorted(p for p in ROOT.rglob("*") if included(p))
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in files:
            zf.write(p, Path(f"offline-pdf-editor-{version}") / p.relative_to(ROOT))
    for required in ("LICENSE", "package.json", "backend/requirements.txt", "docs/INSTALL.md"):
        if not (ROOT / required).exists():
            raise SystemExit(f"missing {required}")
    print(f"{target} ({len(files)} files, {target.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
