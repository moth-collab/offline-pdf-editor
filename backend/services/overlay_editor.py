"""Overlay editing engine: renders the structured overlay object model into
PDF page content.

Every object is defined in PDF user space (``rect`` = unrotated box, y up)
with a clockwise ``rotation`` about its centre. Objects are written in list
order (= z-order). Text is real, selectable text (embedded subset fonts with
correct ToUnicode), shapes are vector paths, images are XObjects (cropped
pixels are physically removed), links are standard Link annotations.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name

from core.config import get_settings
from core.errors import AppError
from services.fonts import font_index
from services.pdf_writer import (PageWriter, WriterSession, box_matrix, mat_mul, mat_translate, parse_color)
from services.text_layout import LayoutLine, LayoutResult, TextStyle, layout_line, layout_text, load_face

ASSET_RE = re.compile(r"^[0-9a-f]{40}\.(jpg|png|gif)$")


def assets_dir() -> Path:
    return get_settings().sessions_root.parent / "assets"


def resolve_font(family: str | None, bold: bool, italic: bool):
    face = font_index.find(family or "", bold, italic) if family else None
    if face is None:
        face = font_index.find("Noto Sans", bold, italic) or font_index.for_script("latin", bold, italic)
    if face is None:
        raise AppError("font_missing", "No usable font was found on this computer")
    return face


def text_style(o: dict) -> TextStyle:
    bold = bool(o.get("bold"))
    italic = bool(o.get("italic"))
    face = resolve_font(o.get("font"), bold, italic)
    return TextStyle(
        font=load_face(face),
        size=max(0.5, float(o.get("fontSize", 12))),
        color=parse_color(o.get("color") or "#000000") or (0, 0, 0),
        bold=bold,
        italic=italic,
        underline=bool(o.get("underline")),
        strike=bool(o.get("strike")),
        char_spacing=float(o.get("charSpacing", 0) or 0),
        line_height=float(o.get("lineHeight", 1.2) or 1.2),
        align=o.get("align", "left") if o.get("align") in ("left", "center", "right", "justify") else "left",
        opacity=max(0.0, min(1.0, float(o.get("opacity", 1)))),
    )


def css_first_baseline(style: TextStyle) -> float:
    """Baseline of the first line as a browser places it (half-leading model)."""
    f = style.font
    asc = style.size * f.ascender / f.upem
    desc = -style.size * f.descender / f.upem
    return (style.size * style.line_height - (asc + desc)) / 2 + asc


def layout_text_box(o: dict, style: TextStyle, inner_w: float) -> LayoutResult:
    """Use the line breaks measured by the editor when provided (WYSIWYG)."""
    first = css_first_baseline(style)
    measured = o.get("lines")
    if isinstance(measured, list) and measured and all(isinstance(x, dict) for x in measured):
        lines: list[LayoutLine] = []
        adv = style.size * style.line_height
        for i, item in enumerate(measured):
            txt = str(item.get("text", ""))
            ln = layout_line(txt, style)
            ln.baseline = first + i * adv
            if style.align == "center":
                ln.x = (inner_w - ln.width) / 2
            elif style.align == "right":
                ln.x = inner_w - ln.width
            elif style.align == "justify" and not item.get("end"):
                n = txt.rstrip(" ").count(" ")
                if n:
                    ln.space_stretch = (inner_w - ln.width) / n
                    ln.width = inner_w
            lines.append(ln)
        return LayoutResult(lines, inner_w, (lines[-1].baseline if lines else 0), [], [])
    return layout_text(str(o.get("text", "")), style, max_width=inner_w, first_baseline=first)


def _draw_text(w: PageWriter, o: dict, m) -> list[dict]:
    x0, y0, x1, y1 = o["rect"]
    bw, bh = abs(x1 - x0), abs(y1 - y0)
    opacity = max(0.0, min(1.0, float(o.get("opacity", 1))))
    bg = parse_color(o.get("background"))
    border = parse_color(o.get("borderColor"))
    bwidth = float(o.get("borderWidth", 0) or 0)
    if bg is not None or (border is not None and bwidth > 0):
        w.shape("rect", bw, bh, m, stroke=border if bwidth > 0 else None, fill=bg, line_width=bwidth, opacity=opacity)
    if not str(o.get("text", "")).strip():
        return []
    style = text_style(o)
    pad = float(o.get("padding", 2) or 0)
    inner_w = max(1.0, bw - 2 * pad)
    layout = layout_text_box(o, style, inner_w)
    w.text_layout(layout, style, mat_mul(mat_translate(pad, -pad), m))
    return layout.fallback_used


def _draw_image(w: PageWriter, pdf: pikepdf.Pdf, o: dict, m, cache: dict) -> None:
    aid = str(o.get("assetId", ""))
    if not ASSET_RE.match(aid):
        raise AppError("invalid_asset", "Invalid image reference")
    path = assets_dir() / aid
    if not path.is_file():
        raise AppError("asset_missing", "An inserted image is no longer available")
    crop = [max(0.0, min(0.95, float(c))) for c in (o.get("crop") or [0, 0, 0, 0])][:4]
    key = (aid, tuple(crop), bool(o.get("flipH")), bool(o.get("flipV")))
    info = cache.get(key)
    if info is None:
        from services.pdf_writer import make_image_xobject

        info = make_image_xobject(pdf, path.read_bytes(), crop=crop, flip_h=bool(o.get("flipH")),
                                  flip_v=bool(o.get("flipV")))
        cache[key] = info
    x0, y0, x1, y1 = o["rect"]
    bw, bh = abs(x1 - x0), abs(y1 - y0)
    opacity = max(0.0, min(1.0, float(o.get("opacity", 1))))
    w.image(info.xobj, bw, bh, m, opacity=opacity)
    border = parse_color(o.get("borderColor"))
    bwidth = float(o.get("borderWidth", 0) or 0)
    if border is not None and bwidth > 0:
        w.shape("rect", bw, bh, m, stroke=border, line_width=bwidth, opacity=opacity)


def _draw_shape(w: PageWriter, o: dict, m) -> None:
    x0, y0, x1, y1 = o["rect"]
    bw, bh = abs(x1 - x0), abs(y1 - y0)
    kind = o["kind"]
    opacity = max(0.0, min(1.0, float(o.get("opacity", 1))))
    dash = o.get("dash") or None
    if kind in ("line", "arrow"):
        pts = o.get("points") or [[x0, y0], [x1, y1]]
        left, top = min(x0, x1), max(y0, y1)
        local = [[p[0] - left, p[1] - top] for p in pts]
        w.shape(kind, bw, bh, m, stroke=parse_color(o.get("stroke") or "#000000"),
                line_width=float(o.get("strokeWidth", 1) or 1), opacity=opacity, dash=dash, points=local)
        return
    w.shape("rect" if kind == "rect" else "ellipse", bw, bh, m,
            stroke=parse_color(o.get("stroke")) if float(o.get("strokeWidth", 1) or 0) > 0 else None,
            fill=parse_color(o.get("fill")), line_width=float(o.get("strokeWidth", 1) or 0), opacity=opacity,
            fill_opacity=opacity * max(0.0, min(1.0, float(o.get("fillOpacity", 1)))), dash=dash)


def _rotated_bbox(rect: list[float], rotation: float) -> list[float]:
    x0, y0, x1, y1 = rect
    if not rotation:
        return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    t = math.radians(-rotation)
    c, s = math.cos(t), math.sin(t)
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    xs = [cx + (px - cx) * c - (py - cy) * s for px, py in pts]
    ys = [cy + (px - cx) * s + (py - cy) * c for px, py in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def _add_link(pdf: pikepdf.Pdf, page_index: int, o: dict) -> None:
    target = o.get("target") or {}
    page = pdf.pages[page_index]
    annot = Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array(_rotated_bbox(o["rect"], o.get("rotation", 0))),
                       Border=Array([0, 0, 0]), F=4)
    if target.get("type") == "url":
        url = str(target.get("url", "")).strip()
        if not re.match(r"^(https?://|mailto:)", url, re.I):
            raise AppError("invalid_link", f"Unsupported link address: {url[:80]}")
        annot.A = Dictionary(S=Name.URI, URI=pikepdf.String(url))
    elif target.get("type") == "page":
        tp = int(target.get("page", 0))
        if not 0 <= tp < len(pdf.pages):
            raise AppError("invalid_link", "The link points to a page that does not exist")
        annot.Dest = Array([pdf.pages[tp].obj, Name.Fit])
    else:
        return
    if Name.Annots not in page.obj:
        page.obj.Annots = Array()
    page.obj.Annots.append(pdf.make_indirect(annot))


def bake_overlays(src: Path, dst: Path, overlays: list[dict]) -> dict:
    """Write ``overlays`` onto the pages of ``src`` and save to ``dst``."""
    warnings: list[dict] = []
    with pikepdf.open(str(src)) as pdf:
        n = len(pdf.pages)
        ws = WriterSession(pdf)
        img_cache: dict = {}
        links: list[tuple[int, dict]] = []
        for o in overlays:
            try:
                page_index = int(o.get("page", -1))
                rect = [float(v) for v in o["rect"]]
                kind = o["kind"]
            except (KeyError, TypeError, ValueError) as exc:
                raise AppError("invalid_overlay", f"Invalid object: {exc}") from exc
            if not 0 <= page_index < n:
                raise AppError("invalid_overlay", f"Object on missing page {page_index + 1}")
            if len(rect) != 4 or not all(math.isfinite(v) for v in rect):
                raise AppError("invalid_overlay", "Invalid object geometry")
            o = {**o, "rect": rect}
            if kind == "link":
                links.append((page_index, o))
                continue
            m = box_matrix(rect, float(o.get("rotation", 0) or 0))
            w = ws.page(page_index)
            if kind == "text":
                for fb in _draw_text(w, o, m):
                    warnings.append({"object": o.get("id"), **fb})
            elif kind == "image":
                _draw_image(w, pdf, o, m, img_cache)
            elif kind in ("rect", "ellipse", "line", "arrow"):
                _draw_shape(w, o, m)
            else:
                raise AppError("invalid_overlay", f"Unknown object type {kind}")
        ws.commit()
        for page_index, o in links:
            _add_link(pdf, page_index, o)
        pdf.save(str(dst))
    return {"warnings": warnings}
