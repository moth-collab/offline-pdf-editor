"""Merge, split, extract and images-to-PDF."""
from __future__ import annotations

import io
import os
import re
import uuid
from pathlib import Path

import pymupdf as fitz
from PIL import Image

from core.errors import AppError
from services.document_manager import is_pdf_file, validate_pdf

SAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _open_source(path: str, password: str | None) -> fitz.Document:
    p = Path(path)
    if not p.is_file():
        raise AppError("file_not_found", f"File not found: {p.name}")
    if not is_pdf_file(p):
        raise AppError("invalid_pdf", f"{p.name} is not a PDF document")
    doc = fitz.open(str(p))
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            doc.close()
            raise AppError("password_required", f"{p.name} is password protected", status=401,
                           details={"path": str(p)})
    return doc


def merge(items: list[dict], out_path: Path) -> int:
    if not items:
        raise AppError("invalid_request", "Select at least one file to merge")
    out = fitz.open()
    try:
        toc: list = []
        for it in items:
            src = _open_source(it["path"], it.get("password"))
            try:
                pages = it.get("pages")
                start = out.page_count
                if pages:
                    for p in pages:
                        if not 0 <= p < src.page_count:
                            raise AppError("invalid_page", f"Page {p + 1} does not exist in {Path(it['path']).name}")
                        out.insert_pdf(src, from_page=p, to_page=p)
                else:
                    out.insert_pdf(src)
                # bookmark per merged file
                toc.append([1, Path(it["path"]).stem, start + 1])
                for lvl, title, page, *_ in src.get_toc(simple=False) if not pages else []:
                    toc.append([lvl + 1, title, start + page])
            finally:
                src.close()
        try:
            out.set_toc(toc)
        except Exception:
            pass
        out.save(str(out_path), garbage=3, deflate=True)
        n = out.page_count
    finally:
        out.close()
    validate_pdf(out_path, expect_pages=n)
    return n


def _write_subset(doc: fitz.Document, pages: list[int], target: Path) -> None:
    out = fitz.open()
    try:
        for p in pages:
            out.insert_pdf(doc, from_page=p, to_page=p)
        tmp = target.with_name(f".{target.stem}.{uuid.uuid4().hex[:6]}.part.pdf")
        out.save(str(tmp), garbage=3, deflate=True)
    finally:
        out.close()
    validate_pdf(tmp, expect_pages=len(pages))
    os.replace(tmp, target)


def extract(doc: fitz.Document, pages: list[int], target: Path) -> dict:
    if not pages:
        raise AppError("invalid_request", "No pages selected")
    for p in pages:
        if not 0 <= p < doc.page_count:
            raise AppError("invalid_page", f"Page {p + 1} does not exist")
    _write_subset(doc, pages, target)
    return {"path": str(target), "pages": len(pages), "size": target.stat().st_size}


def split(doc: fitz.Document, mode: str, output_dir: Path, base_name: str, *, ranges=None, every=None,
          max_bytes=None, name_pattern: str = "{name}_part{n}") -> list[dict]:
    if not output_dir.is_dir():
        raise AppError("invalid_target", "The output folder does not exist")
    n = doc.page_count
    groups: list[list[int]] = []
    if mode == "ranges":
        for r in ranges or []:
            a, b = int(r[0]), int(r[-1])
            if not (0 <= a <= b < n):
                raise AppError("invalid_request", f"Invalid page range {a + 1}-{b + 1}")
            groups.append(list(range(a, b + 1)))
    elif mode == "every":
        k = max(1, int(every or 1))
        groups = [list(range(i, min(i + k, n))) for i in range(0, n, k)]
    elif mode == "bookmarks":
        starts = sorted({page - 1 for lvl, _t, page, *_ in doc.get_toc(simple=False) if lvl == 1 and page >= 1})
        if not starts:
            raise AppError("no_bookmarks", "The document has no top-level bookmarks to split by")
        if starts[0] != 0:
            starts.insert(0, 0)
        for i, s in enumerate(starts):
            e = starts[i + 1] if i + 1 < len(starts) else n
            groups.append(list(range(s, e)))
    elif mode == "size":
        limit = max(int(max_bytes or 0), 50_000)
        cur: list[int] = []
        for p in range(n):
            cur.append(p)
            if len(cur) > 1 and _estimate_size(doc, cur) > limit:
                cur.pop()
                groups.append(cur)
                cur = [p]
        if cur:
            groups.append(cur)
    else:
        raise AppError("invalid_request", f"Unknown split mode {mode}")
    if not groups:
        raise AppError("invalid_request", "Nothing to split")
    results = []
    width = len(str(len(groups)))
    for i, g in enumerate(groups, start=1):
        name = name_pattern.format(name=base_name, n=str(i).zfill(width), start=g[0] + 1, end=g[-1] + 1)
        name = SAFE_NAME.sub("_", name).strip(" .") or f"part{i}"
        target = output_dir / f"{name}.pdf"
        k = 1
        while target.exists():
            k += 1
            target = output_dir / f"{name} ({k}).pdf"
        _write_subset(doc, g, target)
        results.append({"path": str(target), "pages": [g[0], g[-1]], "size": target.stat().st_size})
    return results


def _estimate_size(doc: fitz.Document, pages: list[int]) -> int:
    out = fitz.open()
    try:
        for p in pages:
            out.insert_pdf(doc, from_page=p, to_page=p)
        return len(out.tobytes(garbage=3, deflate=True))
    finally:
        out.close()


PAGE_SIZES = {"a4": (595.28, 841.89), "letter": (612.0, 792.0)}


def images_to_pdf(paths: list[str], out_path: Path, page_size: str = "image", margin: float = 0) -> int:
    if not paths:
        raise AppError("invalid_request", "Select at least one image")
    out = fitz.open()
    try:
        for path in paths:
            p = Path(path)
            if not p.is_file():
                raise AppError("file_not_found", f"Image not found: {p.name}")
            try:
                im = Image.open(p)
                frames = getattr(im, "n_frames", 1)
            except Exception as exc:
                raise AppError("invalid_image", f"Unsupported image {p.name}: {exc}") from exc
            for fi in range(frames):
                im.seek(fi)
                frame = im.copy()
                dpi = frame.info.get("dpi", (96, 96))
                try:
                    dpi_x = float(dpi[0]) or 96.0
                    dpi_y = float(dpi[1]) or 96.0
                except Exception:
                    dpi_x = dpi_y = 96.0
                if frame.mode not in ("RGB", "L", "RGBA"):
                    frame = frame.convert("RGBA" if "A" in frame.getbands() else "RGB")
                buf = io.BytesIO()
                if frame.mode in ("RGB", "L") and (im.format or "").upper() == "JPEG":
                    frame.save(buf, "JPEG", quality=95)
                else:
                    frame.save(buf, "PNG")
                w_pt = frame.size[0] * 72.0 / dpi_x
                h_pt = frame.size[1] * 72.0 / dpi_y
                if page_size in PAGE_SIZES:
                    pw, ph = PAGE_SIZES[page_size]
                    if w_pt > h_pt:  # landscape image -> landscape page
                        pw, ph = ph, pw
                else:
                    pw, ph = w_pt + 2 * margin, h_pt + 2 * margin
                page = out.new_page(width=pw, height=ph)
                area = fitz.Rect(margin, margin, pw - margin, ph - margin)
                page.insert_image(area, stream=buf.getvalue(), keep_proportion=True)
        out.save(str(out_path), garbage=3, deflate=True)
        n = out.page_count
    finally:
        out.close()
    validate_pdf(out_path, expect_pages=n)
    return n
