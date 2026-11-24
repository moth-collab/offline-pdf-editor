"""Text object extraction for the Direct Text Editor.

Produces editable text objects (blocks -> lines -> spans) with geometry in PDF
user space, style information (font, size, colour, bold/italic), the font's
embedding status and per-character boxes (kept server side for removal).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import pymupdf as fitz

from core.coords import PageCoords
from services.fonts import analyze_page_fonts, norm, split_pdf_font_name

RAW_FLAGS = fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_PRESERVE_LIGATURES | fitz.TEXT_MEDIABOX_CLIP


@dataclass
class Char:
    c: str
    bbox: fitz.Rect  # mupdf space
    origin: fitz.Point


@dataclass
class Span:
    text: str
    font: str
    size: float
    color: int
    flags: int
    bbox: fitz.Rect
    origin: fitz.Point
    ascender: float
    descender: float
    chars: list[Char] = field(default_factory=list)
    font_xref: int | None = None


@dataclass
class Line:
    id: str
    spans: list[Span]
    bbox: fitz.Rect
    dir: tuple[float, float]

    @property
    def text(self) -> str:
        return "".join(s.text for s in self.spans)

    @property
    def chars(self) -> list[Char]:
        return [c for s in self.spans for c in s.chars]

    @property
    def main_span(self) -> Span:
        return max(self.spans, key=lambda s: len(s.text.strip()) or 0.1)

    @property
    def angle(self) -> float:
        """Clockwise rotation of the baseline as seen on the unrotated page."""
        return math.degrees(math.atan2(self.dir[1], self.dir[0]))


@dataclass
class Block:
    id: str
    lines: list[Line]
    bbox: fitz.Rect


def color_hex(c: int) -> str:
    return f"#{(c >> 16) & 255:02x}{(c >> 8) & 255:02x}{c & 255:02x}"


def extract_lines(page: fitz.Page) -> list[Block]:
    raw = page.get_text("rawdict", flags=RAW_FLAGS)
    fonts = analyze_page_fonts(page.parent, page)
    # exact (normalised) names win over family-level matches
    exact: dict[str, int] = {}
    family: dict[str, int] = {}
    for f in fonts:
        exact.setdefault(norm(f["name"]), f["xref"])
        family.setdefault(norm(split_pdf_font_name(f["name"])[0]), f["xref"])

    def font_xref(span_font: str) -> int | None:
        n = norm(span_font)
        return exact.get(n) or family.get(n) or family.get(norm(split_pdf_font_name(span_font)[0]))

    blocks: list[Block] = []
    for bi, b in enumerate(raw["blocks"]):
        if b.get("type") != 0:
            continue
        lines: list[Line] = []
        for li, ln in enumerate(b["lines"]):
            spans: list[Span] = []
            for s in ln["spans"]:
                chars = [Char(ch["c"], fitz.Rect(ch["bbox"]), fitz.Point(ch["origin"])) for ch in s["chars"]]
                text = "".join(ch.c for ch in chars)
                if not text:
                    continue
                spans.append(Span(text, s["font"], s["size"], s["color"], s["flags"], fitz.Rect(s["bbox"]),
                                  fitz.Point(s["origin"]), s.get("ascender", 0.9), s.get("descender", -0.2), chars,
                                  font_xref(s["font"])))
            if spans and "".join(sp.text for sp in spans).strip():
                lines.append(Line(f"b{bi}l{li}", spans, fitz.Rect(ln["bbox"]), tuple(ln["dir"])))
        if lines:
            r = fitz.Rect(lines[0].bbox)
            for ln in lines[1:]:
                r |= ln.bbox
            blocks.append(Block(f"b{bi}", lines, r))
    return blocks


def invisible_regions(page: fitz.Page) -> list[fitz.Rect]:
    """Bounding boxes of text drawn with render mode 3 (e.g. OCR layers)."""
    out = []
    try:
        for tr in page.get_texttrace():
            if tr.get("type") == 3 or tr.get("opacity", 1) == 0:
                out.append(fitz.Rect(tr["bbox"]))
    except Exception:
        pass
    return out


def page_text_objects(doc: fitz.Document, page: fitz.Page) -> dict:
    coords = PageCoords.for_page(page)
    fonts = {f["xref"]: f for f in analyze_page_fonts(doc, page)}
    invisible = invisible_regions(page)
    blocks = []
    for b in extract_lines(page):
        lines = []
        for ln in b.lines:
            m = ln.main_span
            finfo = fonts.get(m.font_xref) if m.font_xref else None
            fam, bold_n, italic_n, _ = split_pdf_font_name(m.font)
            lines.append({
                "id": ln.id,
                "text": ln.text,
                "bbox": coords.rect_to_pdf(ln.bbox),
                "angle": round(ln.angle, 3),
                "origin": list(coords.to_pdf(ln.spans[0].origin.x, ln.spans[0].origin.y)),
                "invisible": any(ln.bbox.intersects(r) and abs(ln.bbox & r) > 0.5 * abs(ln.bbox) for r in invisible),
                "style": {
                    "font": m.font,
                    "family": fam,
                    "size": round(m.size, 2),
                    "color": color_hex(m.color),
                    "bold": bool(m.flags & 16) or bold_n,
                    "italic": bool(m.flags & 2) or italic_n,
                    "serif": bool(m.flags & 4),
                    "mono": bool(m.flags & 8),
                    "font_status": finfo["status"] if finfo else "unknown",
                    "font_xref": m.font_xref,
                },
                "spans": [{"text": s.text, "font": s.font, "size": round(s.size, 2), "color": color_hex(s.color),
                           "bbox": coords.rect_to_pdf(s.bbox)} for s in ln.spans],
            })
        blocks.append({"id": b.id, "bbox": coords.rect_to_pdf(b.bbox), "lines": lines,
                       "text": "\n".join(x["text"] for x in lines)})
    text_chars = sum(len(ln["text"].strip()) for b in blocks for ln in b["lines"])
    img_cover = 0.0
    for info in page.get_image_info():
        img_cover += abs(fitz.Rect(info["bbox"]) & page.rect)
    scanned = text_chars < 10 and img_cover > 0.5 * abs(page.rect)
    return {"blocks": blocks, "scanned": scanned, "fonts": list(fonts.values())}
