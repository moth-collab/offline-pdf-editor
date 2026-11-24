"""Overlay flattening and other editing tools."""
from __future__ import annotations

from fastapi import APIRouter

from models.schemas import FlattenOverlaysRequest
from services.document_manager import manager
from services.overlay_editor import bake_overlays

router = APIRouter()


@router.post("/documents/{doc_id}/overlays/flatten")
def flatten_overlays(doc_id: str, req: FlattenOverlaysRequest):
    """Permanently write overlay objects into the page content (new revision)."""
    s = manager.get(doc_id)
    pages = sorted({int(o.get("page", 0)) for o in req.overlays})

    def fn(src, dst):
        res = bake_overlays(src, dst, req.overlays)
        return {"modified": pages, "warnings": res["warnings"]}

    return s.mutate("Flatten objects", fn, mode="file", base_rev=req.base_revision).to_dict()


# ----------------------------------------------------------------------
# existing images
# ----------------------------------------------------------------------
from pydantic import BaseModel  # noqa: E402

from core.errors import AppError  # noqa: E402
from services import image_editor  # noqa: E402


class DetachImageRequest(BaseModel):
    page: int
    xref: int
    base_revision: int | None = None


@router.get("/documents/{doc_id}/pages/{page}/images")
def page_images(doc_id: str, page: int):
    doc = manager.get(doc_id).open_read()
    if not 0 <= page < doc.page_count:
        raise AppError("invalid_page", "Page out of range")
    return {"images": image_editor.list_images(doc, doc[page])}


@router.post("/documents/{doc_id}/images/detach")
def detach_image(doc_id: str, req: DetachImageRequest):
    """Remove an image from the page content and return it as an editable object."""
    s = manager.get(doc_id)
    out: dict = {}

    def fn(doc):
        out.update(image_editor.detach_image(doc, req.page, req.xref))
        return {"modified": [req.page]}

    res = s.mutate("Edit image", fn, base_rev=req.base_revision).to_dict()
    res["image"] = out
    return res


# ----------------------------------------------------------------------
# headers, footers, page numbers, Bates numbering
# ----------------------------------------------------------------------
from pathlib import Path  # noqa: E402
from typing import Literal  # noqa: E402

import pikepdf  # noqa: E402
from pydantic import Field  # noqa: E402

from services import header_footer  # noqa: E402


class HFMargins(BaseModel):
    top: float = Field(default=28, ge=0, le=500)
    bottom: float = Field(default=28, ge=0, le=500)
    left: float = Field(default=36, ge=0, le=500)
    right: float = Field(default=36, ge=0, le=500)


class HFBates(BaseModel):
    prefix: str = Field(default="", max_length=40)
    suffix: str = Field(default="", max_length=40)
    start: int = Field(default=1, ge=0, le=10**11)
    digits: int = Field(default=6, ge=1, le=12)


class HeaderFooterBody(BaseModel):
    top_left: str = Field(default="", max_length=300, alias="top-left")
    top_center: str = Field(default="", max_length=300, alias="top-center")
    top_right: str = Field(default="", max_length=300, alias="top-right")
    bottom_left: str = Field(default="", max_length=300, alias="bottom-left")
    bottom_center: str = Field(default="", max_length=300, alias="bottom-center")
    bottom_right: str = Field(default="", max_length=300, alias="bottom-right")
    font: str = Field(default="Sarabun", max_length=120)
    font_size: float = Field(default=10, ge=4, le=72)
    color: str = Field(default="#000000", max_length=20)
    margins: HFMargins = HFMargins()
    pages: list[int] | None = None
    start_number: int = Field(default=1, ge=0, le=10**7)
    count_selected_only: bool = False
    date_format: Literal["dmy", "us", "iso", "thai", "thai-short"] = "dmy"
    thai_digits: bool = False
    bates: HFBates = HFBates()
    base_revision: int | None = None

    model_config = {"populate_by_name": True}


def _hf_spec(body: HeaderFooterBody) -> dict:
    spec = body.model_dump(by_alias=True, exclude={"base_revision"})
    return spec


@router.post("/documents/{doc_id}/header-footer")
def add_header_footer(doc_id: str, body: HeaderFooterBody):
    s = manager.get(doc_id)
    name = Path(s.display_name).stem

    def fn(src, dst):
        with pikepdf.open(src) as pdf:
            res = header_footer.apply(pdf, _hf_spec(body), file_name=name)
            pdf.save(dst)
        return {"modified": body.pages or None, **res}

    return s.mutate("Header & footer", fn, mode="file", base_rev=body.base_revision).to_dict()


class RevBody(BaseModel):
    base_revision: int | None = None


@router.post("/documents/{doc_id}/header-footer/remove")
def remove_header_footer(doc_id: str, body: RevBody):
    s = manager.get(doc_id)

    def fn(src, dst):
        with pikepdf.open(src) as pdf:
            n = header_footer.remove(pdf)
            if not n:
                raise AppError("nothing_to_remove", "This document has no header or footer added by this application")
            pdf.save(dst)
        return {}

    return s.mutate("Remove header & footer", fn, mode="file", base_rev=body.base_revision).to_dict()


@router.get("/documents/{doc_id}/header-footer")
def header_footer_state(doc_id: str):
    s = manager.get(doc_id)
    with pikepdf.open(s.working_path) as pdf:
        return {"present": header_footer.has_header_footer(pdf)}


# ----------------------------------------------------------------------
# compare documents
# ----------------------------------------------------------------------
import shutil  # noqa: E402
import uuid  # noqa: E402

from services import compare as compare_service  # noqa: E402
from services.saving import build_output  # noqa: E402


class CompareBody(BaseModel):
    old_doc_id: str | None = None
    old_path: str | None = None
    new_doc_id: str | None = None
    new_path: str | None = None
    old_overlays: list[dict] = []
    new_overlays: list[dict] = []


def _compare_source(doc_id: str | None, path: str | None, overlays: list[dict], tmp_dir: Path, tag: str) -> tuple[Path, str]:
    if doc_id:
        s = manager.get(doc_id)
        target = tmp_dir / f"{tag}.pdf"
        # the open document as it is now, including unsaved objects (working copies are unencrypted)
        build_output(s, target, overlays, garbage=0)
        return target, Path(s.display_name).stem
    if path:
        p = Path(path)
        if not p.is_file():
            raise AppError("not_found", "The file no longer exists", status=404)
        return p, p.stem
    raise AppError("invalid_request", "Choose two documents to compare")


@router.post("/compare")
def compare_documents(body: CompareBody):
    from core.config import get_settings

    tmp_dir = get_settings().sessions_root.parent / "tmp" / f"compare-{uuid.uuid4().hex[:8]}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        a, a_name = _compare_source(body.old_doc_id, body.old_path, body.old_overlays, tmp_dir, "old")
        b, b_name = _compare_source(body.new_doc_id, body.new_path, body.new_overlays, tmp_dir, "new")
        out = tmp_dir / "comparison.pdf"
        res = compare_service.compare(a, b, out, a_name=a_name, b_name=b_name)
        s = manager.create_from_file(out, f"{a_name} ↔ {b_name}.pdf")
        info = s.info()
        info["comparison"] = res
        return info
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
