"""Coordinate conversion between PDF user space and MuPDF page space.

API contract: every coordinate exchanged with the frontend is expressed in
*PDF user space* (points, origin bottom-left of the MediaBox, y axis up,
unrotated). PyMuPDF works in an unrotated space whose origin is the top-left
corner of the CropBox with the y axis pointing down. Empirically (and per the
PyMuPDF docs) the conversion is::

    mupdf_x = pdf_x - cropbox.x0
    mupdf_y = (mediabox.y1 - cropbox.y0_top) - pdf_y

where ``page.cropbox`` is reported by PyMuPDF with a top-down y coordinate
relative to the MediaBox top edge. ``Page.transformation_matrix`` is *not*
used because it does not stay consistent once a page is rotated.
"""
from __future__ import annotations

from dataclasses import dataclass

import pymupdf as fitz


@dataclass(frozen=True)
class PageCoords:
    ox: float  # pdf x of the mupdf origin
    oy: float  # pdf y of the mupdf origin (top edge of the crop box)

    @classmethod
    def for_page(cls, page: fitz.Page) -> "PageCoords":
        cb = page.cropbox
        mb = page.mediabox
        return cls(ox=cb.x0, oy=mb.y1 - cb.y0)

    # --- points -------------------------------------------------------
    def to_mupdf(self, x: float, y: float) -> fitz.Point:
        return fitz.Point(x - self.ox, self.oy - y)

    def to_pdf(self, x: float, y: float) -> tuple[float, float]:
        return (x + self.ox, self.oy - y)

    # --- rects --------------------------------------------------------
    def rect_to_mupdf(self, r) -> fitz.Rect:
        """PDF rect [x0, y0, x1, y1] (y up) -> normalized mupdf Rect."""
        x0, y0, x1, y1 = r
        a = self.to_mupdf(x0, y0)
        b = self.to_mupdf(x1, y1)
        return fitz.Rect(a, b).normalize()

    def rect_to_pdf(self, r) -> list[float]:
        """mupdf rect (y down) -> PDF rect [x0, y0, x1, y1] with y0 < y1."""
        r = fitz.Rect(r)
        x0, ya = self.to_pdf(r.x0, r.y0)
        x1, yb = self.to_pdf(r.x1, r.y1)
        return [round(min(x0, x1), 3), round(min(ya, yb), 3), round(max(x0, x1), 3), round(max(ya, yb), 3)]

    def quad_to_pdf(self, q: fitz.Quad) -> list[list[float]]:
        return [list(map(lambda v: round(v, 3), self.to_pdf(p.x, p.y))) for p in (q.ul, q.ur, q.lr, q.ll)]


def page_geometry(page: fitz.Page) -> dict:
    """Geometry the frontend needs to map PDF space to the screen."""
    mb = page.mediabox
    cb = page.cropbox
    coords = PageCoords.for_page(page)
    # crop box in pdf space
    crop_pdf = [cb.x0, mb.y1 - cb.y1, cb.x1, mb.y1 - cb.y0]
    return {
        "width": round(page.rect.width, 3),  # unrotated, crop box
        "height": round(page.rect.height, 3),
        "rotation": page.rotation,
        "mediabox": [round(v, 3) for v in (mb.x0, mb.y0, mb.x1, mb.y1)],
        "cropbox": [round(v, 3) for v in crop_pdf],
        "origin": [coords.ox, coords.oy],
    }
