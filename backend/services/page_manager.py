"""Page-level operations. Each function mutates an opened fitz document and
returns ``{"page_map": [...], "modified": [...]}`` where ``page_map[new] =
old index or None`` (new page). The frontend uses it to keep thumbnails and
overlay objects attached to the right pages."""
from __future__ import annotations

import pymupdf as fitz

from core.coords import PageCoords
from core.errors import AppError


def _check_pages(doc: fitz.Document, pages: list[int]) -> list[int]:
    if not pages:
        raise AppError("invalid_request", "No pages selected")
    out = sorted(set(pages))
    for p in out:
        if not 0 <= p < doc.page_count:
            raise AppError("invalid_page", f"Page {p + 1} does not exist")
    return out


def identity_map(n: int) -> list[int | None]:
    return list(range(n))


def delete_pages(doc: fitz.Document, pages: list[int]) -> dict:
    pages = _check_pages(doc, pages)
    if len(pages) >= doc.page_count:
        raise AppError("invalid_request", "A document must keep at least one page")
    keep = [i for i in range(doc.page_count) if i not in set(pages)]
    doc.delete_pages(pages)
    return {"page_map": keep, "modified": []}


def rotate_pages(doc: fitz.Document, pages: list[int], angle: int) -> dict:
    if angle % 90:
        raise AppError("invalid_request", "Rotation must be a multiple of 90 degrees")
    pages = _check_pages(doc, pages)
    for p in pages:
        page = doc[p]
        page.set_rotation((page.rotation + angle) % 360)
    return {"page_map": identity_map(doc.page_count), "modified": pages}


def reorder_pages(doc: fitz.Document, order: list[int]) -> dict:
    n = doc.page_count
    if sorted(order) != list(range(n)):
        raise AppError("invalid_request", "The new order must contain every page exactly once")
    doc.select(order)
    return {"page_map": list(order), "modified": []}


def move_pages(doc: fitz.Document, pages: list[int], to: int) -> dict:
    pages = _check_pages(doc, pages)
    rest = [i for i in range(doc.page_count) if i not in set(pages)]
    to = max(0, min(to, len(rest)))
    order = rest[:to] + pages + rest[to:]
    return reorder_pages(doc, order)


def reverse_pages(doc: fitz.Document, pages: list[int] | None = None) -> dict:
    n = doc.page_count
    sel = _check_pages(doc, pages) if pages else list(range(n))
    rev = list(reversed(sel))
    order = list(range(n))
    for i, p in enumerate(sel):
        order[p] = rev[i]
    return reorder_pages(doc, order)


def duplicate_pages(doc: fitz.Document, pages: list[int]) -> dict:
    pages = _check_pages(doc, pages)
    page_map: list[int | None] = list(range(doc.page_count))
    # insert copies right after each original, from the back to keep indices valid
    for p in reversed(pages):
        doc.fullcopy_page(p, p + 1)
        page_map.insert(p + 1, None)
    # fullcopy keeps content; report new pages as None so the UI renders them fresh
    return {"page_map": page_map, "modified": []}


def insert_blank(doc: fitz.Document, at: int, count: int = 1, width: float | None = None,
                 height: float | None = None) -> dict:
    n = doc.page_count
    at = max(0, min(at, n))
    if not width or not height:
        ref = doc[min(at, n - 1)] if n else None
        width = width or (ref.rect.width if ref else 595.28)
        height = height or (ref.rect.height if ref else 841.89)
    count = max(1, min(count, 500))
    for i in range(count):
        doc.new_page(at + i, width=width, height=height)
    page_map: list[int | None] = list(range(n))
    page_map[at:at] = [None] * count
    return {"page_map": page_map, "modified": []}


def insert_from(doc: fitz.Document, src: fitz.Document, at: int, pages: list[int] | None = None) -> dict:
    n = doc.page_count
    at = max(0, min(at, n))
    sel = _check_pages(src, pages) if pages else list(range(src.page_count))
    inserted = 0
    # contiguous ranges keep insert_pdf efficient
    ranges: list[tuple[int, int]] = []
    for p in sel:
        if ranges and p == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], p)
        else:
            ranges.append((p, p))
    pos = at
    for a, b in ranges:
        doc.insert_pdf(src, from_page=a, to_page=b, start_at=pos, links=True, annots=True, widgets=True)
        pos += b - a + 1
        inserted += b - a + 1
    page_map: list[int | None] = list(range(n))
    page_map[at:at] = [None] * inserted
    return {"page_map": page_map, "modified": [], "inserted": inserted}


def crop_pages(doc: fitz.Document, pages: list[int], box: list[float] | None = None,
               margins: list[float] | None = None, reset: bool = False) -> dict:
    """Set the crop box. ``box`` in PDF coordinates; ``margins`` = left, bottom,
    right, top in points measured inward from the current crop box."""
    pages = _check_pages(doc, pages)
    for p in pages:
        page = doc[p]
        mb = page.mediabox
        if reset:
            # set_cropbox expects raw x and top-down y measured from the media box top
            page.set_cropbox(fitz.Rect(mb.x0, 0, mb.x1, mb.y1 - mb.y0))
            continue
        coords = PageCoords.for_page(page)
        if box:
            target = coords.rect_to_mupdf(box)
        elif margins:
            l, b, r, t = margins
            rr = page.rect
            target = fitz.Rect(rr.x0 + l, rr.y0 + t, rr.x1 - r, rr.y1 - b)
        else:
            raise AppError("invalid_request", "Provide a crop box or margins")
        # target is relative to the current crop box: convert to media-box based coords
        cb = page.cropbox
        target = fitz.Rect(target.x0 + cb.x0, target.y0 + cb.y0, target.x1 + cb.x0, target.y1 + cb.y0)
        target &= fitz.Rect(mb.x0, 0, mb.x1, mb.y1 - mb.y0)  # never exceed the media box
        if target.is_empty or target.width < 10 or target.height < 10:
            raise AppError("invalid_request", "The crop area is too small")
        try:
            page.set_cropbox(target)
        except ValueError as exc:
            raise AppError("invalid_request", f"Invalid crop area: {exc}") from exc
    return {"page_map": identity_map(doc.page_count), "modified": pages}


def resize_pages(doc: fitz.Document, pages: list[int], width: float, height: float, mode: str = "fit") -> dict:
    """Change page size, scaling the existing content into the new size.

    The content is placed via ``show_pdf_page`` (vector, text stays text).
    Annotations on resized pages are re-created by copying them.
    """
    pages = _check_pages(doc, pages)
    if width < 36 or height < 36 or width > 14400 or height > 14400:
        raise AppError("invalid_request", "Page size must be between 0.5 and 200 inches")
    src = fitz.open()
    src.insert_pdf(doc)
    transforms = {}
    for p in pages:
        old = doc[p]
        rot = old.rotation
        old_rect = src[p].rect
        doc.delete_page(p)
        newp = doc.new_page(p, width=width, height=height)
        if mode == "stretch":
            target = newp.rect
            keep = False
        elif mode == "center":
            target = fitz.Rect(0, 0, old_rect.width, old_rect.height)
            target += ((width - old_rect.width) / 2, (height - old_rect.height) / 2) * 2
            keep = True
        else:
            target = newp.rect
            keep = True
        src[p].set_rotation(0)
        newp.show_pdf_page(target, src, p, keep_proportion=keep)
        if rot:
            newp.set_rotation(rot)
        transforms[p] = {"from": [old_rect.width, old_rect.height], "to": [width, height], "mode": mode}
    src.close()
    return {"page_map": identity_map(doc.page_count), "modified": pages, "transforms": transforms}


def page_size_presets() -> dict:
    return {
        "A3": (841.89, 1190.55), "A4": (595.28, 841.89), "A5": (419.53, 595.28),
        "Letter": (612, 792), "Legal": (612, 1008), "Tabloid": (792, 1224),
    }
