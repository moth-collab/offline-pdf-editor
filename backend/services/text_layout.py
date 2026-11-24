"""Text shaping and layout engine.

* Shaping uses HarfBuzz (uharfbuzz) so complex scripts such as Thai get
  correct mark positioning (tone marks, upper/lower vowels, SARA AM).
* Characters a font cannot render fall back to a script-appropriate local
  font; fallbacks are reported so the UI can warn the user.
* Lines are broken at spaces; Thai (written without spaces) is broken at
  syllable-like cluster boundaries when a word does not fit, never inside a
  grapheme cluster (base + marks).

All metrics returned are in points. Layout coordinates are box-local: x to
the right, y *downwards* from the top of the box, baselines given per line.
"""
from __future__ import annotations

import io
import threading
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass, field

import uharfbuzz as hb
from fontTools.ttLib import TTFont

from services.fonts import FontFace, font_index, script_of_char

# ----------------------------------------------------------------------
# Font loading
# ----------------------------------------------------------------------


def _otf_to_ttf(tt: TTFont) -> None:
    """Convert CFF outlines to TrueType quadratic outlines in place."""
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import newTable

    glyph_order = tt.getGlyphOrder()
    glyph_set = tt.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyf.glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        try:
            glyph_set[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
            glyf[name] = pen.glyph()
        except Exception:
            glyf[name] = TTGlyphPen(glyph_set).glyph()
    tt["loca"] = newTable("loca")
    tt["glyf"] = glyf
    for tag in ("CFF ", "CFF2", "VORG"):
        if tag in tt:
            del tt[tag]
    maxp = tt["maxp"]
    maxp.tableVersion = 0x00010000
    for attr, val in (("maxZones", 1), ("maxTwilightPoints", 0), ("maxStorage", 0), ("maxFunctionDefs", 0),
                      ("maxInstructionDefs", 0), ("maxStackElements", 0), ("maxSizeOfInstructions", 0),
                      ("maxComponentElements", 0), ("maxPoints", 0), ("maxContours", 0),
                      ("maxCompositePoints", 0), ("maxCompositeContours", 0), ("maxComponentDepth", 0)):
        setattr(maxp, attr, val)
    tt["head"].glyphDataFormat = 0
    if "post" in tt:
        tt["post"].formatType = 3.0
    tt.sfntVersion = "\x00\x01\x00\x00"


class LoadedFont:
    """A font program ready for shaping, measuring and PDF embedding."""

    def __init__(self, key: str, data: bytes, index: int = 0, family: str = "", bold: bool = False,
                 italic: bool = False):
        self.key = key
        self.family = family
        self.bold = bold
        self.italic = italic
        tt = TTFont(io.BytesIO(data), fontNumber=index, lazy=False)
        if "glyf" not in tt and ("CFF " in tt or "CFF2" in tt):
            _otf_to_ttf(tt)
            buf = io.BytesIO()
            tt.save(buf)
            data = buf.getvalue()
            index = 0
            tt = TTFont(io.BytesIO(data))
        elif index:
            # extract the single face from a collection for embedding
            buf = io.BytesIO()
            tt.save(buf)
            data = buf.getvalue()
            index = 0
            tt = TTFont(io.BytesIO(data))
        self.data = data
        self.tt = tt
        self.hb_face = hb.Face(hb.Blob(data), index)
        self.hb_font = hb.Font(self.hb_face)
        head = tt["head"]
        self.upem = head.unitsPerEm
        hhea = tt["hhea"]
        os2 = tt["OS/2"] if "OS/2" in tt else None
        self.ascender = (getattr(os2, "sTypoAscender", 0) or hhea.ascent) if os2 else hhea.ascent
        self.descender = (getattr(os2, "sTypoDescender", 0) or hhea.descent) if os2 else hhea.descent
        if os2 and getattr(os2, "usWinAscent", 0):
            # Windows metrics give the safest bounding values for Thai fonts
            self.ascender = max(self.ascender, os2.usWinAscent)
            self.descender = min(self.descender, -abs(os2.usWinDescent))
        self.cap_height = getattr(os2, "sCapHeight", 0) or int(self.ascender * 0.7)
        post = tt["post"] if "post" in tt else None
        self.underline_pos = getattr(post, "underlinePosition", -self.upem * 0.1) or -self.upem * 0.1
        self.underline_thickness = getattr(post, "underlineThickness", self.upem * 0.05) or self.upem * 0.05
        self.strike_pos = getattr(os2, "yStrikeoutPosition", 0) or self.upem * 0.3
        self.strike_size = getattr(os2, "yStrikeoutSize", 0) or self.underline_thickness
        self.italic_angle = getattr(post, "italicAngle", 0) or 0
        self.bbox = (head.xMin, head.yMin, head.xMax, head.yMax)
        self.cmap = tt.getBestCmap() or {}
        self.hmtx = tt["hmtx"].metrics
        self.glyph_order = tt.getGlyphOrder()
        self.num_glyphs = len(self.glyph_order)
        ps = (tt["name"].getDebugName(6) if "name" in tt else None) or (family or "Font").replace(" ", "")
        self.postscript = "".join(ch for ch in ps if ch.isalnum() or ch in "-_") or "Font"
        self.reverse_cmap: dict[int, int] = {}
        for cp, gname in self.cmap.items():
            gid = tt.getGlyphID(gname)
            # prefer the lowest code point for a glyph (e.g. U+0020 over U+00A0)
            if gid not in self.reverse_cmap or cp < self.reverse_cmap[gid]:
                self.reverse_cmap[gid] = cp

    def has_char(self, ch: str) -> bool:
        cp = ord(ch)
        if cp in self.cmap:
            return True
        cat = unicodedata.category(ch)
        # format/control characters (ZWSP, ZWJ...) never need a glyph
        return cat in ("Cf", "Cc")

    def advance(self, gid: int) -> int:
        name = self.glyph_order[gid] if gid < self.num_glyphs else ".notdef"
        return self.hmtx.get(name, (self.upem // 2, 0))[0]

    def gid_for(self, ch: str) -> int:
        g = self.cmap.get(ord(ch))
        return self.tt.getGlyphID(g) if g else 0


_cache: "OrderedDict[str, LoadedFont]" = OrderedDict()
_cache_lock = threading.Lock()
MAX_CACHED_FONTS = 24


def load_face(face: FontFace) -> LoadedFont:
    with _cache_lock:
        lf = _cache.get(face.id)
        if lf:
            _cache.move_to_end(face.id)
            return lf
    with open(face.path, "rb") as fh:
        data = fh.read()
    lf = LoadedFont(face.id, data, face.index, face.family, face.bold, face.italic)
    with _cache_lock:
        _cache[face.id] = lf
        while len(_cache) > MAX_CACHED_FONTS:
            _cache.popitem(last=False)
    return lf


def load_buffer(key: str, data: bytes, family: str = "") -> LoadedFont:
    with _cache_lock:
        lf = _cache.get(key)
        if lf:
            return lf
    lf = LoadedFont(key, data, 0, family)
    with _cache_lock:
        _cache[key] = lf
    return lf


# ----------------------------------------------------------------------
# Data structures
# ----------------------------------------------------------------------


@dataclass
class TextStyle:
    font: LoadedFont
    size: float = 12.0
    color: tuple[float, float, float] = (0.0, 0.0, 0.0)
    bold: bool = False  # requested style
    italic: bool = False
    underline: bool = False
    strike: bool = False
    char_spacing: float = 0.0  # extra points after each cluster
    line_height: float = 1.2  # multiple of font size (baseline to baseline)
    align: str = "left"  # left | center | right | justify
    opacity: float = 1.0
    invisible: bool = False  # render mode 3 (searchable OCR text layers)
    fallbacks: list[LoadedFont] = field(default_factory=list)

    @property
    def synthetic_bold(self) -> bool:
        return self.bold and not self.font.bold

    @property
    def synthetic_italic(self) -> bool:
        return self.italic and not self.font.italic


@dataclass
class PlacedGlyph:
    font: LoadedFont
    gid: int
    x: float  # pt, relative to line start (pen position + offset)
    y: float  # pt, upward offset relative to baseline (marks)
    text: str  # unicode text attributed to this glyph occurrence
    cluster_text: str  # full text of its cluster
    multi: bool  # cluster consists of multiple glyphs with non-trivial mapping
    order: int  # emission order key
    cluster: int = 0  # char index of the cluster in the line text


@dataclass
class LayoutLine:
    glyphs: list[PlacedGlyph]
    width: float
    text: str
    x: float = 0.0  # left offset inside the box (alignment)
    baseline: float = 0.0  # distance from the box top (downwards)
    space_stretch: float = 0.0  # justify: extra pt per space
    ascent: float = 0.0
    descent: float = 0.0


@dataclass
class LayoutResult:
    lines: list[LayoutLine]
    width: float
    height: float
    fonts_used: list[str]
    fallback_used: list[dict]


# ----------------------------------------------------------------------
# Itemisation & shaping
# ----------------------------------------------------------------------


def _is_mark(ch: str) -> bool:
    return unicodedata.category(ch) in ("Mn", "Mc", "Me")


def itemize(text: str, style: TextStyle) -> list[tuple[str, LoadedFont]]:
    """Split text into runs that each use one font."""
    runs: list[tuple[str, LoadedFont]] = []
    cur_font: LoadedFont | None = None
    buf = []
    fallback_cache: dict[str, LoadedFont | None] = {}

    def font_for(ch: str) -> LoadedFont:
        if style.font.has_char(ch):
            return style.font
        for fb in style.fallbacks:
            if fb.has_char(ch):
                return fb
        sc = script_of_char(ch) or "latin"
        if sc not in fallback_cache:
            face = font_index.for_script(sc, style.bold, style.italic)
            fallback_cache[sc] = load_face(face) if face else None
            if fallback_cache[sc] is not None and fallback_cache[sc] not in style.fallbacks:
                style.fallbacks.append(fallback_cache[sc])
        fb = fallback_cache[sc]
        return fb if fb is not None and fb.has_char(ch) else style.font

    for ch in text:
        if cur_font is not None and (_is_mark(ch) or ch in "  ​‌‍"):
            f = cur_font  # marks and spaces stay with the current run
            if _is_mark(ch) and not f.has_char(ch):
                f = font_for(ch)
                if f is not cur_font and buf and not _is_mark(buf[-1]):
                    # move the base character along with its mark
                    base = buf.pop()
                    if buf:
                        runs.append(("".join(buf), cur_font))
                    buf = [base]
        else:
            f = font_for(ch)
        if cur_font is None or f is cur_font:
            buf.append(ch)
            cur_font = f
        else:
            runs.append(("".join(buf), cur_font))
            buf = [ch]
            cur_font = f
    if buf and cur_font is not None:
        runs.append(("".join(buf), cur_font))
    return runs


@dataclass
class ShapedGlyph:
    font: LoadedFont
    gid: int
    cluster: int  # absolute char index in the line text
    x_adv: float  # pt
    x_off: float
    y_off: float


def shape(text: str, style: TextStyle) -> list[ShapedGlyph]:
    out: list[ShapedGlyph] = []
    pos = 0
    for run_text, font in itemize(text, style):
        buf = hb.Buffer()
        buf.add_str(run_text)
        buf.guess_segment_properties()
        hb.shape(font.hb_font, buf, {"kern": True, "liga": True})
        scale = style.size / font.upem
        # map hb cluster (utf-32 index into run) to absolute index
        for info, gp in zip(buf.glyph_infos, buf.glyph_positions):
            out.append(ShapedGlyph(font, info.codepoint, pos + info.cluster, gp.x_advance * scale,
                                   gp.x_offset * scale, gp.y_offset * scale))
        pos += len(run_text)
    return out


def _cluster_text_mapping(text: str, glyphs: list[ShapedGlyph]) -> list[tuple[str, str, bool, int]]:
    """Attribute unicode text to every glyph so text extraction is correct.

    Returns per glyph: (glyph_text, cluster_text, multi, order) where
    ``order`` is the emission order that reproduces the logical text.
    """
    result: list[tuple[str, str, bool, int] | None] = [None] * len(glyphs)
    clusters = sorted({g.cluster for g in glyphs})
    bounds = {c: (clusters[i + 1] if i + 1 < len(clusters) else len(text)) for i, c in enumerate(clusters)}
    order_base = 0
    by_cluster: dict[int, list[int]] = {}
    for i, g in enumerate(glyphs):
        by_cluster.setdefault(g.cluster, []).append(i)
    for c in clusters:
        idxs = by_cluster[c]
        ctext = text[c:bounds[c]]
        if len(idxs) == 1:
            result[idxs[0]] = (ctext, ctext, False, order_base)
            order_base += 1
            continue
        # several glyphs: assign characters by reverse cmap
        remaining = list(ctext)
        assigned: dict[int, tuple[str, int]] = {}
        for gi in idxs:
            g = glyphs[gi]
            cp = g.font.reverse_cmap.get(g.gid)
            if cp is not None and chr(cp) in remaining:
                k = remaining.index(chr(cp))
                # position of this char inside the cluster text (first unused)
                used_positions = {p for _t, p in assigned.values()}
                pos_in = next(p for p, ch in enumerate(ctext) if ch == chr(cp) and p not in used_positions)
                assigned[gi] = (chr(cp), pos_in)
                remaining.pop(k)
        rest = "".join(remaining)
        multi = bool(rest) or len(assigned) != len(idxs)
        unassigned = [gi for gi in idxs if gi not in assigned]
        for n, gi in enumerate(unassigned):
            if n == 0 and rest:
                pos_in = next((p for p, ch in enumerate(ctext) if ch == rest[0]), len(ctext))
                assigned[gi] = (rest, pos_in)
            else:
                assigned[gi] = ("", len(ctext) + n)
        ordered = sorted(idxs, key=lambda gi: assigned[gi][1])
        for k, gi in enumerate(ordered):
            result[gi] = (assigned[gi][0], ctext, multi, order_base + k)
        order_base += len(idxs)
    return [r for r in result]  # type: ignore[misc]


# ----------------------------------------------------------------------
# Line breaking
# ----------------------------------------------------------------------

THAI_LEADING_VOWELS = set("เแโใไ")
THAI_NO_BREAK_BEFORE = set("ะาำๅๆฯ")


def _grapheme_clusters(text: str) -> list[str]:
    out: list[str] = []
    for ch in text:
        if out and (_is_mark(ch) or ch in "‍"):
            out[-1] += ch
        else:
            out.append(ch)
    return out


_thai_words: set[str] | None = None
_thai_max = 1


def _thai_dict() -> set[str]:
    global _thai_words, _thai_max
    if _thai_words is None:
        from core.config import get_settings

        words: set[str] = set()
        path = get_settings().assets_dir / "dicts" / "thaidict.txt"
        try:
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                w = line.strip()
                if w and not w.startswith("#"):
                    words.add(w)
        except OSError:
            pass
        _thai_words = words
        _thai_max = max((len(w) for w in words), default=1)
    return _thai_words


def thai_segments(text: str) -> list[str]:
    """Dictionary based Thai word segmentation (maximal matching via dynamic
    programming). Unknown runs are split at grapheme cluster boundaries so
    combining marks always stay with their base character."""
    words = _thai_dict()
    n = len(text)
    if not n:
        return []
    inf = float("inf")
    cost = [inf] * (n + 1)
    prev = [-1] * (n + 1)
    cost[0] = 0
    limit = min(_thai_max, 40)
    for i in range(n):
        if cost[i] == inf or (i and _is_mark(text[i])):
            continue
        for length in range(2, min(limit, n - i) + 1):
            j = i + length
            if text[i:j] in words and (j == n or not _is_mark(text[j])):
                if cost[i] + 1 < cost[j]:
                    cost[j] = cost[i] + 1
                    prev[j] = i
        j = i + 1
        while j < n and (_is_mark(text[j]) or text[j] == "\u200d"):
            j += 1
        if cost[i] + 3 < cost[j]:  # unknown cluster is penalised
            cost[j] = cost[i] + 3
            prev[j] = i
    out: list[str] = []
    j = n
    while j > 0:
        i = prev[j]
        out.append(text[i:j])
        j = i
    out.reverse()
    # merge consecutive unknown single clusters into one piece
    merged: list[str] = []
    for piece in out:
        if merged and piece not in words and merged[-1] not in words and len(_grapheme_clusters(piece)) == 1:
            merged[-1] += piece
        else:
            merged.append(piece)
    return merged


def _break_long_segment(seg: str) -> list[str]:
    """Split a segment that has no spaces into breakable pieces."""
    if any(script_of_char(ch) == "thai" for ch in seg) and _thai_dict():
        pieces: list[str] = []
        run = ""
        run_thai = None
        for ch in seg:
            is_thai = script_of_char(ch) == "thai" or (_is_mark(ch) and run_thai)
            if run and is_thai != run_thai:
                pieces.extend(thai_segments(run) if run_thai else _break_long_segment_basic(run))
                run = ""
            run += ch
            run_thai = is_thai
        if run:
            pieces.extend(thai_segments(run) if run_thai else _break_long_segment_basic(run))
        return [p for p in pieces if p]
    return _break_long_segment_basic(seg)


def _break_long_segment_basic(seg: str) -> list[str]:
    """Split a segment that has no spaces into breakable pieces."""
    gcs = _grapheme_clusters(seg)
    pieces: list[str] = []
    cur = ""
    for i, gc in enumerate(gcs):
        first = gc[0]
        prev = gcs[i - 1][0] if i else ""
        can_break = bool(cur) and first not in THAI_NO_BREAK_BEFORE and prev not in THAI_LEADING_VOWELS
        if script_of_char(first) == "thai" and script_of_char(prev or " ") == "thai":
            # Thai: allow breaks only between syllable-like units: before a leading vowel or
            # before a consonant that follows a final consonant/vowel.
            can_break = can_break and (first in THAI_LEADING_VOWELS or len(cur) >= 2)
        # other scripts: this segment does not fit at all, so any grapheme boundary is acceptable
        if can_break:
            pieces.append(cur)
            cur = gc
        else:
            cur += gc
    if cur:
        pieces.append(cur)
    return pieces


def _segments(paragraph: str) -> list[str]:
    """Break opportunities: after spaces / ZWSP; segments keep trailing spaces."""
    segs: list[str] = []
    cur = ""
    for ch in paragraph:
        cur += ch
        if ch in " ​\t":
            segs.append(cur)
            cur = ""
        elif script_of_char(ch) == "cjk":
            segs.append(cur)
            cur = ""
    if cur:
        segs.append(cur)
    return segs


def measure(text: str, style: TextStyle) -> float:
    if not text:
        return 0.0
    glyphs = shape(text, style)
    n_clusters = len({g.cluster for g in glyphs})
    return sum(g.x_adv for g in glyphs) + style.char_spacing * n_clusters


def _wrap(paragraph: str, style: TextStyle, max_width: float | None) -> list[str]:
    if max_width is None or max_width <= 0 or not paragraph:
        return [paragraph]
    lines: list[str] = []
    cur = ""
    for seg in _segments(paragraph):
        cand = cur + seg
        if measure(cand.rstrip(" "), style) <= max_width or not cur.strip():
            if measure(cand.rstrip(" "), style) > max_width and not cur.strip():
                # a single segment wider than the box: break it further
                pieces = _break_long_segment(seg)
                for piece in pieces:
                    c2 = cur + piece
                    if cur and measure(c2.rstrip(" "), style) > max_width:
                        lines.append(cur)
                        cur = piece
                    else:
                        cur = c2
                continue
            cur = cand
        else:
            lines.append(cur)
            cur = seg
            if measure(cur.rstrip(" "), style) > max_width:
                pieces = _break_long_segment(seg)
                cur = ""
                for piece in pieces:
                    c2 = cur + piece
                    if cur and measure(c2.rstrip(" "), style) > max_width:
                        lines.append(cur)
                        cur = piece
                    else:
                        cur = c2
    lines.append(cur)
    return lines


# ----------------------------------------------------------------------
# Layout
# ----------------------------------------------------------------------


def layout_line(text: str, style: TextStyle) -> LayoutLine:
    glyphs = shape(text, style)
    mapping = _cluster_text_mapping(text, glyphs) if glyphs else []
    placed: list[PlacedGlyph] = []
    pen = 0.0
    last_cluster = None
    for g, (gtext, ctext, multi, order) in zip(glyphs, mapping):
        if last_cluster is not None and g.cluster != last_cluster:
            pen += style.char_spacing
        last_cluster = g.cluster
        placed.append(PlacedGlyph(g.font, g.gid, pen + g.x_off, g.y_off, gtext, ctext, multi, order, g.cluster))
        pen += g.x_adv
    if glyphs:
        pen += style.char_spacing
    width = pen
    # trailing spaces do not count for alignment
    stripped = text.rstrip(" ")
    if stripped != text:
        width = measure(stripped, style) if stripped else 0.0
    asc = max([style.size * f.ascender / f.upem for f in {p.font for p in placed}] or
              [style.size * style.font.ascender / style.font.upem])
    desc = min([style.size * f.descender / f.upem for f in {p.font for p in placed}] or
               [style.size * style.font.descender / style.font.upem])
    return LayoutLine(placed, width, text, ascent=asc, descent=desc)


def layout_text(text: str, style: TextStyle, max_width: float | None = None,
                first_baseline: float | None = None, wrap: bool = True) -> LayoutResult:
    """Lay out (possibly multi-line) text.

    ``first_baseline``: distance from the box top to the first baseline; by
    default the font ascender. Subsequent baselines follow ``line_height``.
    ``wrap=False``: every ``\n`` separated line is laid out as is (line breaks
    decided by the caller, e.g. measured in the editor) while alignment still
    uses ``max_width`` as the box width.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines: list[LayoutLine] = []
    for para in text.split("\n"):
        for ltext in (_wrap(para, style, max_width) if wrap else [para]):
            lines.append(layout_line(ltext, style))
    asc = style.size * style.font.ascender / style.font.upem
    desc = style.size * style.font.descender / style.font.upem
    advance = style.size * style.line_height
    base = asc if first_baseline is None else first_baseline
    box_w = max_width if max_width else max((ln.width for ln in lines), default=0.0)
    for i, ln in enumerate(lines):
        ln.baseline = base + i * advance
        if style.align == "center":
            ln.x = (box_w - ln.width) / 2
        elif style.align == "right":
            ln.x = box_w - ln.width
        elif style.align == "justify" and max_width and i < len(lines) - 1:
            n_spaces = ln.text.rstrip(" ").count(" ")
            if n_spaces:
                ln.space_stretch = (box_w - ln.width) / n_spaces
                ln.width = box_w
    height = (lines[-1].baseline - desc) if lines else 0.0
    fonts_used = sorted({g.font.family for ln in lines for g in ln.glyphs})
    fallback = sorted({g.font.family for ln in lines for g in ln.glyphs if g.font is not style.font})
    return LayoutResult(lines, box_w, height, fonts_used,
                        [{"family": f, "reason": "missing glyphs in the selected font"} for f in fallback])


def apply_justify(line: LayoutLine) -> None:
    """Shift glyphs right of each space by the justify stretch (in place)."""
    if not line.space_stretch:
        return
    shift = 0.0
    for g in line.glyphs:
        g.x += shift
        if g.text == " ":
            shift += line.space_stretch


def make_style(face: FontFace | None, size: float, **kw) -> TextStyle:
    if face is None:
        face = font_index.for_script("latin")
        if face is None:
            raise RuntimeError("No usable font found")
    return TextStyle(font=load_face(face), size=size, **kw)
