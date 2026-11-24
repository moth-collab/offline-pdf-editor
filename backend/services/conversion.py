"""Local conversion engines (no cloud services).

* PDF → Word: pdf2docx (layout analysis: paragraphs, tables, images).
* PDF → Excel: table detection (PyMuPDF find_tables); pages without tables
  export their text lines split into columns.
* PDF → PowerPoint: one slide per page, either as a picture (exact look) or
  with editable text boxes over a text-free background image.
* PDF → PNG/JPEG, text extraction, image extraction.
Layout limitations are reported back to the UI.
"""
from __future__ import annotations

import io
import os
import re
import uuid
from pathlib import Path

import pymupdf as fitz
from PIL import Image

from core.errors import AppError

SAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _pages(doc: fitz.Document, pages) -> list[int]:
    if not pages:
        return list(range(doc.page_count))
    out = [int(p) for p in pages if 0 <= int(p) < doc.page_count]
    if not out:
        raise AppError("invalid_request", "No valid pages selected")
    return out


def _atomic(target: Path, write) -> None:
    tmp = target.with_name(f".{target.stem}.{uuid.uuid4().hex[:6]}.part{target.suffix}")
    try:
        write(tmp)
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)


def to_docx(src: str, target: Path, pages: list[int], report, cancelled) -> dict:
    from pdf2docx import Converter

    report(0.05, "Analysing layout…")
    cv = Converter(src)
    try:
        _atomic(target, lambda tmp: cv.convert(str(tmp), pages=pages))
    finally:
        cv.close()
    return {"path": str(target), "notes": "Complex layouts (multi-column text, floating graphics, form fields) may need manual adjustments in Word."}


def _lines_to_rows(page: fitz.Page) -> list[list[str]]:
    rows = []
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            cells: list[str] = []
            last_x1 = None
            for sp in ln["spans"]:
                t = sp["text"]
                if not t.strip():
                    continue
                if last_x1 is not None and sp["bbox"][0] - last_x1 > sp["size"] * 1.5:
                    cells.append(t.strip())
                elif cells:
                    cells[-1] += t
                else:
                    cells.append(t.strip())
                last_x1 = sp["bbox"][2]
            if cells:
                rows.append(cells)
    return rows


def to_xlsx(src: str, target: Path, pages: list[int], report, cancelled) -> dict:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    doc = fitz.open(src)
    wb = Workbook()
    wb.remove(wb.active)
    tables_found = 0
    for n, pno in enumerate(pages):
        if cancelled():
            break
        report(n / max(1, len(pages)), f"Page {pno + 1}")
        page = doc[pno]
        try:
            tabs = page.find_tables().tables
        except Exception:
            tabs = []
        if tabs:
            for ti, tab in enumerate(tabs, start=1):
                ws = wb.create_sheet(f"P{pno + 1} T{ti}"[:31])
                for row in tab.extract():
                    ws.append([("" if c is None else str(c)) for c in row])
                if ws.max_row:
                    for c in ws[1]:
                        c.font = Font(bold=True)
                tables_found += 1
        else:
            ws = wb.create_sheet(f"P{pno + 1} text"[:31])
            for row in _lines_to_rows(page):
                ws.append(row)
    if not wb.sheetnames:
        wb.create_sheet("Empty")
    for ws in wb.worksheets:
        for col in ws.columns:
            width = max((len(str(c.value or "")) for c in col), default=8)
            ws.column_dimensions[col[0].column_letter].width = min(60, max(8, width + 2))
    _atomic(target, lambda tmp: wb.save(str(tmp)))
    return {"path": str(target), "tables": tables_found,
            "notes": "Tables are detected automatically; pages without tables are exported as text rows."}


def to_pptx(src: str, target: Path, pages: list[int], report, cancelled, editable: bool = True, dpi: int = 150) -> dict:
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.util import Emu, Pt

    doc = fitz.open(src)
    prs = Presentation()
    first = doc[pages[0]]
    w_pt, h_pt = first.rect.width, first.rect.height
    if first.rotation in (90, 270):
        w_pt, h_pt = h_pt, w_pt
    prs.slide_width = Emu(int(w_pt * 12700))
    prs.slide_height = Emu(int(h_pt * 12700))
    blank = prs.slide_layouts[6]
    for n, pno in enumerate(pages):
        if cancelled():
            break
        report(n / max(1, len(pages)), f"Slide {n + 1}")
        page = doc[pno]
        slide = prs.slides.add_slide(blank)
        if editable:
            tmp = fitz.open()
            tmp.insert_pdf(doc, from_page=pno, to_page=pno)
            tp = tmp[0]
            for b in tp.get_text("dict")["blocks"]:
                if b.get("type") == 0:
                    tp.add_redact_annot(fitz.Rect(b["bbox"]), fill=False)
            tp.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                text=fitz.PDF_REDACT_TEXT_REMOVE)
            pix = tp.get_pixmap(dpi=dpi)
        else:
            pix = page.get_pixmap(dpi=dpi)
        img = io.BytesIO(pix.tobytes("png"))
        slide.shapes.add_picture(img, 0, 0, prs.slide_width, prs.slide_height)
        if editable:
            sx = prs.slide_width / page.rect.width
            sy = prs.slide_height / page.rect.height
            for b in page.get_text("dict")["blocks"]:
                if b.get("type") != 0:
                    continue
                x0, y0, x1, y1 = b["bbox"]
                box = slide.shapes.add_textbox(Emu(int(x0 * sx)), Emu(int(y0 * sy)), Emu(int((x1 - x0) * sx) + 12700 * 4),
                                               Emu(int((y1 - y0) * sy)))
                tf = box.text_frame
                tf.word_wrap = True
                for k in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
                    setattr(tf, k, 0)
                for li, ln in enumerate(b["lines"]):
                    para = tf.paragraphs[0] if li == 0 else tf.add_paragraph()
                    for sp in ln["spans"]:
                        if not sp["text"]:
                            continue
                        run = para.add_run()
                        run.text = sp["text"]
                        run.font.size = Pt(max(1, sp["size"]))
                        run.font.bold = bool(sp["flags"] & 16)
                        run.font.italic = bool(sp["flags"] & 2)
                        c = sp["color"]
                        run.font.color.rgb = RGBColor((c >> 16) & 255, (c >> 8) & 255, c & 255)
        slide.notes_slide.notes_text_frame.text = page.get_text()[:5000]
    _atomic(target, lambda tmp: prs.save(str(tmp)))
    return {"path": str(target), "notes": "Each page becomes a slide. With editable text, fonts are substituted by PowerPoint where not installed."}


def to_images(src: str, out_dir: Path, pages: list[int], report, cancelled, fmt: str = "png", dpi: int = 150,
              quality: int = 90, base: str = "page") -> dict:
    doc = fitz.open(src)
    files = []
    width = len(str(max(pages) + 1))
    for n, pno in enumerate(pages):
        if cancelled():
            break
        report(n / max(1, len(pages)), f"Page {pno + 1}")
        pix = doc[pno].get_pixmap(dpi=dpi, alpha=False)
        name = f"{base}_{str(pno + 1).zfill(width)}.{'jpg' if fmt == 'jpg' else 'png'}"
        target = out_dir / name
        if fmt == "jpg":
            im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            _atomic(target, lambda tmp: im.save(str(tmp), "JPEG", quality=quality, dpi=(dpi, dpi)))
        else:
            _atomic(target, lambda tmp: pix.save(str(tmp)))
        files.append(str(target))
    return {"files": files, "dir": str(out_dir)}


def to_text(src: str, target: Path, pages: list[int], report, cancelled) -> dict:
    doc = fitz.open(src)
    parts = []
    for n, pno in enumerate(pages):
        report(n / max(1, len(pages)), f"Page {pno + 1}")
        parts.append(f"===== Page {pno + 1} =====\n" + doc[pno].get_text("text", sort=True))
    _atomic(target, lambda tmp: tmp.write_text("\n".join(parts), encoding="utf-8"))
    return {"path": str(target), "characters": sum(len(p) for p in parts)}


def extract_images(src: str, out_dir: Path, pages: list[int], report, cancelled, base: str = "image") -> dict:
    doc = fitz.open(src)
    seen: set[int] = set()
    files = []
    for n, pno in enumerate(pages):
        report(n / max(1, len(pages)), f"Page {pno + 1}")
        for img in doc.get_page_images(pno, full=True):
            xref = img[0]
            if xref in seen:
                continue
            seen.add(xref)
            try:
                info = doc.extract_image(xref)
            except Exception:
                continue
            if not info or info.get("width", 0) < 8 or info.get("height", 0) < 8:
                continue
            ext = info.get("ext", "png")
            data = info["image"]
            if info.get("smask") or ext not in ("png", "jpeg", "jpg", "jp2", "jpx"):
                pix = fitz.Pixmap(doc, xref)
                if pix.colorspace and pix.colorspace.n not in (1, 3):
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                if info.get("smask"):
                    if pix.alpha:
                        pix = fitz.Pixmap(pix, 0)
                    pix = fitz.Pixmap(pix, fitz.Pixmap(doc, info["smask"]))
                data, ext = pix.tobytes("png"), "png"
            target = out_dir / f"{base}_p{pno + 1}_{xref}.{ 'jpg' if ext == 'jpeg' else ext}"
            _atomic(target, lambda tmp, d=data: tmp.write_bytes(d))
            files.append(str(target))
    return {"files": files, "dir": str(out_dir), "count": len(files)}


def run_convert_job(params: dict, job_dir: Path, report, cancelled) -> dict:
    mode = params.get("mode")
    src = params["source_path"]
    doc = fitz.open(src)
    pages = _pages(doc, params.get("pages"))
    doc.close()
    base = SAFE.sub("_", Path(params.get("display_name") or "document").stem)[:80] or "document"
    if mode in ("docx", "xlsx", "pptx", "text"):
        target = Path(params["output_path"])
        if not target.parent.is_dir():
            raise AppError("invalid_target", "The destination folder does not exist")
        if mode == "docx":
            res = to_docx(src, target, pages, report, cancelled)
        elif mode == "xlsx":
            res = to_xlsx(src, target, pages, report, cancelled)
        elif mode == "pptx":
            res = to_pptx(src, target, pages, report, cancelled, editable=bool(params.get("editable", True)),
                          dpi=int(params.get("dpi") or 150))
        else:
            res = to_text(src, target, pages, report, cancelled)
    elif mode in ("png", "jpg", "images"):
        out_dir = Path(params["output_dir"])
        if not out_dir.is_dir():
            raise AppError("invalid_target", "The output folder does not exist")
        fmt = "jpg" if mode == "jpg" or params.get("format") == "jpg" else "png"
        dpi = max(36, min(int(params.get("dpi") or 150), 600))
        res = to_images(src, out_dir, pages, report, cancelled, fmt, dpi, int(params.get("quality") or 90), base)
    elif mode == "extract-images":
        out_dir = Path(params["output_dir"])
        if not out_dir.is_dir():
            raise AppError("invalid_target", "The output folder does not exist")
        res = extract_images(src, out_dir, pages, report, cancelled, base)
    else:
        raise AppError("invalid_request", f"Unknown conversion {mode}")
    report(1.0, "Done")
    return res
