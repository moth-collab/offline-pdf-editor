"""Headers, footers, page numbers and Bates numbering.

Text is laid out with the app's text engine (HarfBuzz shaping, automatic
font fallback, so Thai works) and drawn as real, searchable text.

Placement follows the page as it is *displayed*: on rotated pages the header
is still at the visible top. Each page's header/footer content goes into its
own content stream, remembered under the private page key ``/PEdHeaderFooter``,
so applying again replaces the previous header/footer instead of stacking,
and "Remove" can take it away cleanly. It is marked as a pagination artifact
(tagged-PDF semantics) so screen readers skip it.
"""
from __future__ import annotations

import datetime as dt
import re

import pikepdf
from pikepdf import Array, Name

from core.errors import AppError
from services.fonts import font_index
from services.pdf_writer import PageWriter, Resources, mat_mul, mat_translate, parse_color
from services.text_layout import LayoutResult, TextStyle, layout_line, load_face

POSITIONS = ("top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right")
KEY = Name("/PEdHeaderFooter")
THAI_DIGITS = str.maketrans("0123456789", "๐๑๒๓๔๕๖๗๘๙")
THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
               "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]
TOKEN_RE = re.compile(r"\{(page|total|date|file|bates)\}")


def format_date(fmt: str, today: dt.date | None = None) -> str:
    d = today or dt.date.today()
    if fmt == "thai":  # 23 พฤศจิกายน 2569 (Buddhist era)
        return f"{d.day} {THAI_MONTHS[d.month - 1]} {d.year + 543}"
    if fmt == "thai-short":  # 23/11/2569
        return f"{d.day:02d}/{d.month:02d}/{d.year + 543}"
    if fmt == "iso":
        return d.isoformat()
    if fmt == "us":
        return f"{d.month:02d}/{d.day:02d}/{d.year}"
    return f"{d.day:02d}/{d.month:02d}/{d.year}"  # dd/mm/yyyy


def expand(template: str, *, page: int, total: int, date: str, file: str, bates: str, thai_digits: bool) -> str:
    def sub(m: re.Match) -> str:
        key = m.group(1)
        if key == "page":
            v = str(page)
        elif key == "total":
            v = str(total)
        elif key == "date":
            return date  # already formatted (digits converted below if requested)
        elif key == "file":
            return file  # file names keep their own digits
        else:
            v = bates
        return v

    out = TOKEN_RE.sub(sub, template)
    if thai_digits:
        # convert digits that came from numbers/dates, but keep file names untouched
        parts = re.split(r"(\{file\})", template)
        if len(parts) == 1:
            out = out.translate(THAI_DIGITS)
        else:
            rebuilt = []
            for p in parts:
                if p == "{file}":
                    rebuilt.append(file)
                else:
                    rebuilt.append(TOKEN_RE.sub(sub, p).translate(THAI_DIGITS))
            out = "".join(rebuilt)
    return out


def display_matrix(box: list[float], rotation: int) -> tuple[tuple[float, ...], float, float]:
    """Matrix from the *displayed* page frame (origin bottom-left, x right, y up)
    to PDF user space, plus the displayed width and height."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    r = rotation % 360
    if r == 90:
        return (0.0, 1.0, -1.0, 0.0, x1, y0), h, w
    if r == 180:
        return (-1.0, 0.0, 0.0, -1.0, x1, y1), w, h
    if r == 270:
        return (0.0, -1.0, 1.0, 0.0, x0, y1), h, w
    return (1.0, 0.0, 0.0, 1.0, x0, y0), w, h


def _page_box(page: pikepdf.Page) -> list[float]:
    b = page.obj.get("/CropBox") or page.mediabox
    v = [float(x) for x in b]
    return [min(v[0], v[2]), min(v[1], v[3]), max(v[0], v[2]), max(v[1], v[3])]


def remove(pdf: pikepdf.Pdf) -> int:
    """Remove header/footer streams added by this application. Returns pages changed."""
    changed = 0
    for page in pdf.pages:
        refs = page.obj.get(KEY)
        if refs is None:
            continue
        ids = {r.objgen for r in refs if r.is_indirect}
        contents = page.obj.get("/Contents")
        if isinstance(contents, pikepdf.Array):
            keep = [c for c in contents if not (c.is_indirect and c.objgen in ids)]
            page.obj.Contents = Array(keep)
        del page.obj[KEY]
        changed += 1
    return changed


def apply(pdf: pikepdf.Pdf, spec: dict, *, file_name: str = "") -> dict:
    items = {p: str(spec.get(p) or "") for p in POSITIONS}
    if not any(t.strip() for t in items.values()):
        raise AppError("invalid_request", "Enter the text of at least one header or footer")
    n = len(pdf.pages)
    pages = spec.get("pages")
    targets = sorted({int(p) for p in pages}) if pages else list(range(n))
    if any(p < 0 or p >= n for p in targets):
        raise AppError("invalid_page", "Page out of range")
    size = float(spec.get("font_size", 10) or 10)
    if not 4 <= size <= 72:
        raise AppError("invalid_request", "Font size must be between 4 and 72 pt")
    color = parse_color(spec.get("color") or "#000000") or (0, 0, 0)
    margins = spec.get("margins") or {}
    m_top = float(margins.get("top", 28))
    m_bottom = float(margins.get("bottom", 28))
    m_left = float(margins.get("left", 36))
    m_right = float(margins.get("right", 36))
    start = int(spec.get("start_number", 1) or 1)
    bates_spec = spec.get("bates") or {}
    b_prefix = str(bates_spec.get("prefix", ""))
    b_suffix = str(bates_spec.get("suffix", ""))
    b_start = int(bates_spec.get("start", 1) or 1)
    b_digits = max(1, min(12, int(bates_spec.get("digits", 6) or 6)))
    date = format_date(str(spec.get("date_format", "dmy")))
    thai_digits = bool(spec.get("thai_digits"))
    # {total} is the number of the last page, so numbering that continues from
    # another document ("start at 11") still reads "Page 12 of 20"
    last = start + (len(targets) if spec.get("count_selected_only") else n) - 1

    family = str(spec.get("font") or "Sarabun")
    face = font_index.find(family, False, False) or font_index.find("Noto Sans") or font_index.for_script("latin")
    if face is None:
        raise AppError("font_missing", "No usable font was found on this computer")
    font = load_face(face)

    remove(pdf)  # re-applying replaces the previous header/footer
    res = Resources(pdf)
    for k, idx in enumerate(targets):
        page = pdf.pages[idx]
        number = start + (k if spec.get("count_selected_only") else idx)
        bates = f"{b_prefix}{b_start + k:0{b_digits}d}{b_suffix}"
        box = _page_box(page)
        rot = int(page.obj.get("/Rotate", 0) or 0)
        to_pdf, dw, dh = display_matrix(box, rot)
        w = PageWriter(pdf, page, res)
        w.begin_marked("Artifact", "<</Type /Pagination /Subtype /Header>>")
        for pos, template in items.items():
            if not template.strip():
                continue
            text = expand(template, page=number, total=last, date=date, file=file_name, bates=bates,
                          thai_digits=thai_digits)
            style = TextStyle(font=font, size=size, color=color)
            line = layout_line(text, style)
            line.baseline = 0
            asc = size * font.ascender / font.upem
            desc = -size * font.descender / font.upem
            vert, horiz = pos.split("-")
            y = dh - m_top - asc if vert == "top" else m_bottom + desc
            if horiz == "left":
                x = m_left
            elif horiz == "right":
                x = dw - m_right - line.width
            else:
                x = (dw - line.width) / 2
            lay = LayoutResult([line], line.width, 0.0, [], [])
            w.text_layout(lay, style, mat_mul(mat_translate(x, y), to_pdf))
        w.end_marked()
        before = _contents_ids(page)
        w.commit(overlay=True)
        added = [c for c in _contents_list(page) if c.is_indirect and c.objgen not in before]
        page.obj[KEY] = Array(added)
    res.finalize()
    return {"pages_marked": len(targets)}


def _contents_list(page: pikepdf.Page) -> list:
    c = page.obj.get("/Contents")
    if c is None:
        return []
    return list(c) if isinstance(c, pikepdf.Array) else [c]


def _contents_ids(page: pikepdf.Page) -> set:
    return {c.objgen for c in _contents_list(page) if c.is_indirect}


def has_header_footer(pdf: pikepdf.Pdf) -> bool:
    return any(KEY in p.obj for p in pdf.pages)


__all__ = ["apply", "remove", "expand", "format_date", "display_matrix", "has_header_footer", "POSITIONS"]
