"""Performance benchmark for large, image-based (scanned) documents.

Builds a synthetic scan (default 200 pages, A4 at 200 dpi greyscale JPEG,
~100 MB) and times the operations a user performs on it through the real
FastAPI app: open, page analysis, render of a page, rotate (incl. the dual
revision validation), delete, undo (revision switch), save-as, close.

Run:  backend/.venv/bin/python tests/perf/bench_large.py [pages]
Results are printed as a table; nothing leaves the machine.
"""
from __future__ import annotations

import io
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

import pymupdf  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

TOKEN = "b" * 48


def make_scan(path: Path, pages: int) -> None:
    w, h = 1654, 2339  # A4 @ 200 dpi
    base = Image.new("L", (w, h), 245)
    d = ImageDraw.Draw(base)
    for y in range(180, h - 180, 46):
        d.rectangle([150, y, w - 150 - (y * 7) % 400, y + 18], fill=40)
    base = base.filter(ImageFilter.GaussianBlur(0.8))
    doc = pymupdf.open()
    noise = Image.effect_noise((w, h), 18)
    for i in range(pages):
        # every page unique (real scans never deduplicate): shifted noise + marks
        img = base.rotate((i % 5 - 2) * 0.3, fillcolor=245)
        img = Image.blend(img, noise.transform((w, h), Image.Transform.AFFINE, (1, 0, i * 7 % 97, 0, 1, i * 13 % 89)), 0.12)
        ImageDraw.Draw(img).text((150, 100), f"Page {i + 1}", fill=0)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=80)
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(path, garbage=0)


def main() -> None:
    pages = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    tmp = Path(tempfile.mkdtemp(prefix="pdfed-bench-"))
    try:
        from core.config import Settings, set_settings

        set_settings(Settings(sessions_root=tmp / "sessions", assets_dir=ROOT / "assets", token=TOKEN, cache_dir=tmp / "cache"))
        from fastapi.testclient import TestClient

        from api.app import create_app

        src = tmp / "scan.pdf"
        t = time.perf_counter()
        make_scan(src, pages)
        print(f"generated {pages}-page scan: {src.stat().st_size / 1e6:.1f} MB in {time.perf_counter() - t:.1f}s")

        rows = []

        def timed(label, fn):
            t0 = time.perf_counter()
            r = fn()
            rows.append((label, time.perf_counter() - t0))
            return r

        with TestClient(create_app(TOKEN), base_url="http://127.0.0.1") as c:
            c.headers.update({"X-PDFEd-Token": TOKEN})

            def post(url, body):
                r = c.post(url, json=body)
                assert r.status_code == 200, r.text
                return r.json().get("data", r.json())

            info = timed("open", lambda: post("/documents/open", {"path": str(src)}))
            doc = info["doc_id"]
            assert info["page_count"] == pages
            timed("page analysis (scanned detection, all pages)", lambda: c.get(f"/documents/{doc}/pages/analysis").raise_for_status())
            wd = pymupdf.open(src)
            timed("render page 100 @150% (MuPDF, thumbnail-equivalent path)", lambda: wd[min(99, pages - 1)].get_pixmap(dpi=108))
            wd.close()
            r1 = timed("rotate 1 page (new revision + dual validation)", lambda: post(f"/documents/{doc}/pages/rotate", {"pages": [0], "angle": 90}))
            timed("delete 10 pages", lambda: post(f"/documents/{doc}/pages/delete", {"pages": list(range(10, 20))}))
            timed("undo (switch revision)", lambda: post(f"/documents/{doc}/revision", {"revision": r1["revision"]}))
            out = tmp / "out.pdf"
            timed("save as (atomic, validated)", lambda: post(f"/documents/{doc}/save", {"target_path": str(out)}))
            timed("close", lambda: post(f"/documents/{doc}/close", {"delete_session": True}))
            assert pymupdf.open(out).page_count == pages

        print(f"\n| Operation ({pages} pages, {src.stat().st_size / 1e6:.0f} MB) | Time |\n|---|---|")
        for label, sec in rows:
            print(f"| {label} | {sec * 1000:.0f} ms |")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
