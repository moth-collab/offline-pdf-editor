"""Direct Text Editing Engine.

Workflow for every edit (preview and apply use the same code):

1. Analyse the target text lines and their surroundings.
2. Decide whether direct replacement is safe (collateral glyphs, invisible
   OCR text, Type 3 fonts, overlap with images/vector art, overflow).
3. Plan the font: reuse the original embedded font when it can render the new
   text (its cmap is repaired from the PDF's ToUnicode map), else an exactly
   matching local font, else a metric-compatible substitute. Substitution is
   never silent: the report carries warnings shown before confirmation.
4. Remove only the original glyphs (glyph-level redaction without any fill –
   backgrounds, images and vector graphics are preserved; no white boxes).
5. Write the new text with HarfBuzz shaping at the original baseline (or laid
   out in the paragraph box), with the original size/colour unless changed.
6. Verify the result by text extraction and render before/after previews.
"""
from __future__ import annotations

import base64
import hashlib
import io
import re
import unicodedata
from dataclasses import dataclass, field

import pikepdf
import pymupdf as fitz
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

from core.coords import PageCoords
from core.errors import AppError
from services.fonts import font_index, scripts_in_text, split_pdf_font_name
from services.pdf_writer import WriterSession, mat_mul, mat_rotate_cw, mat_translate, parse_color
from services.text_extraction import Line, extract_lines, invisible_regions
from services.text_layout import LoadedFont, TextStyle, layout_text, load_buffer, load_face

# ----------------------------------------------------------------------
# request model
# ----------------------------------------------------------------------


@dataclass
class EditRequest:
    page: int
    line_ids: list[str]
    new_text: str
    font_family: str | None = None  # user chosen family (overrides font plan)
    size: float | None = None
    color: str | None = None
    bold: bool | None = None
    italic: bool | None = None
    underline: bool = False
    strike: bool = False
    align: str | None = None
    line_height: float | None = None  # multiple of font size
    char_spacing: float = 0.0
    box: list[float] | None = None  # PDF rect for paragraph layout (resize)
    offset: list[float] | None = None  # [dx, dy] PDF units (drag to move)
    fit: str = "overflow"  # overflow | shrink

    @classmethod
    def from_dict(cls, d: dict) -> "EditRequest":
        known = {k: d[k] for k in cls.__dataclass_fields__ if k in d}
        return cls(**known)


@dataclass
class Report:
    level: str = "safe"  # safe | caution | unsupported
    warnings: list[dict] = field(default_factory=list)
    font: dict = field(default_factory=dict)
    background: dict = field(default_factory=dict)
    layout: dict = field(default_factory=dict)
    collateral: list[str] = field(default_factory=list)
    verification: dict = field(default_factory=dict)

    def warn(self, code: str, message: str, level: str = "caution") -> None:
        self.warnings.append({"code": code, "message": message, "level": level})
        order = {"safe": 0, "caution": 1, "unsupported": 2}
        if order[level] > order[self.level]:
            self.level = level

    def to_dict(self) -> dict:
        return {"level": self.level, "safe": self.level == "safe", "warnings": self.warnings, "font": self.font,
                "background": self.background, "layout": self.layout, "collateral": self.collateral,
                "verification": self.verification}


# ----------------------------------------------------------------------
# font reuse
# ----------------------------------------------------------------------

_reuse_cache: dict[str, tuple[LoadedFont | None, str]] = {}


def _parse_tounicode(data: bytes) -> dict[int, str]:
    out: dict[int, str] = {}
    text = data.decode("latin-1", "ignore")

    def hex_to_str(h: str) -> str:
        h = h.strip()
        if len(h) % 4:
            h = h.zfill(len(h) + (4 - len(h) % 4))
        try:
            return bytes.fromhex(h).decode("utf-16-be", "ignore")
        except ValueError:
            return ""

    for block in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
        for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", block):
            out[int(src, 16)] = hex_to_str(dst)
    for block in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
        for m in re.finditer(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])", block):
            a, b, dst = int(m.group(1), 16), int(m.group(2), 16), m.group(3)
            if b - a > 65535:
                continue
            if dst.startswith("["):
                items = re.findall(r"<([0-9A-Fa-f]*)>", dst)
                for i, h in enumerate(items):
                    out[a + i] = hex_to_str(h)
            else:
                base = hex_to_str(dst[1:-1])
                if not base:
                    continue
                for i in range(b - a + 1):
                    out[a + i] = base[:-1] + chr(ord(base[-1]) + i)
    return out


def _font_obj(doc: fitz.Document, xref: int, key: str) -> tuple[str, str]:
    return doc.xref_get_key(xref, key)


def _ref(val: tuple[str, str]) -> int | None:
    if val[0] == "xref":
        return int(val[1].split()[0])
    return None


def reuse_original_font(doc: fitz.Document, xref: int | None, needed: str) -> tuple[LoadedFont | None, str]:
    """Return a LoadedFont built from the PDF's own embedded font program, or
    (None, reason) when it cannot render ``needed``."""
    if not xref:
        return None, "the original font could not be identified"
    try:
        name, ext, ftype, buf = doc.extract_font(xref)
    except Exception:
        return None, "the original font cannot be extracted"
    if ftype == "Type3":
        return None, "Type 3 fonts cannot be reused"
    if not buf or ext not in ("ttf", "otf"):
        return None, "the original font is not embedded" if not buf else f"the embedded font format ({ext}) cannot be reused"
    digest = hashlib.sha1(buf).hexdigest()
    try:
        tt = TTFont(io.BytesIO(buf))
    except Exception:
        return None, "the embedded font program is damaged"
    if "glyf" not in tt and "CFF " not in tt:
        return None, "the embedded font has no outlines"
    glyph_order = tt.getGlyphOrder()
    mapping: dict[int, int] = {}
    # 1) the font's own unicode cmap
    if "cmap" in tt:
        for sub in tt["cmap"].tables:
            if sub.isUnicode():
                for cp, gname in sub.cmap.items():
                    mapping.setdefault(cp, tt.getGlyphID(gname))
    # 2) the PDF ToUnicode map (+ CIDToGIDMap for Type0 fonts)
    tu_ref = _ref(_font_obj(doc, xref, "ToUnicode"))
    tounicode = _parse_tounicode(doc.xref_stream(tu_ref)) if tu_ref else {}
    if ftype == "Type0":
        desc = _font_obj(doc, xref, "DescendantFonts")
        m = re.search(r"(\d+)\s+0\s+R", desc[1] or "")
        cid2gid = None
        if m:
            dx = int(m.group(1))
            c2g = _font_obj(doc, dx, "CIDToGIDMap")
            c2g_ref = _ref(c2g)
            if c2g_ref:
                raw = doc.xref_stream(c2g_ref) or b""
                cid2gid = [int.from_bytes(raw[i:i + 2], "big") for i in range(0, len(raw) - 1, 2)]
        for cid, s in tounicode.items():
            if len(s) != 1:
                continue
            gid = cid2gid[cid] if cid2gid is not None and cid < len(cid2gid) else cid
            if 0 < gid < len(glyph_order):
                mapping.setdefault(ord(s), gid)
    else:
        # simple TrueType font: codes map to glyphs through (3,0) / (1,0) cmaps
        sym = {}
        if "cmap" in tt:
            for sub in tt["cmap"].tables:
                if (sub.platformID, sub.platEncID) in ((3, 0), (1, 0)):
                    for code, gname in sub.cmap.items():
                        sym[code & 0xFF] = tt.getGlyphID(gname)
        enc = _font_obj(doc, xref, "Encoding")[1] or ""
        for code in range(32, 256):
            if code in tounicode and len(tounicode[code]) == 1:
                ch = tounicode[code]
            else:
                try:
                    ch = bytes([code]).decode("cp1252" if "WinAnsi" in enc or not enc or enc == "null" else "latin-1")
                except UnicodeDecodeError:
                    continue
            if code in sym:
                mapping.setdefault(ord(ch), sym[code])
    def has_outline(gid: int) -> bool:
        # subset fonts often keep cmap entries for glyphs whose outlines were removed
        try:
            gname = glyph_order[gid]
            if "glyf" in tt:
                g = tt["glyf"][gname]
                return g.numberOfContours != 0
            cs = tt["CFF "].cff.topDictIndex[0].CharStrings[gname]
            cs.decompile()
            return len(cs.program) > 2
        except Exception:
            return False

    missing = sorted({c for c in needed if not c.isspace() and unicodedata.category(c) not in ("Cf", "Cc")
                      and (ord(c) not in mapping or not has_outline(mapping[ord(c)]))})
    if missing:
        return None, f"the embedded subset does not contain: {''.join(missing[:20])}"
    # inject a clean unicode cmap so shaping/measurement work normally
    cmap = newTable("cmap")
    cmap.tableVersion = 0
    sub = CmapSubtable.newSubtable(4 if max(mapping, default=0) <= 0xFFFF else 12)
    sub.platformID, sub.platEncID, sub.language = 3, (1 if sub.format == 4 else 10), 0
    sub.cmap = {cp: glyph_order[g] for cp, g in mapping.items() if cp <= (0xFFFF if sub.format == 4 else 0x10FFFF)}
    cmap.tables = [sub]
    tt["cmap"] = cmap
    if "post" in tt:
        tt["post"].formatType = 3.0
    out = io.BytesIO()
    try:
        tt.save(out)
    except Exception as exc:
        return None, f"the embedded font cannot be rebuilt ({exc.__class__.__name__})"
    fam, bold, italic, _ = split_pdf_font_name(name)
    key = f"pdffont:{digest}:{hashlib.sha1(str(sorted(mapping.items())).encode()).hexdigest()[:10]}"
    try:
        lf = load_buffer(key, out.getvalue(), fam)
        lf.bold, lf.italic = bold, italic
    except Exception as exc:
        return None, f"the embedded font cannot be used ({exc.__class__.__name__})"
    return lf, "ok"


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------


def _core_box(r: fitz.Rect) -> fitz.Rect:
    """A centred box inside a glyph bbox: hits this glyph only."""
    w, h = r.width, r.height
    return fitz.Rect(r.x0 + w * 0.3, r.y0 + h * 0.3, r.x1 - w * 0.3, r.y1 - h * 0.3)


def _norm_text(s: str) -> str:
    # NUL / U+FFFD = characters without a unicode mapping (already unextractable)
    s = s.replace("\x00", "\ufffd")
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", s))


def _union(rects) -> fitz.Rect:
    rs = [fitz.Rect(r) for r in rects]
    out = fitz.Rect(rs[0])
    for r in rs[1:]:
        out |= r
    return out


def _png(page: fitz.Page, clip: fitz.Rect, zoom: float = 2.0) -> str:
    clip = clip & page.rect
    if clip.is_empty:
        clip = page.rect
    zoom = min(zoom, 2000 / max(clip.width, 1), 1400 / max(clip.height, 1))
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
    return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode("ascii")


def _alignment(lines: list[Line]) -> str:
    if len(lines) < 2:
        return "left"
    x0 = [ln.bbox.x0 for ln in lines]
    x1 = [ln.bbox.x1 for ln in lines]
    cx = [(a + b) / 2 for a, b in zip(x0, x1)]
    spread = lambda v: max(v) - min(v)  # noqa: E731
    if spread(x0) < 2 and spread(x1[:-1]) < 2 and len(lines) > 2:
        return "justify"
    if spread(x0) < 2:
        return "left"
    if spread(x1) < 2:
        return "right"
    if spread(cx) < 3:
        return "center"
    return "left"


# ----------------------------------------------------------------------
# main entry
# ----------------------------------------------------------------------


@dataclass
class Plan:
    report: Report
    lines: list[Line]
    others: list[Line]
    removal: list[fitz.Rect]
    style: TextStyle | None
    layout_kwargs: dict
    matrix: tuple
    region: fitz.Rect  # mupdf space, for previews/verification


def plan_edit(doc: fitz.Document, req: EditRequest) -> Plan:
    if not 0 <= req.page < doc.page_count:
        raise AppError("invalid_page", "Page out of range")
    page = doc[req.page]
    coords = PageCoords.for_page(page)
    report = Report()
    all_lines = [ln for b in extract_lines(page) for ln in b.lines]
    ids = set(req.line_ids)
    lines = [ln for ln in all_lines if ln.id in ids]
    if not lines or len(lines) != len(ids):
        raise AppError("text_not_found", "The selected text was not found on the page. It may have changed; please select it again.")
    others = [ln for ln in all_lines if ln.id not in ids]
    target_bbox = _union([ln.bbox for ln in lines])

    # ---- removal boxes and collateral check
    # Zero-width glyphs (Thai/Indic combining marks) have degenerate boxes: redacting
    # with exactly that box removes the mark only; any widened box would hit neighbours.
    removal = [(_core_box(c.bbox) if c.bbox.width > 0.01 else fitz.Rect(c.bbox))
               for ln in lines for c in ln.chars if not c.c.isspace()]
    collateral = []
    for ln in others:
        for c in ln.chars:
            if c.c.isspace():
                continue
            if any(c.bbox.intersects(r) and abs(c.bbox & r) > 0.02 * max(abs(c.bbox), 0.01) for r in removal):
                collateral.append(ln.text.strip())
                break
    if collateral:
        report.collateral = collateral[:10]
        report.warn("collateral", "Overlapping text from other lines would also be removed: "
                    + "; ".join(t[:40] for t in collateral[:3]))

    # ---- special cases
    invis = invisible_regions(page)
    if any(target_bbox.intersects(r) for r in invis):
        report.warn("invisible_text", "This text is invisible (for example an OCR text layer). Editing it changes "
                    "searchable text only, not what you see. Use Add Text / Overlay to change visible content.")
    main = lines[0].main_span
    fam, n_bold, n_italic, _subset = split_pdf_font_name(main.font)
    from services.fonts import analyze_page_fonts

    finfo = next((f for f in analyze_page_fonts(doc, page) if f["xref"] == main.font_xref), None)
    status = finfo["status"] if finfo else "unknown"
    if status == "unsupported":
        report.warn("type3", "This text uses a Type 3 (drawn) font that cannot be edited directly. "
                    "Use Add Text / Overlay mode instead.", "unsupported")
    angles = {round(ln.angle, 1) for ln in lines}
    if len(angles) > 1:
        report.warn("mixed_direction", "The selected lines have different directions.", "unsupported")
    angle = lines[0].angle

    # ---- background analysis (informational: backgrounds are never painted over)
    imgs = [fitz.Rect(i["bbox"]) for i in page.get_image_info()]
    over_img = any(target_bbox.intersects(r) for r in imgs)
    try:
        drawings = [d["rect"] for d in page.get_drawings() if d.get("fill") is not None or d.get("color") is not None]
    except Exception:
        drawings = []
    over_draw = any(target_bbox.intersects(fitz.Rect(r)) for r in drawings)
    report.background = {"overlaps_images": over_img, "overlaps_graphics": over_draw, "painted_over": False}
    if over_img:
        report.warn("over_image", "The text lies on an image. The image is kept unchanged; only the glyphs are replaced.", "safe")

    # ---- font plan
    new_text = req.new_text.replace("\r\n", "\n")
    bold = n_bold or bool(main.flags & 16) if req.bold is None else req.bold
    italic = n_italic or bool(main.flags & 2) if req.italic is None else req.italic
    font: LoadedFont | None = None
    plan_kind = quality = ""
    reason = ""
    style_changed = (req.bold is not None and req.bold != (n_bold or bool(main.flags & 16))) or (
        req.italic is not None and req.italic != (n_italic or bool(main.flags & 2)))
    if req.font_family:
        face = font_index.find(req.font_family, bold, italic)
        if not face:
            raise AppError("font_missing", f"The font '{req.font_family}' is not installed")
        font, plan_kind, quality = load_face(face), "user", "user"
    if font is None and not style_changed and new_text.strip():
        font, reason = reuse_original_font(doc, main.font_xref, new_text)
        if font is not None:
            plan_kind, quality = "original", "exact"
    if font is None and new_text.strip():
        face = font_index.find_exact_style(fam, bold, italic) or font_index.find(fam, bold, italic)
        if face:
            font, plan_kind, quality = load_face(face), "local", "exact"
        else:
            cands = font_index.match_pdf_font(main.font, bold, italic, needs_scripts=None)
            if cands:
                c = cands[0]
                f2 = font_index.by_id(c["face"]["id"])
                font, plan_kind, quality = load_face(f2), "substitute", c["quality"]
                if c["quality"] != "exact":
                    similar = "metric-compatible" in c.get("reason", "")
                    report.warn("font_substituted",
                                f"The original font '{fam}' cannot be used ({reason or 'not available'}). "
                                + (f"'{f2.family}' (metric-compatible: same character widths) will be used instead – "
                                   "the appearance may differ slightly." if similar else
                                   f"'{f2.family}' will be used instead – the text appearance may change."))
    if font is None and new_text.strip():
        face = font_index.for_script(scripts_in_text(new_text)[0] if scripts_in_text(new_text) else "latin", bold, italic)
        if not face:
            raise AppError("font_missing", "No usable font is installed on this computer")
        font, plan_kind, quality = load_face(face), "fallback", "fallback"
        report.warn("font_fallback", f"No similar font was found for '{fam}'. A generic font will be used.")
    if plan_kind == "local" and reason:
        report.warn("font_local", f"The embedded font cannot render the new text ({reason}); the installed font "
                    f"'{font.family}' with the same name is used.", "safe")

    # ---- style
    size = float(req.size or main.size)
    color = parse_color(req.color) if req.color else ((main.color >> 16 & 255) / 255, (main.color >> 8 & 255) / 255,
                                                       (main.color & 255) / 255)
    lh = req.line_height
    if lh is None:
        if len(lines) > 1:
            dists = [abs(lines[i + 1].spans[0].origin.y - lines[i].spans[0].origin.y) for i in range(len(lines) - 1)]
            lh = (sum(dists) / len(dists)) / max(main.size, 0.1)
        else:
            lh = 1.2
    align = req.align or _alignment(lines)
    style = None
    if font is not None:
        style = TextStyle(font=font, size=size, color=color or (0, 0, 0), bold=bold, italic=italic,
                          underline=req.underline, strike=req.strike, char_spacing=req.char_spacing,
                          line_height=lh, align=align, opacity=1.0)
        if bold and not font.bold:
            report.warn("synthetic_bold", "Bold is simulated because no bold version of the font is available.", "safe")

    # ---- layout geometry (PDF space)
    first = lines[0].spans[0]
    ox, oy = coords.to_pdf(first.origin.x, first.origin.y)
    dx, dy = (req.offset or [0, 0])[:2]
    ox, oy = ox + dx, oy + dy
    single = len(lines) == 1 and "\n" not in new_text and not req.box and align in ("left",)
    layout_kwargs: dict = {}
    if style is not None:
        fb = size * font.ascender / font.upem
        if single:
            layout_kwargs = {"max_width": None, "first_baseline": fb}
            # rotate about the baseline origin; local baseline is at y = -fb
            m = mat_translate(0, fb)
            if angle:
                m = mat_mul(m, mat_rotate_cw(angle))
            matrix = mat_mul(m, mat_translate(ox, oy))
            box_w = None
        else:
            if abs(angle) > 0.5:
                report.warn("rotated_paragraph", "Rotated multi-line text is laid out line by line.")
            box = req.box or coords.rect_to_pdf(target_bbox)
            bx0, by0, bx1, by1 = box
            bx0, bx1 = bx0 + dx, bx1 + dx
            by0, by1 = by0 + dy, by1 + dy
            box_w = max(4.0, bx1 - bx0)
            top = max(by0, by1)
            layout_kwargs = {"max_width": box_w, "first_baseline": max(0.0, top - oy)}
            matrix = mat_translate(bx0, top)
        lay = layout_text(new_text, style, **layout_kwargs)
        width = max((ln.width for ln in lay.lines), default=0)
        if req.fit == "shrink" and single:
            avail = _available_width(page, coords, lines[0], others, imgs)
            if width > avail > 1 and size > 2:
                factor = max(0.5, avail / width)
                style.size = size * factor
                report.warn("shrunk", f"The font size was reduced to {style.size:.1f} pt to fit the available space.", "safe")
                lay = layout_text(new_text, style, **{**layout_kwargs, "first_baseline": style.size * font.ascender / font.upem})
                if single:
                    m = mat_translate(0, style.size * font.ascender / font.upem)
                    if angle:
                        m = mat_mul(m, mat_rotate_cw(angle))
                    matrix = mat_mul(m, mat_translate(ox, oy))
                width = max((ln.width for ln in lay.lines), default=0)
        report.layout = {"lines": len(lay.lines), "width": round(width, 2), "single_line": single, "align": align,
                         "size": round(style.size, 2), "line_height": round(lh, 3), "fallback_fonts": lay.fallback_used}
        if lay.fallback_used:
            fams = ", ".join(f["family"] for f in lay.fallback_used)
            report.warn("glyph_fallback", f"Some characters are not available in the chosen font and use: {fams}.")
        if single and not angle:
            avail = _available_width(page, coords, lines[0], others, imgs)
            report.layout["available_width"] = round(avail, 2)
            if width > avail + 0.5:
                report.warn("overflow", "The new text is wider than the available space and may overlap neighbouring "
                            "content. Consider shortening it or using 'shrink to fit'.")
        elif not single:
            height = (lay.lines[-1].baseline + size * 0.3) if lay.lines else 0
            avail_h = max(by0, by1) - min(by0, by1) + size
            if height > avail_h + 1:
                report.warn("overflow", "The text needs more lines than the original paragraph and may overlap "
                            "content below it.")
        new_extent = fitz.Rect(target_bbox)
        # rough extent of the new text for previews (mupdf space)
        p0 = coords.to_mupdf(ox, oy)
        est = fitz.Rect(p0.x, p0.y - size * 1.2, p0.x + max(width, 1) + 4,
                        p0.y + (lay.lines[-1].baseline if lay.lines else size) + size * 0.4)
        if not single:
            bx = coords.rect_to_mupdf(req.box) if req.box else fitz.Rect(target_bbox)
            est = bx + (dx, -dy, dx, -dy)
            est.y1 = max(est.y1, est.y0 + (lay.lines[-1].baseline if lay.lines else 0) + size)
        region = (new_extent | est) + (-24, -24, 24, 24)
    else:
        matrix = mat_translate(0, 0)
        region = target_bbox + (-24, -24, 24, 24)
    report.font = {
        "original": main.font,
        "family": fam,
        "status": status,
        "plan": plan_kind or "none",
        "used": font.family if font is not None else None,
        "quality": quality,
        "reason": reason,
        "bold": bold,
        "italic": italic,
    }
    return Plan(report, lines, others, removal, style, layout_kwargs, matrix, region)


def _available_width(page: fitz.Page, coords: PageCoords, line: Line, others: list[Line], imgs: list[fitz.Rect]) -> float:
    """Horizontal room from the line start to the next obstacle on the right."""
    band = fitz.Rect(line.bbox)
    start = line.spans[0].origin.x
    limit = page.rect.x1 - 2
    for ln in others:
        r = ln.bbox
        if r.y1 > band.y0 + band.height * 0.25 and r.y0 < band.y1 - band.height * 0.25 and r.x0 > band.x1 - 1:
            limit = min(limit, r.x0 - 1)
    for r in imgs:
        if r.y1 > band.y0 and r.y0 < band.y1 and r.x0 > band.x1 and abs(r) < 0.5 * abs(page.rect):
            limit = min(limit, r.x0 - 1)
    return max(0.0, limit - start)


def execute_edit(doc: fitz.Document, req: EditRequest, plan: Plan | None = None) -> tuple[bytes, Plan]:
    """Apply the edit to ``doc`` (modified in place) and return the final PDF bytes."""
    plan = plan or plan_edit(doc, req)
    if plan.report.level == "unsupported":
        raise AppError("edit_unsupported", plan.report.warnings[-1]["message"], status=422,
                       details=plan.report.to_dict())
    page = doc[req.page]
    for r in plan.removal:
        page.add_redact_annot(r, fill=False, cross_out=False)
    if plan.removal:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                              text=fitz.PDF_REDACT_TEXT_REMOVE)
    data = doc.tobytes(garbage=0, deflate=True)
    if plan.style is None or not req.new_text.strip():
        return data, plan
    with pikepdf.open(io.BytesIO(data)) as pdf:
        ws = WriterSession(pdf)
        lay = layout_text(req.new_text.replace("\r\n", "\n"), plan.style, **{**plan.layout_kwargs,
                                                                            "first_baseline": plan.layout_kwargs.get("first_baseline")})
        ws.page(req.page).text_layout(lay, plan.style, plan.matrix)
        ws.commit()
        out = io.BytesIO()
        pdf.save(out)
    return out.getvalue(), plan


def verify(result: bytes, req: EditRequest, plan: Plan) -> dict:
    doc = fitz.open(stream=result, filetype="pdf")
    page = doc[req.page]
    text = _norm_text(page.get_text())
    old = _norm_text("".join(ln.text for ln in plan.lines))
    new = _norm_text(req.new_text)
    new_ok = new in text if new else True
    old_gone = True
    if old and old not in new and new_ok:
        # old text must not remain (count occurrences before/after)
        old_gone = text.count(old) <= sum(1 for ln in plan.others if old in _norm_text(ln.text))
    missing_others = [ln.text.strip() for ln in plan.others if _norm_text(ln.text) and _norm_text(ln.text) not in text]
    ok = new_ok and old_gone and not missing_others
    return {"ok": ok, "new_text_found": new_ok, "old_text_removed": old_gone, "damaged_lines": missing_others[:5]}


def preview(doc: fitz.Document, req: EditRequest) -> dict:
    """Edit a single-page copy and return before/after images and the report."""
    single = fitz.open()
    single.insert_pdf(doc, from_page=req.page, to_page=req.page)
    sreq = EditRequest(**{**req.__dict__, "page": 0})
    plan = plan_edit(single, sreq)
    before = _png(single[0], plan.region)
    if plan.report.level == "unsupported":
        return {"report": plan.report.to_dict(), "before": before, "after": None}
    result, plan = execute_edit(single, sreq, plan)
    plan.report.verification = verify(result, sreq, plan)
    after_doc = fitz.open(stream=result, filetype="pdf")
    return {"report": plan.report.to_dict(), "before": before, "after": _png(after_doc[0], plan.region)}


def apply(src_doc: fitz.Document, req: EditRequest) -> tuple[bytes, dict]:
    result, plan = execute_edit(src_doc, req)
    plan.report.verification = verify(result, req, plan)
    if not plan.report.verification["ok"]:
        raise AppError("verification_failed", "The edit could not be verified; nothing was changed.",
                       details=plan.report.to_dict())
    return result, plan.report.to_dict()
