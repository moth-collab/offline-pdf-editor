"""Local OCR (Tesseract) with review and searchable-PDF generation.

* Recognition runs as a background job: each page is rendered locally at the
  chosen resolution and passed to the bundled Tesseract binary (Thai and
  English language data are bundled). Nothing leaves the computer.
* Results (lines, words, confidence, boxes in PDF space) are stored in the
  job folder so the user can review and correct them before accepting.
* Accepting writes an invisible, correctly encoded text layer (render mode 3)
  over the original page; the scan image is never modified.
"""
from __future__ import annotations

import csv
import io
import json
import subprocess
import sys
from pathlib import Path

import pymupdf as fitz

from core.config import get_settings
from core.coords import PageCoords
from core.errors import AppError

LANG_OK = {"tha", "eng", "tha+eng", "eng+tha", "osd"}


def _run(args: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, creationflags=flags)


def status() -> dict:
    cmd, tessdata = get_settings().resolve_tesseract()
    if not cmd:
        return {"available": False, "languages": [], "version": None}
    try:
        ver = _run([cmd, "--version"], 20).stdout.splitlines()[0].replace("tesseract", "").strip()
        args = [cmd, "--list-langs"] + (["--tessdata-dir", str(tessdata)] if tessdata else [])
        out = _run(args, 20).stdout.splitlines()
        langs = [ln.strip() for ln in out[1:] if ln.strip() and ln.strip() != "osd"]
        return {"available": True, "languages": langs, "version": ver, "bundled": bool(tessdata)}
    except Exception as exc:  # pragma: no cover - environment dependent
        return {"available": False, "languages": [], "version": None, "error": str(exc)}


def _tesseract(img: Path, lang: str, dpi: int, psm: int = 3) -> list[dict]:
    cmd, tessdata = get_settings().resolve_tesseract()
    if not cmd:
        raise AppError("ocr_unavailable", "The OCR engine is not installed")
    # TSV goes to a UTF-8 file next to the image: console pipes and code pages
    # differ between platforms, files do not
    out_base = img.with_suffix("")
    args = [cmd, str(img), str(out_base), "-l", lang, "--dpi", str(dpi), "--psm", str(psm)]
    if tessdata:
        args[1:1] = ["--tessdata-dir", str(tessdata)]
    # set the TSV output variable directly (bundled tessdata has no configs folder)
    args += ["-c", "preserve_interword_spaces=1", "-c", "tessedit_create_tsv=1", "-c", "tessedit_create_txt=0"]
    tsv = out_base.with_suffix(".tsv")
    try:
        proc = _run(args)
        if proc.returncode != 0:
            raise AppError("ocr_failed", f"OCR failed: {proc.stderr.strip()[:300]}")
        if not tsv.exists():
            raise AppError("ocr_failed", f"OCR produced no result: {proc.stderr.strip()[:300]}")
        data = tsv.read_text(encoding="utf-8", errors="replace")
    finally:
        tsv.unlink(missing_ok=True)
    rows = list(csv.DictReader(io.StringIO(data), delimiter="\t", quoting=csv.QUOTE_NONE))
    return [r for r in rows if r.get("level") == "5" and (r.get("text") or "").strip()]


def recognize_page(page: fitz.Page, lang: str, dpi: int, work: Path) -> dict:
    """OCR one page; returns lines with words in PDF coordinates."""
    rot = page.rotation
    if rot:
        page.set_rotation(0)  # recognise the unrotated page so boxes map directly
    try:
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
    finally:
        if rot:
            page.set_rotation(rot)
    img = work / f"page-{page.number:05d}.png"
    pix.save(str(img))
    try:
        words = _tesseract(img, lang, dpi)
    finally:
        img.unlink(missing_ok=True)
    coords = PageCoords.for_page(page)
    k = 72.0 / dpi
    lines: dict[tuple, dict] = {}
    for w in words:
        left, top, width, height = (float(w[x]) for x in ("left", "top", "width", "height"))
        r = fitz.Rect(left * k, top * k, (left + width) * k, (top + height) * k)
        key = (w["block_num"], w["par_num"], w["line_num"])
        conf = float(w.get("conf") or 0)
        word = {"text": w["text"], "conf": round(conf, 1), "bbox": coords.rect_to_pdf(r), "_r": r}
        lines.setdefault(key, {"words": []})["words"].append(word)
    out_lines = []
    for key in sorted(lines):
        ws = lines[key]["words"]
        ws.sort(key=lambda x: x["_r"].x0)
        text = ""
        for i, w in enumerate(ws):
            if i:
                prev = ws[i - 1]["_r"]
                gap = w["_r"].x0 - prev.x1
                # Tesseract splits Thai into fragments; only real gaps become spaces
                if gap > 0.25 * max(prev.height, w["_r"].height):
                    text += " "
            text += w["text"]
        box = fitz.Rect(ws[0]["_r"])
        for w in ws[1:]:
            box |= w["_r"]
        confs = [w["conf"] for w in ws if w["conf"] >= 0]
        out_lines.append({
            "id": f"{page.number}-{len(out_lines)}",
            "text": text,
            "conf": round(sum(confs) / len(confs), 1) if confs else 0,
            "bbox": coords.rect_to_pdf(box),
            "words": [{k2: v for k2, v in w.items() if k2 != "_r"} for w in ws],
        })
    all_conf = [ln["conf"] for ln in out_lines]
    return {
        "index": page.number,
        "lines": out_lines,
        "mean_conf": round(sum(all_conf) / len(all_conf), 1) if all_conf else 0,
        "text": "\n".join(ln["text"] for ln in out_lines),
    }


def run_ocr_job(params: dict, job_dir: Path, report, cancelled) -> dict:
    lang = str(params.get("language") or "tha+eng")
    if lang not in LANG_OK:
        raise AppError("invalid_request", f"Unsupported OCR language {lang}")
    dpi = int(params.get("dpi") or 300)
    dpi = max(150, min(dpi, 600))
    doc = fitz.open(params["source_path"])
    pages = params.get("pages") or list(range(doc.page_count))
    pages = [p for p in pages if 0 <= int(p) < doc.page_count]
    results = []
    for n, pno in enumerate(pages):
        if cancelled():
            break
        report(n / max(1, len(pages)), f"Recognising page {pno + 1} ({n + 1} of {len(pages)})")
        results.append(recognize_page(doc[int(pno)], lang, dpi, job_dir))
    report(1.0, "Done")
    (job_dir / "ocr.json").write_text(json.dumps({"language": lang, "dpi": dpi, "pages": results}), encoding="utf-8")
    return {"pages": [{"index": r["index"], "lines": r["lines"], "mean_conf": r["mean_conf"], "text": r["text"]} for r in results],
            "language": lang, "dpi": dpi}


def apply_text_layer(src: Path, dst: Path, pages: list[dict]) -> int:
    """Write invisible, searchable OCR text over the given pages."""
    import pikepdf

    from services.fonts import font_index
    from services.pdf_writer import WriterSession, mat_mul, mat_translate
    from services.text_layout import TextStyle, layout_line, LayoutResult, load_face

    face = font_index.find("Sarabun") or font_index.for_script("thai") or font_index.for_script("latin")
    if face is None:
        raise AppError("font_missing", "No font available for the OCR text layer")
    font = load_face(face)
    written = 0
    with pikepdf.open(str(src)) as pdf:
        ws = WriterSession(pdf)
        for pg in pages:
            idx = int(pg["index"])
            if not 0 <= idx < len(pdf.pages):
                continue
            w = ws.page(idx)
            for ln in pg.get("lines", []):
                text = str(ln.get("text") or "").strip()
                if not text:
                    continue
                x0, y0, x1, y1 = [float(v) for v in ln["bbox"]]
                height = max(1.0, y1 - y0)
                size = height * 0.85
                style = TextStyle(font=font, size=size, invisible=True)
                line = layout_line(text, style)
                if line.width <= 0:
                    continue
                sx = (x1 - x0) / line.width
                line.baseline = 0
                lay = LayoutResult([line], line.width, size, [], [])
                baseline_y = y0 + height * 0.2  # approximate descent
                m = mat_mul((sx, 0, 0, 1, 0, 0), mat_translate(x0, baseline_y))
                w.text_layout(lay, style, m)
                written += 1
        ws.commit()
        pdf.save(str(dst))
    return written
