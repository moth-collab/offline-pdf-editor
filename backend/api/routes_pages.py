"""Page organisation, merge, split, extract."""
from __future__ import annotations

import uuid
from pathlib import Path

import pymupdf as fitz
from fastapi import APIRouter

from core.config import get_settings
from core.errors import AppError
from models.schemas import (CopyPagesRequest, CropRequest, ExtractRequest, ImagesToPdfRequest, InsertBlankRequest,
                            InsertImagesRequest,
                            InsertFileRequest, MergeRequest, MovePagesRequest, PagesRequest, ReorderRequest,
                            ResizeRequest, RotateRequest, SplitRequest)
from services import merge_split, page_manager
from services.document_manager import manager

router = APIRouter()


def tmp_dir() -> Path:
    d = get_settings().sessions_root.parent / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _mutate(doc_id: str, label: str, fn, base_rev):
    return manager.get(doc_id).mutate(label, fn, base_rev=base_rev).to_dict()


@router.post("/documents/{doc_id}/pages/delete")
def delete(doc_id: str, req: PagesRequest):
    n = len(set(req.pages))
    return _mutate(doc_id, f"Delete {n} page{'s' if n > 1 else ''}",
                   lambda d: page_manager.delete_pages(d, req.pages), req.base_revision)


@router.post("/documents/{doc_id}/pages/rotate")
def rotate(doc_id: str, req: RotateRequest):
    return _mutate(doc_id, "Rotate pages", lambda d: page_manager.rotate_pages(d, req.pages, req.angle),
                   req.base_revision)


@router.post("/documents/{doc_id}/pages/reorder")
def reorder(doc_id: str, req: ReorderRequest):
    return _mutate(doc_id, "Reorder pages", lambda d: page_manager.reorder_pages(d, req.order), req.base_revision)


@router.post("/documents/{doc_id}/pages/move")
def move(doc_id: str, req: MovePagesRequest):
    return _mutate(doc_id, "Move pages", lambda d: page_manager.move_pages(d, req.pages, req.to), req.base_revision)


@router.post("/documents/{doc_id}/pages/reverse")
def reverse(doc_id: str, req: PagesRequest):
    return _mutate(doc_id, "Reverse page order", lambda d: page_manager.reverse_pages(d, req.pages or None),
                   req.base_revision)


@router.post("/documents/{doc_id}/pages/duplicate")
def duplicate(doc_id: str, req: PagesRequest):
    return _mutate(doc_id, "Duplicate pages", lambda d: page_manager.duplicate_pages(d, req.pages),
                   req.base_revision)


@router.post("/documents/{doc_id}/pages/insert-blank")
def insert_blank(doc_id: str, req: InsertBlankRequest):
    return _mutate(doc_id, "Insert blank page",
                   lambda d: page_manager.insert_blank(d, req.at, req.count, req.width, req.height),
                   req.base_revision)


@router.post("/documents/{doc_id}/pages/insert-file")
def insert_file(doc_id: str, req: InsertFileRequest):
    def fn(d: fitz.Document):
        src = merge_split._open_source(req.path, req.password)
        try:
            return page_manager.insert_from(d, src, req.at, req.pages)
        finally:
            src.close()

    return _mutate(doc_id, "Insert pages from file", fn, req.base_revision)


@router.post("/documents/{doc_id}/pages/insert-images")
def insert_images(doc_id: str, req: InsertImagesRequest):
    """Convert images to pages and insert them into the document (one undo step)."""
    s = manager.get(doc_id)
    if not req.paths:
        raise AppError("invalid_request", "Select at least one image")
    if not 0 <= req.margin <= 200:
        raise AppError("invalid_request", "Invalid margin")
    tmp = s.dir / f"images-{uuid.uuid4().hex[:8]}.pdf"

    def fn(d: fitz.Document):
        size: str | tuple[float, float] = req.page_size
        if req.page_size == "match":
            ref = d[min(max(req.at - 1, 0), d.page_count - 1)].rect
            size = (ref.width, ref.height) if ref.width <= ref.height else (ref.height, ref.width)
        merge_split.images_to_pdf(req.paths, tmp, size, req.margin)
        src = fitz.open(str(tmp))
        try:
            return page_manager.insert_from(d, src, req.at, None)
        finally:
            src.close()

    try:
        return _mutate(doc_id, f"Insert {len(req.paths)} image{'s' if len(req.paths) > 1 else ''}", fn, req.base_revision)
    finally:
        tmp.unlink(missing_ok=True)


@router.post("/documents/{doc_id}/pages/copy-from")
def copy_from(doc_id: str, req: CopyPagesRequest):
    """Paste pages copied from another open document (or the same one)."""
    source = manager.get(req.source_doc_id)
    src_path = source.working_path

    def fn(d: fitz.Document):
        src = fitz.open(str(src_path))
        try:
            return page_manager.insert_from(d, src, req.at, req.pages)
        finally:
            src.close()

    return _mutate(doc_id, "Paste pages", fn, req.base_revision)


@router.post("/documents/{doc_id}/pages/crop")
def crop(doc_id: str, req: CropRequest):
    return _mutate(doc_id, "Crop pages",
                   lambda d: page_manager.crop_pages(d, req.pages, req.box, req.margins, req.reset),
                   req.base_revision)


@router.post("/documents/{doc_id}/pages/resize")
def resize(doc_id: str, req: ResizeRequest):
    return _mutate(doc_id, "Resize pages",
                   lambda d: page_manager.resize_pages(d, req.pages, req.width, req.height, req.mode),
                   req.base_revision)


@router.post("/documents/{doc_id}/pages/extract")
def extract(doc_id: str, req: ExtractRequest):
    doc = manager.get(doc_id).open_read()
    return merge_split.extract(doc, req.pages, Path(req.target_path))


@router.post("/documents/{doc_id}/split")
def split(doc_id: str, req: SplitRequest):
    s = manager.get(doc_id)
    doc = s.open_read()
    base = Path(s.display_name).stem
    files = merge_split.split(doc, req.mode, Path(req.output_dir), base, ranges=req.ranges, every=req.every,
                              max_bytes=req.max_bytes, name_pattern=req.name_pattern)
    return {"files": files}


@router.post("/merge")
def merge(req: MergeRequest):
    out = tmp_dir() / f"merge-{uuid.uuid4().hex}.pdf"
    try:
        merge_split.merge([it.model_dump() for it in req.items], out)
        s = manager.create_from_file(out, req.display_name)
    finally:
        out.unlink(missing_ok=True)
    return s.info()


@router.post("/images-to-pdf")
def images_to_pdf(req: ImagesToPdfRequest):
    out = tmp_dir() / f"images-{uuid.uuid4().hex}.pdf"
    try:
        merge_split.images_to_pdf(req.paths, out, req.page_size, req.margin)
        s = manager.create_from_file(out, req.display_name)
    finally:
        out.unlink(missing_ok=True)
    return s.info()


@router.get("/page-sizes")
def page_sizes():
    return {"sizes": page_manager.page_size_presets()}


def _ensure(cond: bool, msg: str):
    if not cond:
        raise AppError("invalid_request", msg)
