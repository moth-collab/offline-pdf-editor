"""Annotation engine: list / add / update / delete / flatten standard PDF
annotations. Geometry is exchanged in PDF user space."""
from __future__ import annotations

import html
import time

import pymupdf as fitz

from core.coords import PageCoords
from core.errors import AppError
from services.pdf_writer import parse_color
from services.text_extraction import RAW_FLAGS

TYPE_NAMES = {
    fitz.PDF_ANNOT_TEXT: "note", fitz.PDF_ANNOT_FREE_TEXT: "freetext", fitz.PDF_ANNOT_LINE: "line",
    fitz.PDF_ANNOT_SQUARE: "rect", fitz.PDF_ANNOT_CIRCLE: "circle", fitz.PDF_ANNOT_POLYGON: "polygon",
    fitz.PDF_ANNOT_POLY_LINE: "polyline", fitz.PDF_ANNOT_HIGHLIGHT: "highlight", fitz.PDF_ANNOT_UNDERLINE: "underline",
    fitz.PDF_ANNOT_SQUIGGLY: "squiggly", fitz.PDF_ANNOT_STRIKE_OUT: "strikeout", fitz.PDF_ANNOT_STAMP: "stamp",
    fitz.PDF_ANNOT_INK: "ink", fitz.PDF_ANNOT_REDACT: "redact", fitz.PDF_ANNOT_LINK: "link",
    fitz.PDF_ANNOT_WIDGET: "widget", fitz.PDF_ANNOT_POPUP: "popup", fitz.PDF_ANNOT_FILE_ATTACHMENT: "attachment",
    fitz.PDF_ANNOT_CARET: "caret",
}
MARKUP = {"highlight": fitz.PDF_ANNOT_HIGHLIGHT, "underline": fitz.PDF_ANNOT_UNDERLINE,
          "strikeout": fitz.PDF_ANNOT_STRIKE_OUT, "squiggly": fitz.PDF_ANNOT_SQUIGGLY}
STAMPS = ["Approved", "AsIs", "Confidential", "Departmental", "Experimental", "Expired", "Final", "ForComment",
          "ForPublicRelease", "NotApproved", "NotForPublicRelease", "Sold", "TopSecret", "Draft"]
NOTE_ICONS = ["Note", "Comment", "Key", "Help", "NewParagraph", "Paragraph", "Insert"]
LINE_ENDS = {"none": fitz.PDF_ANNOT_LE_NONE, "open": fitz.PDF_ANNOT_LE_OPEN_ARROW,
             "closed": fitz.PDF_ANNOT_LE_CLOSED_ARROW, "circle": fitz.PDF_ANNOT_LE_CIRCLE,
             "square": fitz.PDF_ANNOT_LE_SQUARE}
EDITABLE_GEOMETRY = {"note", "freetext", "rect", "circle", "line", "ink", "stamp", "polygon", "polyline", "redact"}


def _hex(c) -> str | None:
    if not c:
        return None
    c = list(c)[:3]
    if len(c) == 1:
        c = c * 3
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02x}" for v in c)


def _pdf_date(s: str | None) -> str | None:
    if not s:
        return None
    s = s[2:] if s.startswith("D:") else s
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.strptime(s[:14], "%Y%m%d%H%M%S"))
    except ValueError:
        return None


def describe(page: fitz.Page, a: fitz.Annot, coords: PageCoords | None = None) -> dict:
    coords = coords or PageCoords.for_page(page)
    kind = TYPE_NAMES.get(a.type[0], a.type[1].lower())
    colors = a.colors or {}
    info = a.info or {}
    d = {
        "id": str(a.xref),
        "xref": a.xref,
        "page": page.number,
        "type": kind,
        "rect": coords.rect_to_pdf(a.rect),
        "stroke": _hex(colors.get("stroke")),
        "fill": _hex(colors.get("fill")),
        "opacity": round(a.opacity if a.opacity is not None and a.opacity >= 0 else 1, 3),
        "border_width": (a.border or {}).get("width", 1) if a.border else 1,
        "contents": info.get("content", ""),
        "author": info.get("title", ""),
        "subject": info.get("subject", ""),
        "modified": _pdf_date(info.get("modDate")),
        "created": _pdf_date(info.get("creationDate")),
        "editable": kind in EDITABLE_GEOMETRY,
    }
    if kind in MARKUP or kind in ("ink", "line", "polygon", "polyline"):
        v = a.vertices
        if v:
            if kind == "ink":
                d["strokes"] = [[list(coords.to_pdf(*pt)) for pt in stroke] for stroke in v]
            else:
                d["points"] = [list(coords.to_pdf(*pt)) for pt in v]
    if kind == "line":
        le = a.line_ends or (0, 0)
        d["line_ends"] = [next((k for k, v in LINE_ENDS.items() if v == e), "none") for e in le]
    if kind == "stamp":
        d["stamp"] = info.get("content") or info.get("subject") or ""
    if kind == "note":
        d["icon"] = info.get("name") or "Note"
    return d


def list_page(page: fitz.Page) -> list[dict]:
    coords = PageCoords.for_page(page)
    return [describe(page, a, coords) for a in page.annots() if a.type[0] not in (fitz.PDF_ANNOT_POPUP, fitz.PDF_ANNOT_LINK)]


def list_all(doc: fitz.Document) -> list[dict]:
    out = []
    for page in doc:
        if page.first_annot is None:
            continue
        out.extend(list_page(page))
    return out


# ----------------------------------------------------------------------
# selection -> quads (reading order between two points)
# ----------------------------------------------------------------------

def selection_quads(page: fitz.Page, a: fitz.Point, b: fitz.Point) -> list[fitz.Quad]:
    chars = []
    raw = page.get_text("rawdict", flags=RAW_FLAGS)
    line_no = 0
    for blk in raw["blocks"]:
        if blk.get("type") != 0:
            continue
        for ln in blk["lines"]:
            for sp in ln["spans"]:
                for ch in sp["chars"]:
                    chars.append((line_no, fitz.Rect(ch["bbox"]), ch["c"]))
            line_no += 1
    if not chars:
        return []

    def nearest(pt: fitz.Point) -> int:
        best, bi = None, 0
        for i, (_l, r, _c) in enumerate(chars):
            if r.is_empty and r.width == 0:
                r = fitz.Rect(r.x0 - 0.5, r.y0, r.x0 + 0.5, r.y1)
            dx = 0 if r.x0 <= pt.x <= r.x1 else min(abs(pt.x - r.x0), abs(pt.x - r.x1))
            dy = 0 if r.y0 <= pt.y <= r.y1 else min(abs(pt.y - r.y0), abs(pt.y - r.y1))
            dist = dy * 4 + dx
            if best is None or dist < best:
                best, bi = dist, i
        return bi

    i, j = nearest(a), nearest(b)
    if i > j:
        i, j = j, i
    lines: dict[int, fitz.Rect] = {}
    for ln, r, c in chars[i:j + 1]:
        if r.width <= 0 and c.strip() == "":
            continue
        lines[ln] = lines[ln] | r if ln in lines else fitz.Rect(r)
    return [r.quad for r in lines.values() if not r.is_empty]


# ----------------------------------------------------------------------
# create / update / delete
# ----------------------------------------------------------------------

def _apply_common(a: fitz.Annot, spec: dict, author: str | None) -> None:
    info = {}
    if "contents" in spec:
        info["content"] = str(spec.get("contents") or "")
    if author is not None:
        info["title"] = author
    if "subject" in spec:
        info["subject"] = str(spec["subject"])
    if info:
        a.set_info(**info)
    colors = {}
    kind = TYPE_NAMES.get(a.type[0])
    if "stroke" in spec and spec["stroke"] is not None:
        colors["stroke"] = parse_color(spec["stroke"])
    if "fill" in spec and kind in ("rect", "circle", "polygon", "line", "freetext"):
        colors["fill"] = parse_color(spec["fill"]) if spec["fill"] else []
    if colors and kind != "freetext":
        a.set_colors(**colors)
    if "opacity" in spec and spec["opacity"] is not None:
        a.set_opacity(max(0.05, min(1.0, float(spec["opacity"]))))
    if "border_width" in spec and spec["border_width"] is not None and kind not in MARKUP and kind not in ("note", "stamp"):
        a.set_border(width=max(0.0, float(spec["border_width"])))


def _freetext_html(text: str) -> str:
    return "<p>" + "<br/>".join(html.escape(x) for x in text.split("\n")) + "</p>"


def add(page: fitz.Page, spec: dict, author: str) -> dict:
    coords = PageCoords.for_page(page)
    t = spec.get("type")
    stroke = parse_color(spec.get("stroke")) if spec.get("stroke") else None
    if t in MARKUP:
        if spec.get("quads"):
            quads = [fitz.Quad(*[coords.to_mupdf(*p) for p in q]) for q in spec["quads"]]
        elif spec.get("start") and spec.get("stop"):
            quads = selection_quads(page, coords.to_mupdf(*spec["start"]), coords.to_mupdf(*spec["stop"]))
        else:
            raise AppError("invalid_request", "Select the text to mark")
        if not quads:
            raise AppError("no_text", "No text found in the selected area")
        fn = {"highlight": page.add_highlight_annot, "underline": page.add_underline_annot,
              "strikeout": page.add_strikeout_annot, "squiggly": page.add_squiggly_annot}[t]
        a = fn(quads)
        default = {"highlight": (1, 0.85, 0), "underline": (0, 0.4, 1), "strikeout": (0.9, 0.1, 0.1),
                   "squiggly": (0.1, 0.6, 0.1)}[t]
        a.set_colors(stroke=stroke or default)
    elif t == "note":
        pt = coords.to_mupdf(*spec["point"])
        a = page.add_text_annot(pt, str(spec.get("contents") or ""), icon=spec.get("icon") if spec.get("icon") in NOTE_ICONS else "Note")
        a.set_colors(stroke=stroke or (1, 0.8, 0))
    elif t in ("freetext", "callout"):
        r = coords.rect_to_mupdf(spec["rect"])
        text = str(spec.get("contents") or "")
        size = float(spec.get("font_size") or 12)
        tc = parse_color(spec.get("text_color") or "#000000")
        kwargs = dict(fontsize=size, text_color=tc, fill_color=parse_color(spec["fill"]) if spec.get("fill") else None,
                      border_color=stroke, border_width=float(spec.get("border_width", 1 if stroke else 0)),
                      richtext=True, style=f"font-size:{size}pt;color:rgb({','.join(str(round(v * 255)) for v in tc)})")
        if t == "callout" and spec.get("callout"):
            pts = [coords.to_mupdf(*p) for p in spec["callout"]]
            kwargs["callout"] = pts
            kwargs["line_end"] = fitz.PDF_ANNOT_LE_OPEN_ARROW
            kwargs["border_color"] = stroke or (0.2, 0.2, 0.2)
            kwargs["border_width"] = float(spec.get("border_width", 1))
        a = page.add_freetext_annot(r, _freetext_html(text), **kwargs)
        a.set_info(content=text)
    elif t in ("rect", "circle"):
        r = coords.rect_to_mupdf(spec["rect"])
        a = page.add_rect_annot(r) if t == "rect" else page.add_circle_annot(r)
        a.set_colors(stroke=stroke or (0.85, 0.15, 0.1), fill=parse_color(spec["fill"]) if spec.get("fill") else None)
        a.set_border(width=float(spec.get("border_width", 2)))
    elif t in ("line", "arrow"):
        p1, p2 = (coords.to_mupdf(*p) for p in spec["points"][:2])
        a = page.add_line_annot(p1, p2)
        a.set_colors(stroke=stroke or (0.85, 0.15, 0.1))
        a.set_border(width=float(spec.get("border_width", 2)))
        if t == "arrow":
            a.set_line_ends(fitz.PDF_ANNOT_LE_NONE, fitz.PDF_ANNOT_LE_OPEN_ARROW)
    elif t == "ink":
        strokes = [[tuple(coords.to_mupdf(*p)) for p in s] for s in spec.get("strokes", []) if len(s) >= 2]
        if not strokes:
            raise AppError("invalid_request", "The drawing is empty")
        a = page.add_ink_annot(strokes)
        a.set_colors(stroke=stroke or (0.1, 0.3, 0.9))
        a.set_border(width=float(spec.get("border_width", 2)))
    elif t == "stamp":
        name = spec.get("stamp", "Approved")
        idx = STAMPS.index(name) if name in STAMPS else 0
        a = page.add_stamp_annot(coords.rect_to_mupdf(spec["rect"]), stamp=idx)
    elif t == "redact":
        a = page.add_redact_annot(coords.rect_to_mupdf(spec["rect"]), fill=(0, 0, 0), cross_out=True)
        a.set_colors(stroke=(0.9, 0.1, 0.1))
    else:
        raise AppError("invalid_request", f"Unsupported annotation type {t}")
    _apply_common(a, {k: v for k, v in spec.items() if k not in ("stroke",)}, author)
    a.update()
    return describe(page, page.load_annot(a.xref))


def _find(page: fitz.Page, xref: int) -> fitz.Annot:
    for a in page.annots():
        if a.xref == xref:
            return a
    raise AppError("annotation_not_found", "The comment no longer exists")


def update(page: fitz.Page, xref: int, spec: dict, author: str | None) -> dict:
    coords = PageCoords.for_page(page)
    a = _find(page, xref)
    kind = TYPE_NAMES.get(a.type[0])
    if "rect" in spec and spec["rect"] and kind in EDITABLE_GEOMETRY:
        new = coords.rect_to_mupdf(spec["rect"])
        old = fitz.Rect(a.rect)
        if kind in ("ink", "line", "polygon", "polyline"):
            # transform vertices from the old box to the new one by re-creating the annotation
            sx = new.width / max(old.width, 0.01)
            sy = new.height / max(old.height, 0.01)

            def tr(p):
                return fitz.Point(new.x0 + (p[0] - old.x0) * sx, new.y0 + (p[1] - old.y0) * sy)

            desc = describe(page, a, coords)
            if kind == "ink":
                strokes = [[tuple(tr(p)) for p in s] for s in a.vertices]
                b = page.add_ink_annot(strokes)
            elif kind == "line":
                v = a.vertices
                b = page.add_line_annot(tr(v[0]), tr(v[1]))
                le = a.line_ends
                if le:
                    b.set_line_ends(*le)
            else:
                pts = [tr(p) for p in a.vertices]
                b = page.add_polygon_annot(pts) if kind == "polygon" else page.add_polyline_annot(pts)
            b.set_colors(stroke=parse_color(desc["stroke"]) if desc["stroke"] else None,
                         fill=parse_color(desc["fill"]) if desc["fill"] else None)
            b.set_border(width=desc["border_width"])
            b.set_opacity(desc["opacity"])
            b.set_info(content=desc["contents"], title=desc["author"], subject=desc["subject"])
            page.delete_annot(a)
            a = b
        else:
            a.set_rect(new)
    if kind == "freetext" and "contents" in spec:
        # rebuild the rich text appearance with the new text
        r = fitz.Rect(a.rect)
        desc = describe(page, a, coords)
        size = float(spec.get("font_size") or 12)
        text = str(spec["contents"])
        b = page.add_freetext_annot(r, _freetext_html(text), fontsize=size, richtext=True,
                                    style=f"font-size:{size}pt",
                                    fill_color=parse_color(spec.get("fill") or desc["fill"]) if (spec.get("fill") or desc["fill"]) else None)
        b.set_info(content=text, title=desc["author"])
        page.delete_annot(a)
        a = b
    _apply_common(a, spec, author)
    if kind == "note" and spec.get("icon") in NOTE_ICONS:
        a.set_name(spec["icon"])
    if kind == "line" and spec.get("line_ends"):
        a.set_line_ends(*[LINE_ENDS.get(x, 0) for x in spec["line_ends"][:2]])
    a.update()
    return describe(page, page.load_annot(a.xref))


def delete(page: fitz.Page, xrefs: list[int]) -> int:
    n = 0
    for xref in xrefs:
        try:
            page.delete_annot(_find(page, xref))
            n += 1
        except AppError:
            continue
    return n


def flatten(doc: fitz.Document) -> int:
    count = sum(1 for p in doc for a in p.annots() if a.type[0] not in (fitz.PDF_ANNOT_LINK, fitz.PDF_ANNOT_POPUP,
                                                                       fitz.PDF_ANNOT_REDACT))
    # redaction marks must be applied, not baked: keep them as annotations
    redacts = {}
    for p in doc:
        for a in p.annots(types=[fitz.PDF_ANNOT_REDACT]):
            redacts.setdefault(p.number, []).append(a.xref)
    if redacts:
        raise AppError("pending_redactions", "Apply or remove the redaction marks before flattening comments")
    doc.bake(annots=True, widgets=False)
    return count
