"""Interactive forms (AcroForm): list, fill, create, edit, delete, reset, flatten.

Appearance streams of text and choice fields are generated with the app's own
text engine (HarfBuzz shaping, automatic font fallback, Thai line breaking),
so filled forms look identical in every viewer and when printed. The
appearance generators built into PDF viewers only know the Latin standard
fonts, which is why Thai entries often show up empty elsewhere.

All geometry is PDF user space, i.e. exactly the widget ``/Rect``.
Field ids are fully qualified field names; widget ids are ``w<obj>_<gen>``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field
from typing import Any, Iterator

import pikepdf
from pikepdf import Array, Dictionary, Name

from core.errors import AppError
from services.fonts import font_index, split_pdf_font_name
from services.pdf_writer import PageWriter, Resources, XObjectWriter, fmt, mat_translate
from services.text_layout import TextStyle, layout_line, layout_text, load_face, measure

# field flags (PDF 32000-1, 12.7.3 / 12.7.4)
FF_READONLY = 1 << 0
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_PASSWORD = 1 << 13
FF_NO_TOGGLE_OFF = 1 << 14
FF_RADIO = 1 << 15
FF_PUSHBUTTON = 1 << 16
FF_COMBO = 1 << 17
FF_EDIT = 1 << 18
FF_MULTISELECT = 1 << 21
FF_COMB = 1 << 24

FIELD_TYPES = ("text", "checkbox", "radio", "combo", "list", "signature")
_INHERITABLE = ("/FT", "/Ff", "/V", "/DV", "/DA", "/Q", "/MaxLen", "/Opt")
_STD_FONTS = {
    "helv": "Liberation Sans", "helvetica": "Liberation Sans", "arial": "Liberation Sans",
    "tiro": "Liberation Serif", "times": "Liberation Serif", "timesroman": "Liberation Serif", "timesnewroman": "Liberation Serif",
    "cour": "Liberation Mono", "courier": "Liberation Mono", "couriernew": "Liberation Mono",
}


# ----------------------------------------------------------------------
# model
# ----------------------------------------------------------------------


@dataclass
class Field:
    name: str
    obj: pikepdf.Dictionary  # terminal field dictionary
    attrs: dict[str, Any]  # inherited attributes
    widgets: list[pikepdf.Dictionary] = dc_field(default_factory=list)

    @property
    def ft(self) -> str:
        return str(self.attrs.get("/FT", ""))

    @property
    def ff(self) -> int:
        try:
            return int(self.attrs.get("/Ff", 0))
        except (TypeError, ValueError):
            return 0

    @property
    def kind(self) -> str:
        ft, ff = self.ft, self.ff
        if ft == "/Tx":
            return "text"
        if ft == "/Ch":
            return "combo" if ff & FF_COMBO else "list"
        if ft == "/Sig":
            return "signature"
        if ft == "/Btn":
            if ff & FF_PUSHBUTTON:
                return "button"
            return "radio" if ff & FF_RADIO else "checkbox"
        return "unknown"


def _is_widget(d: pikepdf.Dictionary) -> bool:
    return d.get("/Subtype") == Name.Widget


def _text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, pikepdf.String):
        return str(v)
    if isinstance(v, Name):
        return str(v)[1:]
    return str(v)


def iter_fields(pdf: pikepdf.Pdf) -> Iterator[Field]:
    acro = pdf.Root.get("/AcroForm")
    if acro is None or "/Fields" not in acro:
        return
    seen: set[tuple[int, int]] = set()

    def walk(node: pikepdf.Dictionary, prefix: str, inherited: dict[str, Any]):
        if node.is_indirect:
            key = node.objgen
            if key in seen:  # malformed files may contain cycles
                return
            seen.add(key)
        attrs = dict(inherited)
        for k in _INHERITABLE:
            if k in node:
                attrs[k] = node[k]
        t = node.get("/T")
        name = prefix if t is None else (f"{prefix}.{_text(t)}" if prefix else _text(t))
        kids = node.get("/Kids")
        field_kids = [k for k in kids if "/T" in k] if kids is not None else []
        if kids is not None and field_kids:
            for k in kids:
                if "/T" in k:
                    yield from walk(k, name, attrs)
            return
        f = Field(name=name, obj=node, attrs=attrs)
        if kids is not None:
            f.widgets = [k for k in kids if _is_widget(k) or "/Rect" in k]
        elif _is_widget(node) or "/Rect" in node:
            f.widgets = [node]
        yield f

    for top in acro.Fields:
        yield from walk(top, "", {})


def _page_map(pdf: pikepdf.Pdf) -> dict[tuple[int, int], int]:
    out: dict[tuple[int, int], int] = {}
    for i, page in enumerate(pdf.pages):
        for a in page.obj.get("/Annots", []) or []:
            if a.is_indirect:
                out[a.objgen] = i
    return out


def widget_ids(pdf: pikepdf.Pdf) -> dict[tuple[int, int], str]:
    """Stable widget ids ``w<field index>_<widget index>``.

    Object numbers change whenever a revision is written, so ids are based on
    the position of the field in the form and of the widget in the field.
    """
    out: dict[tuple[int, int], str] = {}
    for i, f in enumerate(iter_fields(pdf)):
        for k, w in enumerate(f.widgets):
            if w.is_indirect:
                out[w.objgen] = f"w{i}_{k}"
    return out


def widget_id(pdf: pikepdf.Pdf, w: pikepdf.Dictionary) -> str:
    return widget_ids(pdf).get(w.objgen, "")


def _rect(w) -> list[float]:
    r = [float(x) for x in w.get("/Rect", [0, 0, 0, 0])]
    return [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])]


def on_state(w: pikepdf.Dictionary) -> str | None:
    ap = w.get("/AP")
    n = ap.get("/N") if ap is not None else None
    if isinstance(n, pikepdf.Dictionary):
        for k in n.keys():
            if k != "/Off":
                return k[1:]
    # fall back to the export value list of the parent (/Opt) or "Yes"
    return None


def _options(f: Field) -> list[list[str]]:
    opt = f.attrs.get("/Opt")
    out: list[list[str]] = []
    if opt is None:
        return out
    for o in opt:
        if isinstance(o, pikepdf.Array) and len(o) >= 2:
            out.append([_text(o[0]), _text(o[1])])
        else:
            out.append([_text(o), _text(o)])
    return out


def field_value(f: Field) -> Any:
    v = f.attrs.get("/V")
    kind = f.kind
    if kind == "checkbox":
        if v is None:
            # value may only live in /AS
            return any(str(w.get("/AS", "/Off")) != "/Off" for w in f.widgets)
        return _text(v) not in ("", "Off")
    if kind == "radio":
        s = _text(v) if v is not None else ""
        if not s:
            for w in f.widgets:
                if str(w.get("/AS", "/Off")) != "/Off":
                    return str(w.AS)[1:]
        return None if s in ("", "Off") else s
    if kind == "list":
        if isinstance(v, pikepdf.Array):
            return [_text(x) for x in v]
        return [_text(v)] if v is not None and _text(v) else []
    return _text(v) if v is not None else ""


def _da(f: Field, w: pikepdf.Dictionary | None = None) -> tuple[str, float, tuple[float, float, float]]:
    da = _text((w.get("/DA") if w is not None and "/DA" in w else None) or f.attrs.get("/DA") or "")
    font, size, color = "Helv", 0.0, (0.0, 0.0, 0.0)
    m = re.search(r"/([^\s/]+)\s+([\d.]+)\s+Tf", da)
    if m:
        font, size = m.group(1), float(m.group(2))
    m = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", da)
    if m:
        color = (float(m.group(1)), float(m.group(2)), float(m.group(3)))
    else:
        m = re.search(r"([\d.]+)\s+g(?:\s|$)", da)
        if m:
            g = float(m.group(1))
            color = (g, g, g)
    return font, size, color


def _flags(f: Field) -> dict[str, bool]:
    ff = f.ff
    return {
        "readonly": bool(ff & FF_READONLY),
        "required": bool(ff & FF_REQUIRED),
        "multiline": bool(ff & FF_MULTILINE),
        "password": bool(ff & FF_PASSWORD),
        "comb": bool(ff & FF_COMB),
        "multiselect": bool(ff & FF_MULTISELECT),
        "editable": bool(ff & FF_EDIT),
    }


def list_fields(pdf: pikepdf.Pdf) -> dict:
    pages = _page_map(pdf)
    ids = widget_ids(pdf)
    widgets: list[dict] = []
    fields: list[dict] = []
    for f in iter_fields(pdf):
        kind = f.kind
        if kind in ("unknown", "button"):
            continue
        _font, size, _color = _da(f)
        q = int(f.attrs.get("/Q", 0) or 0)
        tooltip = _text(f.obj.get("/TU")) if "/TU" in f.obj else ""
        maxlen = int(f.attrs.get("/MaxLen", 0) or 0)
        info = {
            "name": f.name,
            "type": kind,
            "value": field_value(f),
            "options": _options(f),
            "font_size": size,
            "align": ["left", "center", "right"][q] if 0 <= q <= 2 else "left",
            "tooltip": tooltip,
            "maxlen": maxlen,
            "signed": kind == "signature" and f.attrs.get("/V") is not None,
            **_flags(f),
        }
        fields.append(info)
        for w in f.widgets:
            if not w.is_indirect:
                continue
            page = pages.get(w.objgen)
            if page is None:
                p = w.get("/P")
                if p is not None and p.is_indirect:
                    for i, pg in enumerate(pdf.pages):
                        if pg.obj.objgen == p.objgen:
                            page = i
                            break
            if page is None:
                continue
            hidden = bool(int(w.get("/F", 0) or 0) & 2)
            widgets.append({
                "id": ids[w.objgen],
                "field": f.name,
                "type": kind,
                "page": page,
                "rect": _rect(w),
                "export": on_state(w) if kind in ("checkbox", "radio") else None,
                "hidden": hidden,
            })
    acro = pdf.Root.get("/AcroForm")
    return {
        "fields": fields,
        "widgets": widgets,
        "xfa": bool(acro is not None and "/XFA" in acro),
    }


def find_field(pdf: pikepdf.Pdf, name: str) -> Field:
    for f in iter_fields(pdf):
        if f.name == name:
            return f
    raise AppError("not_found", f"Form field “{name}” not found", status=404)


def find_widget(pdf: pikepdf.Pdf, wid: str) -> tuple[Field, pikepdf.Dictionary]:
    for i, f in enumerate(iter_fields(pdf)):
        for k, w in enumerate(f.widgets):
            if f"w{i}_{k}" == wid:
                return f, w
    raise AppError("not_found", "Form field not found", status=404)


# ----------------------------------------------------------------------
# appearance generation
# ----------------------------------------------------------------------


def _font_face_for(pdf: pikepdf.Pdf, font_name: str, bold: bool = False):
    family = _STD_FONTS.get(font_name.lower().replace("-", "").replace(" ", ""))
    if family is None:
        acro = pdf.Root.get("/AcroForm")
        dr = acro.get("/DR") if acro is not None else None
        fobj = dr.get("/Font", {}).get("/" + font_name) if dr is not None and "/Font" in dr else None
        base = str(fobj.get("/BaseFont", "")) if fobj is not None else ""
        if base:
            fam, b, _i, _sub = split_pdf_font_name(base.lstrip("/"))
            family = _STD_FONTS.get(fam.lower().replace(" ", ""), fam)
            bold = bold or b
    face = font_index.find(family or "Liberation Sans", bold, False) or font_index.find("Noto Sans", bold, False)
    if face is None:
        face = font_index.for_script("latin", bold, False)
    if face is None:
        raise AppError("font_missing", "No usable font was found on this computer")
    return face


def _mk_colors(w: pikepdf.Dictionary):
    mk = w.get("/MK")

    def col(key):
        if mk is None or key not in mk:
            return None
        arr = [float(x) for x in mk[key]]
        if len(arr) == 1:
            return (arr[0], arr[0], arr[0])
        if len(arr) == 3:
            return tuple(arr)
        if len(arr) == 4:  # CMYK
            c, m, y, k = arr
            return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
        return None

    return col("/BG"), col("/BC")


def _border_width(w: pikepdf.Dictionary, has_border: bool) -> float:
    bs = w.get("/BS")
    if bs is not None and "/W" in bs:
        return float(bs.W)
    return 1.0 if has_border else 0.0


def _frame(xw: XObjectWriter, width: float, height: float, bg, bc, bw: float) -> None:
    if bg is not None:
        xw.op(f"{fmt(bg[0])} {fmt(bg[1])} {fmt(bg[2])} rg 0 0 {fmt(width)} {fmt(height)} re f")
    if bc is not None and bw > 0:
        h = bw / 2
        xw.op(f"{fmt(bc[0])} {fmt(bc[1])} {fmt(bc[2])} RG {fmt(bw)} w {fmt(h)} {fmt(h)} {fmt(width - bw)} {fmt(height - bw)} re S")


def _fit_size(text: str, style: TextStyle, width: float, height: float, multiline: bool) -> float:
    """Auto font size (DA size 0): largest size ≤ 12 pt that fits."""
    size = 12.0
    while size > 4:
        style.size = size
        if multiline:
            lay = layout_text(text, style, max_width=width)
            if lay.height <= height:
                return size
        else:
            f = style.font
            if measure(text, style) <= width and size * (f.ascender - f.descender) / f.upem <= height:
                return size
        size -= 0.5
    return 4.0


def _style_for(pdf, f: Field, w) -> tuple[TextStyle, float]:
    font_name, size, color = _da(f, w)
    face = _font_face_for(pdf, font_name)
    style = TextStyle(font=load_face(face), size=size or 12.0, color=color)
    q = int(f.attrs.get("/Q", 0) or 0)
    style.align = ["left", "center", "right"][q] if 0 <= q <= 2 else "left"
    return style, size


def text_appearance(pdf: pikepdf.Pdf, res: Resources, f: Field, w: pikepdf.Dictionary, value: str) -> pikepdf.Stream:
    x0, y0, x1, y1 = _rect(w)
    width, height = max(1.0, x1 - x0), max(1.0, y1 - y0)
    xw = XObjectWriter(pdf, res, (0, 0, width, height))
    bg, bc = _mk_colors(w)
    bw = _border_width(w, bc is not None)
    _frame(xw, width, height, bg, bc, bw)
    pad = max(bw, 1.0) + 1.0
    inner_w, inner_h = max(1.0, width - 2 * pad), max(1.0, height - 2 * pad)
    flags = _flags(f)
    if flags["password"]:
        value = "•" * len(value)
    if value:
        style, da_size = _style_for(pdf, f, w)
        multiline = flags["multiline"]
        if not da_size:
            style.size = _fit_size(value, style, inner_w, inner_h, multiline)
        fnt = style.font
        asc = style.size * fnt.ascender / fnt.upem
        desc = -style.size * fnt.descender / fnt.upem
        xw.op(f"{fmt(pad - 0.5)} {fmt(pad - 0.5)} {fmt(inner_w + 1)} {fmt(inner_h + 1)} re W n")
        maxlen = int(f.attrs.get("/MaxLen", 0) or 0)
        if flags["comb"] and maxlen > 0 and not multiline:
            cell = width / maxlen
            base_y = (height - (asc + desc)) / 2 + desc
            for i, ch in enumerate(list(value)[:maxlen]):
                ln = layout_line(ch, style)
                ln.baseline = 0
                ln.x = 0
                lay = _single(ln)
                xw.text_layout(lay, style, (1, 0, 0, 1, i * cell + (cell - ln.width) / 2, base_y))
        elif multiline:
            lay = layout_text(value, style, max_width=inner_w, first_baseline=asc)
            xw.text_layout(lay, style, mat_translate(pad, height - pad))
        else:
            ln = layout_line(value.replace("\n", " "), style)
            if style.align == "center":
                ln.x = (inner_w - ln.width) / 2
            elif style.align == "right":
                ln.x = inner_w - ln.width
            ln.baseline = 0
            base_y = (height - (asc + desc)) / 2 + desc
            xw.text_layout(_single(ln), style, (1, 0, 0, 1, pad, base_y))
    return xw.build(marked_tx=True)


def _single(line):
    from services.text_layout import LayoutResult

    return LayoutResult([line], line.width, 0.0, [], [])


def list_appearance(pdf: pikepdf.Pdf, res: Resources, f: Field, w: pikepdf.Dictionary, selected: list[str]) -> pikepdf.Stream:
    x0, y0, x1, y1 = _rect(w)
    width, height = max(1.0, x1 - x0), max(1.0, y1 - y0)
    xw = XObjectWriter(pdf, res, (0, 0, width, height))
    bg, bc = _mk_colors(w)
    bw = _border_width(w, bc is not None)
    _frame(xw, width, height, bg, bc, bw)
    pad = max(bw, 1.0) + 1.0
    style, da_size = _style_for(pdf, f, w)
    style.size = da_size or 10.0
    line_h = style.size * 1.15
    xw.op(f"{fmt(pad - 0.5)} {fmt(pad - 0.5)} {fmt(width - 2 * pad + 1)} {fmt(height - 2 * pad + 1)} re W n")
    top = int(f.obj.get("/TI", 0) or 0)
    y = height - pad
    for export, display in _options(f)[top:]:
        if y - line_h < 0:
            break
        if export in selected:
            xw.op(f"0.6 0.75 0.86 rg {fmt(pad)} {fmt(y - line_h)} {fmt(width - 2 * pad)} {fmt(line_h)} re f")
        ln = layout_line(display, style)
        ln.baseline = 0
        xw.text_layout(_single(ln), style, (1, 0, 0, 1, pad + 1, y - (line_h - style.size) / 2 - style.size * 0.8))
        y -= line_h
    return xw.build(marked_tx=True)


def _check_appearances(pdf: pikepdf.Pdf, w: pikepdf.Dictionary, kind: str, export: str) -> pikepdf.Dictionary:
    x0, y0, x1, y1 = _rect(w)
    width, height = max(1.0, x1 - x0), max(1.0, y1 - y0)
    bg, bc = _mk_colors(w)
    bw = _border_width(w, bc is not None)
    s = min(width, height)

    def frame_ops() -> list[str]:
        ops = []
        if kind == "radio":
            r = s / 2 - bw / 2
            cx, cy = width / 2, height / 2
            if bg is not None:
                ops.append(f"{fmt(bg[0])} {fmt(bg[1])} {fmt(bg[2])} rg {_circle(cx, cy, r)} f")
            if bc is not None and bw > 0:
                ops.append(f"{fmt(bc[0])} {fmt(bc[1])} {fmt(bc[2])} RG {fmt(bw)} w {_circle(cx, cy, r)} S")
        else:
            if bg is not None:
                ops.append(f"{fmt(bg[0])} {fmt(bg[1])} {fmt(bg[2])} rg 0 0 {fmt(width)} {fmt(height)} re f")
            if bc is not None and bw > 0:
                h = bw / 2
                ops.append(f"{fmt(bc[0])} {fmt(bc[1])} {fmt(bc[2])} RG {fmt(bw)} w {fmt(h)} {fmt(h)} {fmt(width - bw)} {fmt(height - bw)} re S")
        return ops

    def mark_ops() -> list[str]:
        if kind == "radio":
            return [f"0 g {_circle(width / 2, height / 2, s * 0.22)} f"]
        # check mark as a stroked path, centred
        m = s * 0.18
        ox, oy = (width - s) / 2, (height - s) / 2
        p1 = (ox + m, oy + s * 0.52)
        p2 = (ox + s * 0.42, oy + m * 1.1)
        p3 = (ox + s - m, oy + s - m)
        lw = max(1.0, s * 0.12)
        return [f"0 G {fmt(lw)} w 1 J 1 j {fmt(p1[0])} {fmt(p1[1])} m {fmt(p2[0])} {fmt(p2[1])} l {fmt(p3[0])} {fmt(p3[1])} l S"]

    def stream(ops: list[str]) -> pikepdf.Stream:
        st = pdf.make_stream(("q\n" + "\n".join(ops) + "\nQ").encode("latin-1"))
        st[Name.Type] = Name.XObject
        st[Name.Subtype] = Name.Form
        st[Name.BBox] = Array([0, 0, width, height])
        st[Name.Resources] = Dictionary()
        return st

    return Dictionary({"/" + export: stream(frame_ops() + mark_ops()), "/Off": stream(frame_ops())})


def _circle(cx: float, cy: float, r: float) -> str:
    k = 0.5523 * r
    return (f"{fmt(cx + r)} {fmt(cy)} m {fmt(cx + r)} {fmt(cy + k)} {fmt(cx + k)} {fmt(cy + r)} {fmt(cx)} {fmt(cy + r)} c "
            f"{fmt(cx - k)} {fmt(cy + r)} {fmt(cx - r)} {fmt(cy + k)} {fmt(cx - r)} {fmt(cy)} c "
            f"{fmt(cx - r)} {fmt(cy - k)} {fmt(cx - k)} {fmt(cy - r)} {fmt(cx)} {fmt(cy - r)} c "
            f"{fmt(cx + k)} {fmt(cy - r)} {fmt(cx + r)} {fmt(cy - k)} {fmt(cx + r)} {fmt(cy)} c")


def _signature_appearance(pdf: pikepdf.Pdf, w: pikepdf.Dictionary) -> pikepdf.Stream:
    x0, y0, x1, y1 = _rect(w)
    width, height = max(1.0, x1 - x0), max(1.0, y1 - y0)
    st = pdf.make_stream(
        f"q 0.96 0.97 1 rg 0 0 {fmt(width)} {fmt(height)} re f 0.55 0.6 0.7 RG 0.75 w [3 2] 0 d 0.5 0.5 {fmt(width - 1)} {fmt(height - 1)} re S Q".encode())
    st[Name.Type] = Name.XObject
    st[Name.Subtype] = Name.Form
    st[Name.BBox] = Array([0, 0, width, height])
    st[Name.Resources] = Dictionary()
    return st


def refresh_appearance(pdf: pikepdf.Pdf, res: Resources, f: Field) -> None:
    kind = f.kind
    value = field_value(f)
    for w in f.widgets:
        if kind == "text":
            ap = text_appearance(pdf, res, f, w, str(value or ""))
            w.AP = Dictionary(N=pdf.make_indirect(ap))
        elif kind == "combo":
            display = dict((e, d) for e, d in _options(f)).get(str(value), str(value or ""))
            ap = text_appearance(pdf, res, f, w, display)
            w.AP = Dictionary(N=pdf.make_indirect(ap))
        elif kind == "list":
            ap = list_appearance(pdf, res, f, w, list(value or []))
            w.AP = Dictionary(N=pdf.make_indirect(ap))
        elif kind in ("checkbox", "radio"):
            exp = on_state(w) or "Yes"
            if "/AP" not in w or not isinstance(w.AP.get("/N"), pikepdf.Dictionary):
                w.AP = Dictionary(N=_check_appearances(pdf, w, kind, exp))
            if kind == "checkbox":
                w.AS = Name("/" + exp) if value else Name.Off
            else:
                w.AS = Name("/" + exp) if value == exp else Name.Off
        elif kind == "signature" and "/AP" not in w:
            w.AP = Dictionary(N=pdf.make_indirect(_signature_appearance(pdf, w)))


def _needs_unicode_font(text: str) -> bool:
    try:
        text.encode("cp1252")
        return False
    except UnicodeEncodeError:
        return True


def _prepare_acroform(pdf: pikepdf.Pdf) -> pikepdf.Dictionary:
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        pdf.Root.AcroForm = Dictionary(Fields=Array())
        acro = pdf.Root.AcroForm
    if "/Fields" not in acro:
        acro.Fields = Array()
    if "/DR" not in acro:
        acro.DR = Dictionary()
    if "/Font" not in acro.DR:
        acro.DR.Font = Dictionary()
    if "/Helv" not in acro.DR.Font:
        acro.DR.Font.Helv = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                                                         Encoding=Name.WinAnsiEncoding))
    if "/DA" not in acro:
        acro.DA = pikepdf.String("/Helv 0 Tf 0 g")
    # we provide all appearances ourselves
    if "/NeedAppearances" in acro:
        del acro["/NeedAppearances"]
    # hybrid XFA forms: viewers that prefer XFA would ignore the AcroForm values
    if "/XFA" in acro:
        del acro["/XFA"]
    return acro


# ----------------------------------------------------------------------
# operations (all take an opened pikepdf document and modify it in place)
# ----------------------------------------------------------------------


def _check_writable(f: Field) -> None:
    if f.ff & FF_READONLY:
        raise AppError("field_readonly", f"The field “{f.name}” is read-only")


def fill(pdf: pikepdf.Pdf, values: dict[str, Any], *, force: bool = False) -> list[str]:
    """Set field values. Returns the names of changed fields."""
    _prepare_acroform(pdf)
    by_name = {f.name: f for f in iter_fields(pdf)}
    res = Resources(pdf)
    changed: list[str] = []
    for name, value in values.items():
        f = by_name.get(name)
        if f is None:
            raise AppError("not_found", f"Form field “{name}” not found", status=404)
        if not force:
            _check_writable(f)
        kind = f.kind
        if kind == "text":
            text = str(value if value is not None else "")
            maxlen = int(f.attrs.get("/MaxLen", 0) or 0)
            if maxlen and len(text) > maxlen:
                text = text[:maxlen]
            if not (f.ff & FF_MULTILINE):
                text = text.replace("\r", " ").replace("\n", " ")
            f.obj.V = pikepdf.String(text)
        elif kind == "checkbox":
            on = None
            for w in f.widgets:
                on = on or on_state(w)
            on = on or "Yes"
            f.obj.V = Name("/" + on) if value else Name.Off
        elif kind == "radio":
            exports = {on_state(w) for w in f.widgets}
            if value in (None, "", False):
                f.obj.V = Name.Off
            else:
                if str(value) not in exports:
                    raise AppError("invalid_value", f"“{value}” is not an option of “{name}”")
                f.obj.V = Name("/" + str(value))
        elif kind == "combo":
            text = str(value if value is not None else "")
            allowed = {e for e, _d in _options(f)}
            if text and allowed and text not in allowed and not (f.ff & FF_EDIT):
                raise AppError("invalid_value", f"“{text}” is not an option of “{name}”")
            f.obj.V = pikepdf.String(text)
        elif kind == "list":
            items = [str(v) for v in (value if isinstance(value, list) else [value] if value else [])]
            allowed = {e for e, _d in _options(f)}
            bad = [v for v in items if v not in allowed]
            if bad:
                raise AppError("invalid_value", f"“{bad[0]}” is not an option of “{name}”")
            if not (f.ff & FF_MULTISELECT):
                items = items[:1]
            f.obj.V = Array([pikepdf.String(v) for v in items]) if len(items) > 1 else (pikepdf.String(items[0]) if items else pikepdf.String(""))
            opts = [e for e, _d in _options(f)]
            f.obj.I = Array(sorted(opts.index(v) for v in items))
        else:
            raise AppError("invalid_value", f"The field “{name}” cannot be filled in here")
        f.attrs["/V"] = f.obj.V
        refresh_appearance(pdf, res, f)
        if kind in ("text", "combo") and _needs_unicode_font(_text(f.obj.V)):
            _attach_unicode_da(pdf, res, f)
        changed.append(name)
    res.finalize()
    return changed


def _attach_unicode_da(pdf: pikepdf.Pdf, res: Resources, f: Field) -> None:
    """Point the field's DA at an embedded font that has the needed glyphs, so
    viewers that regenerate the appearance (e.g. while editing) can show it."""
    acro = _prepare_acroform(pdf)
    fonts = list(res.fonts.values())
    text = _text(f.obj.V)
    fe = None
    for cand in fonts:
        if all(cand.font.has_char(ch) for ch in text if not ch.isspace()):
            fe = cand
            break
    if fe is None:
        return
    name = None
    for k, v in acro.DR.Font.items():
        if v.is_indirect and fe.obj.is_indirect and v.objgen == fe.obj.objgen:
            name = k[1:]
    if name is None:
        i = 1
        while f"/PEdForm{i}" in acro.DR.Font:
            i += 1
        name = f"PEdForm{i}"
        acro.DR.Font[Name("/" + name)] = fe.obj
    _font, size, color = _da(f)
    f.obj.DA = pikepdf.String(f"/{name} {fmt(size)} Tf {fmt(color[0])} {fmt(color[1])} {fmt(color[2])} rg")


def reset(pdf: pikepdf.Pdf, names: list[str] | None = None) -> list[str]:
    _prepare_acroform(pdf)
    res = Resources(pdf)
    changed = []
    for f in iter_fields(pdf):
        if names and f.name not in names:
            continue
        if f.kind in ("signature", "button", "unknown"):
            continue
        dv = f.attrs.get("/DV")
        if dv is not None:
            f.obj.V = dv
        elif "/V" in f.obj:
            del f.obj["/V"]
        if "/I" in f.obj:
            del f.obj["/I"]
        f.attrs["/V"] = f.obj.get("/V")
        refresh_appearance(pdf, res, f)
        changed.append(f.name)
    res.finalize()
    return changed


_NAME_RE = re.compile(r"^[^.\x00-\x1f]{1,120}$")


def _unique_name(pdf: pikepdf.Pdf, base: str) -> str:
    names = {f.name for f in iter_fields(pdf)}
    i = 1
    while f"{base}{i}" in names:
        i += 1
    return f"{base}{i}"


def create(pdf: pikepdf.Pdf, page_index: int, ftype: str, rect: list[float], *, name: str | None = None,
           options: list[str] | None = None, multiline: bool = False, font_size: float = 0.0,
           required: bool = False, readonly: bool = False, tooltip: str = "", export: str | None = None,
           value: Any = None, maxlen: int = 0, comb: bool = False, password: bool = False,
           multiselect: bool = False, editable: bool = False, align: str = "left") -> dict:
    if ftype not in FIELD_TYPES:
        raise AppError("invalid_request", "Unknown field type")
    if not 0 <= page_index < len(pdf.pages):
        raise AppError("invalid_page", "Page out of range")
    x0, y0, x1, y1 = [float(v) for v in rect]
    r = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
    if r[2] - r[0] < 4 or r[3] - r[1] < 4:
        raise AppError("invalid_request", "The field is too small")
    acro = _prepare_acroform(pdf)
    page = pdf.pages[page_index]
    base = {"text": "Text", "checkbox": "Check", "radio": "Group", "combo": "Dropdown", "list": "List", "signature": "Signature"}[ftype]
    existing = {f.name: f for f in iter_fields(pdf)}
    if name:
        name = name.strip()
        if not _NAME_RE.match(name):
            raise AppError("invalid_request", "Field names cannot contain dots or control characters")
    else:
        name = _unique_name(pdf, base)

    widget = Dictionary(Type=Name.Annot, Subtype=Name.Widget, Rect=Array(r), F=4, P=page.obj,
                        MK=Dictionary(BC=Array([0.45, 0.5, 0.6]), BG=Array([1, 1, 1]) if ftype != "signature" else Array([0.96, 0.97, 1])),
                        BS=Dictionary(W=1, S=Name.S))
    ff = (FF_READONLY if readonly else 0) | (FF_REQUIRED if required else 0)
    if ftype == "radio":
        export = (export or "").strip() or None
        parent = existing.get(name)
        if parent is not None and parent.kind != "radio":
            raise AppError("name_taken", f"A field named “{name}” already exists")
        if parent is None:
            parent_obj = pdf.make_indirect(Dictionary(FT=Name.Btn, Ff=FF_RADIO | FF_NO_TOGGLE_OFF | ff, T=pikepdf.String(name),
                                                      Kids=Array(), V=Name.Off))
            if tooltip:
                parent_obj.TU = pikepdf.String(tooltip)
            acro.Fields.append(parent_obj)
            exports = set()
        else:
            parent_obj = parent.obj
            exports = {on_state(w) for w in parent.widgets}
            if "/Kids" not in parent_obj:
                raise AppError("invalid_request", "This radio group cannot take more buttons")
        if not export:
            i = 1
            while f"Choice{i}" in exports:
                i += 1
            export = f"Choice{i}"
        if export in exports:
            raise AppError("name_taken", f"The group already has an option “{export}”")
        if not re.match(r"^[A-Za-z0-9_-]{1,60}$", export):
            raise AppError("invalid_request", "Option values may use letters, digits, - and _ only")
        widget.Parent = parent_obj
        widget.MK.CA = pikepdf.String("l")  # ZapfDingbats circle, used by viewers that rebuild appearances
        widget.DA = pikepdf.String("/ZaDb 0 Tf 0 g")
        w_obj = pdf.make_indirect(widget)
        w_obj.AP = Dictionary(N=_check_appearances(pdf, w_obj, "radio", export))
        w_obj.AS = Name.Off
        parent_obj.Kids.append(w_obj)
        _add_annot(page, w_obj)
        if value:
            fill(pdf, {name: export}, force=True)
        return {"name": name, "widget": widget_id(pdf, w_obj), "export": export}

    if name in existing:
        raise AppError("name_taken", f"A field named “{name}” already exists")
    widget.T = pikepdf.String(name)
    if tooltip:
        widget.TU = pikepdf.String(tooltip)
    size = max(0.0, float(font_size or 0))
    if ftype == "text":
        widget.FT = Name.Tx
        ff |= (FF_MULTILINE if multiline else 0) | (FF_PASSWORD if password else 0)
        if comb and maxlen > 0:
            ff |= FF_COMB
        if maxlen > 0:
            widget.MaxLen = int(maxlen)
        widget.DA = pikepdf.String(f"/Helv {fmt(size)} Tf 0 g")
        widget.Q = {"left": 0, "center": 1, "right": 2}.get(align, 0)
    elif ftype == "checkbox":
        widget.FT = Name.Btn
        widget.MK.CA = pikepdf.String("4")  # ZapfDingbats check
        widget.DA = pikepdf.String("/ZaDb 0 Tf 0 g")
    elif ftype in ("combo", "list"):
        opts = [o for o in (options or []) if str(o).strip()]
        if not opts:
            raise AppError("invalid_request", "Add at least one option")
        widget.FT = Name.Ch
        ff |= (FF_COMBO | (FF_EDIT if editable else 0)) if ftype == "combo" else (FF_MULTISELECT if multiselect else 0)
        widget.Opt = Array([pikepdf.String(str(o)) for o in opts])
        widget.DA = pikepdf.String(f"/Helv {fmt(size)} Tf 0 g")
    elif ftype == "signature":
        widget.FT = Name.Sig
    widget.Ff = ff
    w_obj = pdf.make_indirect(widget)
    acro.Fields.append(w_obj)
    _add_annot(page, w_obj)
    if ftype == "signature":
        acro.SigFlags = 1
    if ftype == "checkbox":
        exp = (export or "Yes").strip() or "Yes"
        if not re.match(r"^[A-Za-z0-9_-]{1,60}$", exp):
            raise AppError("invalid_request", "Option values may use letters, digits, - and _ only")
        w_obj.AP = Dictionary(N=_check_appearances(pdf, w_obj, "checkbox", exp))
        w_obj.AS = Name.Off
        w_obj.V = Name.Off
    f = find_field(pdf, name)
    res = Resources(pdf)
    refresh_appearance(pdf, res, f)
    res.finalize()
    if value not in (None, "", [], False):
        fill(pdf, {name: value}, force=True)
    return {"name": name, "widget": widget_id(pdf, w_obj)}


def _add_annot(page: pikepdf.Page, w: pikepdf.Dictionary) -> None:
    if "/Annots" not in page.obj:
        page.obj.Annots = Array()
    page.obj.Annots.append(w)


def update(pdf: pikepdf.Pdf, field_name: str, props: dict[str, Any], widget: str | None = None) -> dict:
    """Change field properties (name, flags, options, font size, alignment,
    tooltip, max length) and/or a widget's rectangle."""
    f = find_field(pdf, field_name)
    obj = f.obj
    kind = f.kind
    _prepare_acroform(pdf)
    new_name = field_name
    if "name" in props and props["name"] and props["name"] != field_name.split(".")[-1]:
        nm = str(props["name"]).strip()
        if not _NAME_RE.match(nm):
            raise AppError("invalid_request", "Field names cannot contain dots or control characters")
        prefix = field_name.rsplit(".", 1)[0] + "." if "." in field_name else ""
        new_name = prefix + nm
        if any(x.name == new_name for x in iter_fields(pdf)):
            raise AppError("name_taken", f"A field named “{nm}” already exists")
        obj.T = pikepdf.String(nm)
    ff = f.ff
    for key, bit in (("readonly", FF_READONLY), ("required", FF_REQUIRED), ("multiline", FF_MULTILINE),
                     ("password", FF_PASSWORD), ("comb", FF_COMB), ("multiselect", FF_MULTISELECT), ("editable", FF_EDIT)):
        if key in props:
            ff = (ff | bit) if props[key] else (ff & ~bit)
    if ff != f.ff:
        obj.Ff = ff
    if "tooltip" in props:
        obj.TU = pikepdf.String(str(props["tooltip"] or ""))
    if "maxlen" in props and kind == "text":
        ml = int(props["maxlen"] or 0)
        if ml > 0:
            obj.MaxLen = ml
        elif "/MaxLen" in obj:
            del obj["/MaxLen"]
    if "align" in props and kind in ("text", "combo"):
        obj.Q = {"left": 0, "center": 1, "right": 2}.get(props["align"], 0)
    if "font_size" in props and kind in ("text", "combo", "list"):
        font, _size, color = _da(f)
        obj.DA = pikepdf.String(f"/{font} {fmt(max(0.0, float(props['font_size'] or 0)))} Tf {fmt(color[0])} {fmt(color[1])} {fmt(color[2])} rg")
    if "options" in props and kind in ("combo", "list"):
        opts = [str(o) for o in props["options"] if str(o).strip()]
        if not opts:
            raise AppError("invalid_request", "Add at least one option")
        obj.Opt = Array([pikepdf.String(o) for o in opts])
        cur = field_value(f)
        if kind == "combo" and cur and cur not in opts and not (ff & FF_EDIT):
            obj.V = pikepdf.String("")
        if kind == "list":
            keep = [v for v in (cur or []) if v in opts]
            obj.V = pikepdf.String(keep[0]) if keep else pikepdf.String("")
            if "/I" in obj:
                del obj["/I"]
    if "rect" in props:
        if widget is None:
            if len(f.widgets) != 1:
                raise AppError("invalid_request", "Choose which button of the group to move")
            target = f.widgets[0]
        else:
            ids = widget_ids(pdf)
            target = next((w for w in f.widgets if w.is_indirect and ids.get(w.objgen) == widget), None)
            if target is None:
                raise AppError("not_found", "Form field not found", status=404)
        x0, y0, x1, y1 = [float(v) for v in props["rect"]]
        r = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
        if r[2] - r[0] < 4 or r[3] - r[1] < 4:
            raise AppError("invalid_request", "The field is too small")
        target.Rect = Array(r)
        if kind in ("checkbox", "radio"):
            target.AP = Dictionary(N=_check_appearances(pdf, target, kind, on_state(target) or "Yes"))
        elif kind == "signature" and "/V" not in obj:
            target.AP = Dictionary(N=pdf.make_indirect(_signature_appearance(pdf, target)))
    f2 = find_field(pdf, new_name)
    res = Resources(pdf)
    refresh_appearance(pdf, res, f2)
    res.finalize()
    return {"name": new_name}


def delete_widget(pdf: pikepdf.Pdf, wid: str) -> dict:
    f, w = find_widget(pdf, wid)
    acro = pdf.Root.AcroForm
    # remove from page annotations
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if annots is None:
            continue
        keep = [a for a in annots if not (a.is_indirect and a.objgen == w.objgen)]
        if len(keep) != len(annots):
            page.obj.Annots = Array(keep)

    def remove_from(arr: pikepdf.Array, target) -> bool:
        for i, x in enumerate(arr):
            if x.is_indirect and target.is_indirect and x.objgen == target.objgen:
                del arr[i]
                return True
        return False

    removed_field = False
    if w.objgen == f.obj.objgen:
        # merged field/widget: remove the field itself
        parent = f.obj.get("/Parent")
        removed_field = remove_from(parent.Kids if parent is not None else acro.Fields, f.obj)
    else:
        remove_from(f.obj.Kids, w)
        if len(f.obj.Kids) == 0:
            parent = f.obj.get("/Parent")
            removed_field = remove_from(parent.Kids if parent is not None else acro.Fields, f.obj)
        elif f.kind == "radio" and _text(f.obj.get("/V")) == (on_state(w) or ""):
            f.obj.V = Name.Off
    return {"field": f.name, "field_removed": removed_field}


def flatten(pdf: pikepdf.Pdf, names: list[str] | None = None) -> int:
    """Draw the current appearance of fields into the page content and remove
    the fields. Returns the number of widgets flattened."""
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return 0
    pages = _page_map(pdf)
    res = Resources(pdf)
    writers: dict[int, PageWriter] = {}
    remove: set[tuple[int, int]] = set()
    count = 0
    targets = [f for f in iter_fields(pdf) if not names or f.name in names]
    for f in targets:
        for w in f.widgets:
            if not w.is_indirect:
                continue
            remove.add(w.objgen)
            page = pages.get(w.objgen)
            flags = int(w.get("/F", 0) or 0)
            if page is None or flags & 2:  # hidden
                continue
            ap = w.get("/AP")
            n = ap.get("/N") if ap is not None else None
            if isinstance(n, pikepdf.Dictionary) and not isinstance(n, pikepdf.Stream):
                st = n.get(str(w.get("/AS", "/Off")))
            else:
                st = n
            if not isinstance(st, pikepdf.Stream):
                continue
            bbox = [float(v) for v in st.get("/BBox", [0, 0, 1, 1])]
            mat = [float(v) for v in st.get("/Matrix", [1, 0, 0, 1, 0, 0])]
            rect = _rect(w)
            m = _fit_matrix(bbox, mat, rect)
            if m is None:
                continue
            pw = writers.get(page)
            if pw is None:
                pw = PageWriter(pdf, pdf.pages[page], res)
                writers[page] = pw
            if not st.is_indirect:
                st = pdf.make_indirect(st)
            xname = pw._name("/XObject", st)
            pw.op(f"q {' '.join(fmt(v) for v in m)} cm /{xname} Do Q")
            count += 1
    for pw in writers.values():
        pw.commit(overlay=True)
    res.finalize()
    # remove widgets from pages and fields from the form
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if annots is not None:
            keep = [a for a in annots if not (a.is_indirect and a.objgen in remove)]
            if len(keep) != len(annots):
                page.obj.Annots = Array(keep)
    flattened = {f.obj.objgen for f in targets if f.obj.is_indirect}

    def prune(arr: pikepdf.Array) -> pikepdf.Array:
        out = Array()
        for x in arr:
            if x.is_indirect and x.objgen in flattened:
                continue
            kids = x.get("/Kids")
            if kids is not None and any("/T" in k for k in kids):
                x.Kids = prune(kids)
                if len(x.Kids) == 0:
                    continue
            out.append(x)
        return out

    acro.Fields = prune(acro.Fields)
    if len(acro.Fields) == 0:
        del pdf.Root["/AcroForm"]
    return count


def _fit_matrix(bbox: list[float], mat: list[float], rect: list[float]) -> list[float] | None:
    """Matrix A of PDF 32000-1 §12.5.5: maps the transformed appearance box onto the annotation rectangle."""
    a, b, c, d, e, f_ = mat
    pts = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])]
    tx = [a * x + c * y + e for x, y in pts]
    ty = [b * x + d * y + f_ for x, y in pts]
    bx0, bx1, by0, by1 = min(tx), max(tx), min(ty), max(ty)
    if bx1 - bx0 < 1e-6 or by1 - by0 < 1e-6:
        return None
    sx = (rect[2] - rect[0]) / (bx1 - bx0)
    sy = (rect[3] - rect[1]) / (by1 - by0)
    # final = Matrix · A where A = scale+translate taking the bbox to rect
    A = [sx, 0, 0, sy, rect[0] - bx0 * sx, rect[1] - by0 * sy]
    return [
        a * A[0] + b * A[2], a * A[1] + b * A[3],
        c * A[0] + d * A[2], c * A[1] + d * A[3],
        e * A[0] + f_ * A[2] + A[4], e * A[1] + f_ * A[3] + A[5],
    ]


def export_data(pdf: pikepdf.Pdf) -> dict[str, Any]:
    return {f.name: field_value(f) for f in iter_fields(pdf) if f.kind in ("text", "checkbox", "radio", "combo", "list")}


def has_form(pdf: pikepdf.Pdf) -> bool:
    return any(True for _ in iter_fields(pdf))


__all__ = [
    "list_fields", "fill", "reset", "create", "update", "delete_widget", "flatten", "export_data", "has_form",
    "FIELD_TYPES",
]
