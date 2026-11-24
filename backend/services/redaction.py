"""True redaction.

Redaction is never a black rectangle drawn over content. Applying redactions:

1. records the text located under every redaction mark,
2. removes the underlying text glyphs, image pixels (or whole images) and
   vector graphics inside the marked areas (MuPDF redaction),
3. optionally sanitises metadata, XMP, attachments, JavaScript, hidden text,
4. writes a fully rewritten file (garbage collection, no incremental history,
   so removed objects are physically dropped),
5. verifies with text extraction that nothing of the removed text can be
   recovered from the marked areas or anywhere it was the only occurrence.
"""
from __future__ import annotations

import re
import unicodedata

import pymupdf as fitz

from core.coords import PageCoords
from core.errors import AppError

PATTERNS = {
    "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "phone": r"(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}",
    "thai_id": r"\b\d[\s-]?\d{4}[\s-]?\d{5}[\s-]?\d{2}[\s-]?\d\b",
    "credit_card": r"\b(?:\d[ -]?){13,16}\b",
    "date": r"\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b",
}

IMAGES = {"pixels": fitz.PDF_REDACT_IMAGE_PIXELS, "remove": fitz.PDF_REDACT_IMAGE_REMOVE, "none": fitz.PDF_REDACT_IMAGE_NONE}
GRAPHICS = {"touched": fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED, "covered": fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
            "none": fitz.PDF_REDACT_LINE_ART_NONE}


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", s))


def search(doc: fitz.Document, query: str | None, pattern: str | None, case_sensitive: bool = False) -> list[dict]:
    """Find text to redact. Returns PDF-space rectangles per match."""
    out = []
    regex = None
    if pattern:
        if pattern not in PATTERNS:
            raise AppError("invalid_request", "Unknown pattern")
        regex = re.compile(PATTERNS[pattern])
    elif not query or not query.strip():
        raise AppError("invalid_request", "Enter text to search for")
    for page in doc:
        coords = PageCoords.for_page(page)
        needles: list[str] = []
        if regex:
            text = page.get_text()
            needles = sorted({m.group(0).strip() for m in regex.finditer(text) if len(m.group(0).strip()) >= 4})
        else:
            needles = [query.strip()]
        for needle in needles:
            for q in page.search_for(needle, quads=True):
                r = q.rect
                if case_sensitive and needle not in (page.get_textbox(r + (-1, -1, 1, 1)) or ""):
                    continue
                out.append({"page": page.number, "rect": coords.rect_to_pdf(r), "text": needle})
    return out


def mark(doc: fitz.Document, items: list[dict]) -> int:
    n = 0
    for it in items:
        page = doc[int(it["page"])]
        coords = PageCoords.for_page(page)
        r = coords.rect_to_mupdf(it["rect"]) + (-0.5, -0.5, 0.5, 0.5)
        a = page.add_redact_annot(r, fill=(0, 0, 0), cross_out=True)
        a.set_colors(stroke=(0.9, 0.1, 0.1))
        a.update()
        n += 1
    return n


def pending(doc: fitz.Document) -> list[dict]:
    out = []
    for page in doc:
        coords = PageCoords.for_page(page)
        for a in page.annots(types=[fitz.PDF_ANNOT_REDACT]):
            out.append({"page": page.number, "xref": a.xref, "rect": coords.rect_to_pdf(a.rect),
                        "text": page.get_textbox(a.rect).strip()})
    return out


def apply(doc: fitz.Document, images: str = "pixels", graphics: str = "covered", fill: bool = True,
          sanitize: dict | None = None) -> dict:
    marks = pending(doc)
    if not marks:
        raise AppError("nothing_to_redact", "There are no redaction marks. Mark areas or search for text first.")
    removed_texts = [m["text"] for m in marks if m["text"]]
    pages = sorted({m["page"] for m in marks})
    rects = {p: [fitz.Rect(PageCoords.for_page(doc[p]).rect_to_mupdf(m["rect"])) for m in marks if m["page"] == p]
             for p in pages}
    for p in pages:
        page = doc[p]
        if not fill:
            for a in page.annots(types=[fitz.PDF_ANNOT_REDACT]):
                a.set_colors(fill=None)
                a.update()
        page.apply_redactions(images=IMAGES.get(images, fitz.PDF_REDACT_IMAGE_PIXELS),
                              graphics=GRAPHICS.get(graphics, fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED),
                              text=fitz.PDF_REDACT_TEXT_REMOVE)
    sanitized = []
    if sanitize:
        opts = dict(attached_files=bool(sanitize.get("attachments")), embedded_files=bool(sanitize.get("attachments")),
                    clean_pages=False, hidden_text=bool(sanitize.get("hidden_text")),
                    javascript=bool(sanitize.get("javascript")), metadata=bool(sanitize.get("metadata")),
                    redactions=False, redact_images=0, remove_links=bool(sanitize.get("links")),
                    reset_fields=False, reset_responses=bool(sanitize.get("comments_replies")),
                    thumbnails=True, xml_metadata=bool(sanitize.get("metadata")))
        doc.scrub(**opts)
        sanitized = [k for k, v in sanitize.items() if v]
    # verification: nothing extractable remains inside marked areas
    residual = []
    for p, rs in rects.items():
        page = doc[p]
        for r in rs:
            inner = r + (1, 1, -1, -1) if r.width > 3 and r.height > 3 else r
            t = page.get_textbox(inner).strip()
            if t:
                residual.append({"page": p, "text": t[:80]})
    full = _norm("".join(pg.get_text() for pg in doc))
    still = [t for t in removed_texts if len(_norm(t)) >= 3 and _norm(t) in full]
    return {
        "redacted_areas": len(marks),
        "pages": pages,
        "verified": not residual,
        "residual": residual,
        "occurs_elsewhere": still[:20],
        "sanitized": sanitized,
    }


def sanitize(doc: fitz.Document, opts: dict) -> list[str]:
    doc.scrub(attached_files=bool(opts.get("attachments")), embedded_files=bool(opts.get("attachments")),
              clean_pages=False, hidden_text=bool(opts.get("hidden_text")), javascript=bool(opts.get("javascript")),
              metadata=bool(opts.get("metadata")), redactions=False, redact_images=0,
              remove_links=bool(opts.get("links")), reset_fields=False, reset_responses=False, thumbnails=True,
              xml_metadata=bool(opts.get("metadata")))
    return [k for k, v in opts.items() if v]
