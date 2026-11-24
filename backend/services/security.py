"""Document security: passwords & permissions (applied on save with AES-256)
and watermarks."""
from __future__ import annotations

import re
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name

from core.errors import AppError
from services.document_manager import DocumentSession
from services.fonts import font_index
from services.overlay_editor import ASSET_RE, assets_dir
from services.pdf_writer import WriterSession, box_matrix, make_image_xobject, mat_mul, mat_rotate_cw, mat_translate, parse_color
from services.text_layout import TextStyle, layout_text, load_face

PERM_KEYS = ("print", "print_high_quality", "modify", "copy", "annotate", "fill_forms", "assemble")


def set_protection(s: DocumentSession, user_password: str | None, owner_password: str | None, permissions: dict) -> dict:
    if not user_password and not owner_password:
        raise AppError("invalid_request", "Enter a password to open the document and/or a permissions password")
    for pw in (user_password, owner_password):
        if pw and len(pw) > 127:
            raise AppError("invalid_request", "Passwords are limited to 127 characters")
    if user_password and owner_password and user_password == owner_password:
        raise AppError("invalid_request", "The permissions password must differ from the open password")
    perms = {k: bool(permissions.get(k, True)) for k in PERM_KEYS}
    s.ensure_editable()
    s.security = {"user_password": user_password or "", "owner_password": owner_password or None,
                  "permissions": perms, "preserved": False, "owner_unknown": False}
    return s.info()


def remove_protection(s: DocumentSession) -> dict:
    """Remove passwords. Only possible with full (owner) access."""
    if not s.owner_authenticated:
        raise AppError("permission_denied", "Enter the permissions (owner) password first to remove the security",
                       status=403)
    s.security = None
    return s.info()


# ----------------------------------------------------------------------
# watermark
# ----------------------------------------------------------------------

def _ocg(pdf: pikepdf.Pdf, name: str) -> pikepdf.Object:
    root = pdf.Root
    if Name.OCProperties not in root:
        root.OCProperties = Dictionary(OCGs=Array(), D=Dictionary(Order=Array(), ON=Array()))
    props = root.OCProperties
    for ocg in props.OCGs:
        if str(ocg.get("/Name", "")) == name:
            return ocg
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=pikepdf.String(name),
                                       Usage=Dictionary(Print=Dictionary(PrintState=Name.ON),
                                                        View=Dictionary(ViewState=Name.ON))))
    props.OCGs.append(ocg)
    d = props.D
    if Name.Order not in d:
        d.Order = Array()
    d.Order.append(ocg)
    if Name.ON not in d:
        d.ON = Array()
    d.ON.append(ocg)
    return ocg


def add_watermark(src: Path, dst: Path, spec: dict) -> dict:
    """spec: text | asset_id, font, size, color, opacity, rotation, position
    (center|top|bottom|tile), pages (list|None), behind (bool)."""
    text = str(spec.get("text") or "")
    asset = spec.get("asset_id")
    if not text.strip() and not asset:
        raise AppError("invalid_request", "Enter watermark text or choose an image")
    opacity = max(0.02, min(1.0, float(spec.get("opacity", 0.25))))
    rotation = float(spec.get("rotation", 45))
    position = spec.get("position", "center")
    behind = bool(spec.get("behind", False))
    color = parse_color(spec.get("color") or "#c00000") or (0.75, 0, 0)
    with pikepdf.open(str(src)) as pdf:
        n = len(pdf.pages)
        pages = [p for p in (spec.get("pages") or range(n)) if 0 <= int(p) < n]
        ws = WriterSession(pdf)
        ocg = _ocg(pdf, "Watermark")
        style = None
        lay = None
        img = None
        if text.strip():
            face = font_index.find(spec.get("font") or "Noto Sans", True, False) or font_index.for_script("latin", True)
            style = TextStyle(font=load_face(face), size=float(spec.get("size") or 60), color=color, bold=True,
                              opacity=opacity, align="center", line_height=1.15)
            lay = layout_text(text, style)
        elif asset:
            if not ASSET_RE.match(str(asset)) or not (assets_dir() / str(asset)).is_file():
                raise AppError("invalid_asset", "The watermark image is not available")
            img = make_image_xobject(pdf, (assets_dir() / str(asset)).read_bytes())
        for pno in pages:
            page = pdf.pages[int(pno)]
            box = page.cropbox if Name.CropBox in page.obj else page.mediabox
            x0, y0, x1, y1 = [float(v) for v in box]
            pw, ph = x1 - x0, y1 - y0
            w = ws.page(int(pno), overlay=not behind)
            w.begin_marked("Artifact", "<</Type /Pagination /Subtype /Watermark>>")
            w.begin_oc(ocg)
            if lay is not None:
                tw = max((ln.width for ln in lay.lines), default=0)
                th = lay.height
                centers = []
                if position == "tile":
                    step_x, step_y = max(tw * 1.4, 150), max(th * 3, 120)
                    yy = y0 + step_y / 2
                    while yy < y1:
                        xx = x0 + step_x / 2
                        while xx < x1:
                            centers.append((xx, yy))
                            xx += step_x
                        yy += step_y
                else:
                    cy = {"top": y1 - ph * 0.15, "bottom": y0 + ph * 0.15}.get(position, (y0 + y1) / 2)
                    centers.append(((x0 + x1) / 2, cy))
                for cx, cy in centers:
                    # local frame: text box centred on (cx, cy), rotated counter-clockwise visually
                    m = mat_translate(-tw / 2, th / 2)
                    m = mat_mul(m, mat_rotate_cw(-rotation))
                    m = mat_mul(m, mat_translate(cx, cy))
                    w.text_layout(lay, style, m)
            else:
                scale = float(spec.get("scale", 0.5))
                iw = pw * scale
                ih = iw * img.height / img.width
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                w.image(img.xobj, iw, ih, box_matrix([cx - iw / 2, cy - ih / 2, cx + iw / 2, cy + ih / 2], -rotation),
                        opacity=opacity)
            w.end_marked()
            w.end_marked()
        ws.commit()
        pdf.save(str(dst))
    return {"pages": len(pages)}


def sanitize_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
