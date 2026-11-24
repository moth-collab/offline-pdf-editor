"""Edit existing images: list images placed on a page and detach one into an
editable overlay image object (original pixels and alpha preserved)."""
from __future__ import annotations

import hashlib
import math

import pymupdf as fitz

from core.coords import PageCoords
from core.errors import AppError
from services.overlay_editor import assets_dir


def _placement(page: fitz.Page, info: dict) -> dict:
    """Derive rect (PDF space, unrotated box), rotation (cw degrees) and flips
    from the image transform (unit square -> MuPDF page space)."""
    coords = PageCoords.for_page(page)
    m = fitz.Matrix(info["transform"])
    corners = [fitz.Point(0, 0) * m, fitz.Point(1, 0) * m, fitz.Point(1, 1) * m, fitz.Point(0, 1) * m]
    pdf = [coords.to_pdf(p.x, p.y) for p in corners]
    (x0, y0), (x1, y1), _p2, (x3, y3) = pdf
    w = math.hypot(x1 - x0, y1 - y0)
    h = math.hypot(x3 - x0, y3 - y0)
    cx = sum(p[0] for p in pdf) / 4
    cy = sum(p[1] for p in pdf) / 4
    # image x axis direction in PDF space; clockwise rotation on screen = -atan2
    ang = -math.degrees(math.atan2(y1 - y0, x1 - x0))
    # MuPDF image space has y down: the image top edge maps from corner 0 -> 1.
    det = (x1 - x0) * (y3 - y0) - (y1 - y0) * (x3 - x0)
    flip_v = det > 0  # in PDF (y up) a normal image has its 2nd axis pointing down
    return {"rect": [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], "rotation": round(ang, 3) % 360,
            "flipV": flip_v}


def list_images(doc: fitz.Document, page: fitz.Page) -> list[dict]:
    out = []
    counts: dict[int, int] = {}
    infos = page.get_image_info(xrefs=True)
    for info in infos:
        counts[info["xref"]] = counts.get(info["xref"], 0) + 1
    coords = PageCoords.for_page(page)
    for info in infos:
        xref = info["xref"]
        if not xref:
            continue  # inline image: not individually editable
        p = _placement(page, info)
        out.append({
            "xref": xref,
            "bbox": coords.rect_to_pdf(info["bbox"]),
            "width": info["width"],
            "height": info["height"],
            "shared": counts[xref] > 1 or _used_elsewhere(doc, page.number, xref),
            **p,
        })
    return out


def _used_elsewhere(doc: fitz.Document, pno: int, xref: int) -> bool:
    for i in range(doc.page_count):
        if i == pno:
            continue
        if any(img[0] == xref for img in doc.get_page_images(i, full=True)):
            return True
    return False


def image_bytes(doc: fitz.Document, xref: int) -> tuple[bytes, str]:
    info = doc.extract_image(xref)
    if not info:
        raise AppError("image_unreadable", "This image cannot be read")
    smask = info.get("smask") or 0
    if info.get("ext") in ("jpeg", "jpg") and not smask and info.get("colorspace") in (1, 3):
        return info["image"], "jpg"
    pix = fitz.Pixmap(doc, xref)
    if pix.colorspace and pix.colorspace.n not in (1, 3):
        pix = fitz.Pixmap(fitz.csRGB, pix)
    if smask:
        mask = fitz.Pixmap(doc, smask)
        if pix.alpha:
            pix = fitz.Pixmap(pix, 0)
        pix = fitz.Pixmap(pix, mask)
    return pix.tobytes("png"), "png"


def detach_image(doc: fitz.Document, page_index: int, xref: int) -> dict:
    page = doc[page_index]
    infos = [i for i in page.get_image_info(xrefs=True) if i["xref"] == xref]
    if not infos:
        raise AppError("image_not_found", "The image was not found on this page")
    if len(infos) > 1 or _used_elsewhere(doc, page_index, xref):
        raise AppError("image_shared", "This image is used in several places and cannot be edited individually")
    data, ext = image_bytes(doc, xref)
    placement = _placement(page, infos[0])
    asset_id = f"{hashlib.sha256(data).hexdigest()[:40]}.{ext}"
    target = assets_dir() / asset_id
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(data)
    page.delete_image(xref)
    return {"asset_id": asset_id, "natural_width": infos[0]["width"], "natural_height": infos[0]["height"], **placement}
