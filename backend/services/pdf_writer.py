"""Low level PDF content writer built on pikepdf.

Provides:

* :class:`FontEmbedder` – embeds a TrueType font as Type0/CIDFontType2 with a
  per-occurrence CID scheme. Each (glyph, unicode text) pair gets its own CID
  mapped to the glyph through a ``CIDToGIDMap`` stream, so the ``ToUnicode``
  CMap is always correct – even for shaped Thai where one character produces
  several glyphs (SARA AM) or alternate mark glyphs are substituted.
* :class:`PageWriter` – collects content operators and resources for one page
  and appends/prepends them safely (existing content is wrapped in q/Q).
* Helpers for text layouts, shapes, images and opacity.
"""
from __future__ import annotations

import io
import math
import random
import string
import zlib
from dataclasses import dataclass, field

import pikepdf
from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont
from PIL import Image
from pikepdf import Array, Dictionary, Name

from services.text_layout import LayoutResult, LoadedFont, TextStyle, apply_justify

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
ITALIC_SKEW = math.tan(math.radians(12))


def mat_mul(m1: Matrix, m2: Matrix) -> Matrix:
    """Return m1 x m2 (apply m1 first, then m2) in PDF row-vector convention."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2)


def mat_translate(tx: float, ty: float) -> Matrix:
    return (1.0, 0.0, 0.0, 1.0, tx, ty)


def mat_rotate_cw(deg: float) -> Matrix:
    """Clockwise rotation (as seen on screen) in y-up PDF space."""
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return (c, -s, s, c, 0.0, 0.0)


def box_matrix(rect: list[float], rotation: float = 0.0) -> Matrix:
    """Matrix mapping a box-local frame (origin top-left, x right, y up => content
    inside the box has negative y) to PDF user space, rotated clockwise about
    the box centre. ``rect`` = [x0, y0, x1, y1] in PDF space (y up)."""
    x0, y0, x1, y1 = rect
    m = mat_translate(min(x0, x1), max(y0, y1))
    if rotation:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        m = mat_mul(m, mat_translate(-cx, -cy))
        m = mat_mul(m, mat_rotate_cw(rotation))
        m = mat_mul(m, mat_translate(cx, cy))
    return m


def fmt(v: float) -> str:
    if abs(v) < 1e-6:
        return "0"
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def fmt_m(m: Matrix) -> str:
    return " ".join(fmt(v) for v in m)


def color_ops(rgb, stroke: bool = False) -> str:
    r, g, b = (max(0.0, min(1.0, float(c))) for c in rgb)
    return f"{fmt(r)} {fmt(g)} {fmt(b)} {'RG' if stroke else 'rg'}"


def parse_color(value) -> tuple[float, float, float] | None:
    """Accept '#rrggbb', [r,g,b] (0..1) or None/'transparent'."""
    if value is None or value == "" or value == "transparent":
        return None
    if isinstance(value, str):
        v = value.lstrip("#")
        if len(v) == 3:
            v = "".join(ch * 2 for ch in v)
        return (int(v[0:2], 16) / 255, int(v[2:4], 16) / 255, int(v[4:6], 16) / 255)
    vals = list(value)[:3]
    if any(c > 1 for c in vals):
        return tuple(c / 255 for c in vals)  # type: ignore[return-value]
    return tuple(float(c) for c in vals)  # type: ignore[return-value]


def utf16_hex(text: str) -> str:
    return "FEFF" + text.encode("utf-16-be").hex().upper()


def _subset_tag() -> str:
    return "".join(random.choices(string.ascii_uppercase, k=6))


# ----------------------------------------------------------------------
# Font embedding
# ----------------------------------------------------------------------


class FontEmbedder:
    def __init__(self, pdf: pikepdf.Pdf, font: LoadedFont):
        self.pdf = pdf
        self.font = font
        self.cid_map: dict[tuple[int, str], int] = {}
        self.gids: list[int] = [0]
        self.texts: list[str] = [""]
        self.obj = pdf.make_indirect(Dictionary(Type=Name.Font))
        self.finalized = False

    def cid(self, gid: int, text: str) -> int:
        key = (gid, text)
        c = self.cid_map.get(key)
        if c is None:
            c = len(self.gids)
            if c > 0xFFFF:
                raise ValueError("Too many glyphs for one font")
            self.cid_map[key] = c
            self.gids.append(gid)
            self.texts.append(text)
        return c

    def _subset_program(self) -> bytes:
        used = sorted(set(self.gids) | {0})
        tt = TTFont(io.BytesIO(self.font.data))
        opts = ft_subset.Options()
        opts.retain_gids = True
        opts.notdef_outline = True
        opts.layout_features = []
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
        opts.drop_tables += ["GSUB", "GPOS", "GDEF", "BASE", "JSTF", "DSIG", "MATH", "kern", "morx", "feat",
                             "COLR", "CPAL", "SVG ", "sbix", "CBDT", "CBLC", "EBDT", "EBLC", "STAT", "fvar",
                             "gvar", "avar", "HVAR", "MVAR"]
        opts.glyph_names = False
        opts.recalc_bounds = False
        sub = ft_subset.Subsetter(options=opts)
        sub.populate(gids=used)
        sub.subset(tt)
        buf = io.BytesIO()
        tt.save(buf)
        return buf.getvalue()

    def finalize(self) -> None:
        if self.finalized:
            return
        self.finalized = True
        f = self.font
        k = 1000.0 / f.upem
        program = self._subset_program()
        tag = _subset_tag()
        base_name = Name("/" + f"{tag}+{f.postscript}")
        font_file = self.pdf.make_stream(program)
        font_file[Name.Length1] = len(program)
        x0, y0, x1, y1 = f.bbox
        flags = 4  # symbolic (CID font with Identity encoding)
        if f.italic_angle:
            flags |= 64
        descriptor = self.pdf.make_indirect(Dictionary(
            Type=Name.FontDescriptor,
            FontName=base_name,
            Flags=flags,
            FontBBox=Array([round(x0 * k), round(y0 * k), round(x1 * k), round(y1 * k)]),
            ItalicAngle=float(f.italic_angle),
            Ascent=round(f.ascender * k),
            Descent=round(f.descender * k),
            CapHeight=round(f.cap_height * k),
            StemV=120 if f.bold else 80,
            FontFile2=font_file,
        ))
        # CID -> GID map
        cid2gid = bytearray()
        for gid in self.gids:
            cid2gid += bytes(((gid >> 8) & 0xFF, gid & 0xFF))
        cid2gid_stream = self.pdf.make_stream(zlib.compress(bytes(cid2gid)))
        cid2gid_stream[Name.Filter] = Name.FlateDecode
        # widths
        w_items: list = []
        for cid in range(1, len(self.gids)):
            w_items.append(cid)
            w_items.append(Array([round(f.advance(self.gids[cid]) * k)]))
        cidfont = self.pdf.make_indirect(Dictionary(
            Type=Name.Font,
            Subtype=Name.CIDFontType2,
            BaseFont=base_name,
            CIDSystemInfo=Dictionary(Registry=pikepdf.String("Adobe"), Ordering=pikepdf.String("Identity"),
                                     Supplement=0),
            FontDescriptor=descriptor,
            DW=1000,
            W=Array(w_items),
            CIDToGIDMap=cid2gid_stream,
        ))
        tounicode = self.pdf.make_stream(self._tounicode())
        self.obj.Subtype = Name.Type0
        self.obj.BaseFont = base_name
        self.obj.Encoding = Name("/Identity-H")
        self.obj.DescendantFonts = Array([cidfont])
        self.obj.ToUnicode = tounicode

    def _tounicode(self) -> bytes:
        entries = [(cid, t) for cid, t in enumerate(self.texts) if cid and t]
        lines = [
            "/CIDInit /ProcSet findresource begin",
            "12 dict begin",
            "begincmap",
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
            "/CMapName /Adobe-Identity-UCS def",
            "/CMapType 2 def",
            "1 begincodespacerange",
            "<0000> <FFFF>",
            "endcodespacerange",
        ]
        for i in range(0, len(entries), 100):
            chunk = entries[i:i + 100]
            lines.append(f"{len(chunk)} beginbfchar")
            for cid, t in chunk:
                lines.append(f"<{cid:04X}> <{t.encode('utf-16-be').hex().upper()}>")
            lines.append("endbfchar")
        lines += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
        return "\n".join(lines).encode("ascii")


# ----------------------------------------------------------------------
# Resources registry (per output PDF)
# ----------------------------------------------------------------------


class Resources:
    def __init__(self, pdf: pikepdf.Pdf):
        self.pdf = pdf
        self.fonts: dict[str, FontEmbedder] = {}
        self.gstates: dict[tuple[float, float], pikepdf.Object] = {}

    def font(self, font: LoadedFont) -> FontEmbedder:
        fe = self.fonts.get(font.key)
        if fe is None:
            fe = FontEmbedder(self.pdf, font)
            self.fonts[font.key] = fe
        return fe

    def gstate(self, fill_alpha: float = 1.0, stroke_alpha: float = 1.0) -> pikepdf.Object:
        key = (round(fill_alpha, 3), round(stroke_alpha, 3))
        gs = self.gstates.get(key)
        if gs is None:
            gs = self.pdf.make_indirect(Dictionary(Type=Name.ExtGState, ca=key[0], CA=key[1]))
            self.gstates[key] = gs
        return gs

    def finalize(self) -> None:
        for fe in self.fonts.values():
            fe.finalize()


def ensure_page_resources(page_obj: pikepdf.Dictionary) -> pikepdf.Dictionary:
    """Make sure the page has its own /Resources (copy inherited ones)."""
    if Name.Resources in page_obj:
        res = page_obj.Resources
        return res
    node = page_obj.get(Name.Parent)
    inherited = None
    while node is not None:
        if Name.Resources in node:
            inherited = node.Resources
            break
        node = node.get(Name.Parent)
    res = Dictionary()
    if inherited is not None:
        for k, v in inherited.items():
            res[k] = v
    page_obj.Resources = res
    return page_obj.Resources


class PageWriter:
    """Accumulates content for one page."""

    def __init__(self, pdf: pikepdf.Pdf, page: pikepdf.Page, resources: Resources):
        self.pdf = pdf
        self.page = page
        self.res = resources
        self.ops: list[str] = []
        self._names: dict[tuple[str, int], str] = {}
        self._pending: list[tuple[str, str, pikepdf.Object]] = []
        page_res = ensure_page_resources(page.obj)
        self._existing: set[str] = set()
        for cat in ("/Font", "/XObject", "/ExtGState", "/Properties"):
            if cat in page_res:
                self._existing.update(str(k) for k in page_res[cat].keys())
        self._counter = 0

    def _name(self, cat: str, obj: pikepdf.Object) -> str:
        key = (cat, obj.objgen[0] if obj.is_indirect else id(obj))
        n = self._names.get(key)
        if n:
            return n
        prefix = {"/Font": "PEdF", "/XObject": "PEdX", "/ExtGState": "PEdG", "/Properties": "PEdP"}[cat]
        while True:
            self._counter += 1
            n = f"{prefix}{self._counter}"
            if "/" + n not in self._existing:
                break
        self._names[key] = n
        self._pending.append((cat, n, obj))
        return n

    # -- primitives ------------------------------------------------------
    def op(self, s: str) -> None:
        self.ops.append(s)

    def gstate(self, fill_alpha: float = 1.0, stroke_alpha: float = 1.0) -> None:
        if fill_alpha < 0.999 or stroke_alpha < 0.999:
            n = self._name("/ExtGState", self.res.gstate(fill_alpha, stroke_alpha))
            self.op(f"/{n} gs")

    def begin_marked(self, tag: str, props: str | None = None) -> None:
        self.op(f"/{tag} {props} BDC" if props else f"/{tag} BMC")

    def begin_oc(self, ocg: pikepdf.Object) -> None:
        n = self._name("/Properties", ocg)
        self.op(f"/OC /{n} BDC")

    def end_marked(self) -> None:
        self.op("EMC")

    # -- text --------------------------------------------------------------
    def text_layout(self, layout: LayoutResult, style: TextStyle, matrix: Matrix) -> None:
        """Draw a layout. ``matrix`` maps box-local (y up; baselines at -baseline) to PDF space."""
        self.op("q")
        self.op(f"{fmt_m(matrix)} cm")
        self.gstate(style.opacity, style.opacity)
        self.op(color_ops(style.color))
        if style.synthetic_bold:
            self.op(color_ops(style.color, stroke=True))
            self.op(f"{fmt(style.size * 0.03)} w 1 j")
        self.op("BT")
        if style.invisible:
            self.op("3 Tr")
        elif style.synthetic_bold:
            self.op("2 Tr")
        skew = ITALIC_SKEW if style.synthetic_italic else 0.0
        current_font = None
        for line in layout.lines:
            apply_justify(line)
            glyphs = sorted(line.glyphs, key=lambda g: g.order)
            in_span: int | None = None
            for g in glyphs:
                fe = self.res.font(g.font)
                if current_font is not fe:
                    self.op(f"/{self._name('/Font', fe.obj)} {fmt(style.size)} Tf")
                    current_font = fe
                if g.multi:
                    if in_span is not None and in_span != g.cluster:
                        self.op("EMC")
                        in_span = None
                    if in_span is None:
                        self.op(f"/Span <</ActualText <{utf16_hex(g.cluster_text)}>>> BDC")
                        in_span = g.cluster
                elif in_span is not None:
                    self.op("EMC")
                    in_span = None
                cid = fe.cid(g.gid, g.text)
                x = line.x + g.x
                y = -line.baseline + g.y
                self.op(f"1 0 {fmt(skew)} 1 {fmt(x)} {fmt(y)} Tm <{cid:04X}> Tj")
            if in_span is not None:
                self.op("EMC")
        self.op("ET")
        # decorations
        if style.invisible:
            self.op("Q")
            return
        f = style.font
        k = style.size / f.upem
        for line in layout.lines:
            if not line.text.strip():
                continue
            if style.underline:
                y = -line.baseline + f.underline_pos * k
                th = max(f.underline_thickness * k, 0.5)
                self.op(f"{fmt(line.x)} {fmt(y - th / 2)} {fmt(line.width)} {fmt(th)} re f")
            if style.strike:
                y = -line.baseline + f.strike_pos * k
                th = max(f.strike_size * k, 0.5)
                self.op(f"{fmt(line.x)} {fmt(y - th / 2)} {fmt(line.width)} {fmt(th)} re f")
        self.op("Q")

    # -- shapes ------------------------------------------------------------
    def shape(self, kind: str, w: float, h: float, matrix: Matrix, *, stroke=None, fill=None,
              line_width: float = 1.0, opacity: float = 1.0, fill_opacity: float | None = None,
              dash: list[float] | None = None, points: list[list[float]] | None = None,
              arrow_start: bool = False, arrow_end: bool = False) -> None:
        """Draw a shape in a box-local frame (origin top-left, y up, box spans (0,0)-(w,-h))."""
        if stroke is None and fill is None:
            return
        self.op("q")
        self.op(f"{fmt_m(matrix)} cm")
        fa = opacity if fill_opacity is None else fill_opacity
        self.gstate(fa, opacity)
        if stroke is not None:
            self.op(color_ops(stroke, stroke=True))
            self.op(f"{fmt(line_width)} w")
            if dash:
                self.op(f"[{' '.join(fmt(d) for d in dash)}] 0 d")
        if fill is not None:
            self.op(color_ops(fill))
        paint = "B" if (stroke is not None and fill is not None) else ("S" if stroke is not None else "f")
        if kind == "rect":
            inset = line_width / 2 if stroke is not None else 0
            self.op(f"{fmt(inset)} {fmt(-h + inset)} {fmt(max(w - 2 * inset, 0))} {fmt(max(h - 2 * inset, 0))} re {paint}")
        elif kind in ("ellipse", "circle"):
            self.op(_ellipse_path(w / 2, -h / 2, w / 2 - (line_width / 2 if stroke is not None else 0),
                                  h / 2 - (line_width / 2 if stroke is not None else 0)) + f" {paint}")
        elif kind in ("line", "arrow"):
            pts = points or [[0, -h / 2], [w, -h / 2]]
            (ax, ay), (bx, by) = pts[0], pts[-1]
            self.op("1 J" if not dash else "0 J")
            self.op(f"{fmt(ax)} {fmt(ay)} m {fmt(bx)} {fmt(by)} l S")
            if kind == "arrow" or arrow_end:
                self._arrow_head(ax, ay, bx, by, line_width, stroke)
            if arrow_start:
                self._arrow_head(bx, by, ax, ay, line_width, stroke)
        elif kind == "polygon" and points:
            path = f"{fmt(points[0][0])} {fmt(points[0][1])} m " + " ".join(
                f"{fmt(px)} {fmt(py)} l" for px, py in points[1:])
            self.op(path + f" h {paint}")
        self.op("Q")

    def _arrow_head(self, ax, ay, bx, by, lw, stroke) -> None:
        ang = math.atan2(by - ay, bx - ax)
        size = max(6.0, lw * 4)
        spread = math.radians(25)
        p1 = (bx - size * math.cos(ang - spread), by - size * math.sin(ang - spread))
        p2 = (bx - size * math.cos(ang + spread), by - size * math.sin(ang + spread))
        if stroke is not None:
            self.op(color_ops(stroke))
        self.op(f"{fmt(bx)} {fmt(by)} m {fmt(p1[0])} {fmt(p1[1])} l {fmt(p2[0])} {fmt(p2[1])} l h f")

    # -- images ------------------------------------------------------------
    def image(self, xobj: pikepdf.Object, w: float, h: float, matrix: Matrix, opacity: float = 1.0) -> None:
        n = self._name("/XObject", xobj)
        self.op("q")
        self.op(f"{fmt_m(matrix)} cm")
        self.gstate(opacity, opacity)
        # image space is the unit square; box local frame spans (0,-h)-(w,0)
        self.op(f"{fmt(w)} 0 0 {fmt(h)} 0 {fmt(-h)} cm /{n} Do")
        self.op("Q")

    # -- commit --------------------------------------------------------------
    def commit(self, overlay: bool = True) -> None:
        if not self.ops:
            return
        page_res = ensure_page_resources(self.page.obj)
        for cat, n, obj in self._pending:
            if cat not in page_res:
                page_res[cat] = Dictionary()
            page_res[cat][Name("/" + n)] = obj
        body = ("\n".join(self.ops)).encode("latin-1")
        content = b"q\n" + body + b"\nQ\n"
        stream = self.pdf.make_stream(zlib.compress(content))
        stream[Name.Filter] = Name.FlateDecode
        if overlay:
            # isolate existing content so its graphics state cannot leak into ours
            self.page.contents_add(self.pdf.make_stream(b"q\n"), prepend=True)
            self.page.contents_add(self.pdf.make_stream(b"\nQ\n"), prepend=False)
            self.page.contents_add(stream, prepend=False)
        else:
            self.page.contents_add(stream, prepend=True)
        self.ops = []
        self._pending = []


def _ellipse_path(cx: float, cy: float, rx: float, ry: float) -> str:
    k = 0.5522847498
    ox, oy = rx * k, ry * k
    return (f"{fmt(cx + rx)} {fmt(cy)} m "
            f"{fmt(cx + rx)} {fmt(cy + oy)} {fmt(cx + ox)} {fmt(cy + ry)} {fmt(cx)} {fmt(cy + ry)} c "
            f"{fmt(cx - ox)} {fmt(cy + ry)} {fmt(cx - rx)} {fmt(cy + oy)} {fmt(cx - rx)} {fmt(cy)} c "
            f"{fmt(cx - rx)} {fmt(cy - oy)} {fmt(cx - ox)} {fmt(cy - ry)} {fmt(cx)} {fmt(cy - ry)} c "
            f"{fmt(cx + ox)} {fmt(cy - ry)} {fmt(cx + rx)} {fmt(cy - oy)} {fmt(cx + rx)} {fmt(cy)} c h")


# ----------------------------------------------------------------------
# Images
# ----------------------------------------------------------------------


@dataclass
class ImageInfo:
    xobj: pikepdf.Object
    width: int
    height: int


def make_image_xobject(pdf: pikepdf.Pdf, data: bytes, crop: list[float] | None = None,
                       flip_h: bool = False, flip_v: bool = False) -> ImageInfo:
    """Create an image XObject. ``crop`` = [left, top, right, bottom] fractions
    to physically remove (cropped pixels are not kept in the file)."""
    im = Image.open(io.BytesIO(data))
    im.load()
    fmt_name = (im.format or "").upper()
    needs_edit = bool(crop and any(c > 0 for c in crop)) or flip_h or flip_v
    if getattr(im, "n_frames", 1) > 1:
        im.seek(0)
    if fmt_name == "JPEG" and not needs_edit and im.mode in ("L", "RGB", "CMYK"):
        cs = {"L": Name.DeviceGray, "RGB": Name.DeviceRGB, "CMYK": Name.DeviceCMYK}[im.mode]
        st = pikepdf.Stream(pdf, data)
        st.Type = Name.XObject
        st.Subtype = Name.Image
        st.Width, st.Height = im.size
        st.ColorSpace = cs
        st.BitsPerComponent = 8
        st.Filter = Name.DCTDecode
        if im.mode == "CMYK" and "adobe" in im.info:
            st.Decode = Array([1, 0, 1, 0, 1, 0, 1, 0])
        return ImageInfo(pdf.make_indirect(st), im.size[0], im.size[1])
    if im.mode == "P":
        im = im.convert("RGBA" if "transparency" in im.info else "RGB")
    if im.mode in ("LA", "PA"):
        im = im.convert("RGBA")
    if im.mode not in ("L", "RGB", "RGBA", "CMYK"):
        im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
    if crop and any(c > 0 for c in crop):
        l, t, r, b = crop
        W, H = im.size
        box = (int(round(W * l)), int(round(H * t)), int(round(W * (1 - r))), int(round(H * (1 - b))))
        if box[2] - box[0] >= 1 and box[3] - box[1] >= 1:
            im = im.crop(box)
    if flip_h:
        im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if flip_v:
        im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    smask = None
    if im.mode == "RGBA":
        alpha = im.getchannel("A")
        if alpha.getextrema() != (255, 255):
            sm = pikepdf.Stream(pdf, zlib.compress(alpha.tobytes()))
            sm.Type = Name.XObject
            sm.Subtype = Name.Image
            sm.Width, sm.Height = im.size
            sm.ColorSpace = Name.DeviceGray
            sm.BitsPerComponent = 8
            sm.Filter = Name.FlateDecode
            smask = pdf.make_indirect(sm)
        im = im.convert("RGB")
    if fmt_name == "JPEG" and im.mode in ("RGB", "L") and smask is None:
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=92)
        st = pikepdf.Stream(pdf, buf.getvalue())
        st.Filter = Name.DCTDecode
    else:
        st = pikepdf.Stream(pdf, zlib.compress(im.tobytes()))
        st.Filter = Name.FlateDecode
    st.Type = Name.XObject
    st.Subtype = Name.Image
    st.Width, st.Height = im.size
    st.ColorSpace = {"L": Name.DeviceGray, "RGB": Name.DeviceRGB, "CMYK": Name.DeviceCMYK}[im.mode]
    st.BitsPerComponent = 8
    if smask is not None:
        st.SMask = smask
    return ImageInfo(pdf.make_indirect(st), im.size[0], im.size[1])


@dataclass
class WriterSession:
    """Convenience wrapper: one pikepdf document, shared resources, per-page writers."""

    pdf: pikepdf.Pdf
    resources: Resources = field(init=False)
    writers: dict[tuple[int, bool], PageWriter] = field(default_factory=dict)

    def __post_init__(self):
        self.resources = Resources(self.pdf)

    def page(self, index: int, overlay: bool = True) -> PageWriter:
        key = (index, overlay)
        w = self.writers.get(key)
        if w is None:
            w = PageWriter(self.pdf, self.pdf.pages[index], self.resources)
            self.writers[key] = w
        return w

    def commit(self) -> None:
        for (_idx, overlay), w in self.writers.items():
            w.commit(overlay=overlay)
        self.resources.finalize()


class XObjectWriter(PageWriter):
    """Like PageWriter, but produces a Form XObject (e.g. a widget appearance).

    Coordinates are XObject space: origin bottom-left of ``bbox``.
    """

    def __init__(self, pdf: pikepdf.Pdf, resources: Resources, bbox: tuple[float, float, float, float]):
        # deliberately not calling PageWriter.__init__: there is no page
        self.pdf = pdf
        self.page = None
        self.res = resources
        self.ops = []
        self._names = {}
        self._pending = []
        self._existing = set()
        self._counter = 0
        self.bbox = bbox

    def build(self, marked_tx: bool = False) -> pikepdf.Stream:
        res = Dictionary()
        for cat, n, obj in self._pending:
            if cat not in res:
                res[cat] = Dictionary()
            res[cat][Name("/" + n)] = obj
        body = "\n".join(self.ops)
        if marked_tx:  # variable text of form fields is wrapped in /Tx BMC … EMC
            body = f"/Tx BMC\nq\n{body}\nQ\nEMC"
        stream = self.pdf.make_stream(zlib.compress(body.encode("latin-1")))
        stream[Name.Filter] = Name.FlateDecode
        stream[Name.Type] = Name.XObject
        stream[Name.Subtype] = Name.Form
        stream[Name.BBox] = pikepdf.Array([float(v) for v in self.bbox])
        stream[Name.Resources] = res
        return stream

    def commit(self, overlay: bool = True) -> None:  # pragma: no cover - not applicable
        raise TypeError("XObjectWriter has no page; use build()")
