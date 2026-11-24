"""Direct text editing API."""
from __future__ import annotations

from typing import Any

import pymupdf as fitz
from fastapi import APIRouter
from pydantic import BaseModel

from core.errors import AppError
from services import direct_text_editor as dte
from services.document_manager import manager
from services.text_extraction import page_text_objects

router = APIRouter()


class TextEditBody(BaseModel):
    page: int
    line_ids: list[str]
    new_text: str
    font_family: str | None = None
    size: float | None = None
    color: str | None = None
    bold: bool | None = None
    italic: bool | None = None
    underline: bool = False
    strike: bool = False
    align: str | None = None
    line_height: float | None = None
    char_spacing: float = 0.0
    box: list[float] | None = None
    offset: list[float] | None = None
    fit: str = "overflow"
    base_revision: int | None = None
    accept_warnings: bool = False


def _req(body: TextEditBody) -> dte.EditRequest:
    d: dict[str, Any] = body.model_dump(exclude={"base_revision", "accept_warnings"})
    if len(d["new_text"]) > 20000:
        raise AppError("too_long", "The text is too long")
    return dte.EditRequest.from_dict(d)


@router.get("/documents/{doc_id}/pages/{page}/text-objects")
def text_objects(doc_id: str, page: int):
    doc = manager.get(doc_id).open_read()
    if not 0 <= page < doc.page_count:
        raise AppError("invalid_page", "Page out of range")
    return page_text_objects(doc, doc[page])


@router.post("/documents/{doc_id}/text/preview")
def text_preview(doc_id: str, body: TextEditBody):
    doc = manager.get(doc_id).open_read()
    return dte.preview(doc, _req(body))


@router.post("/documents/{doc_id}/text/apply")
def text_apply(doc_id: str, body: TextEditBody):
    s = manager.get(doc_id)
    req = _req(body)
    holder: dict = {}

    def fn(src, dst):
        doc = fitz.open(str(src))
        try:
            plan = dte.plan_edit(doc, req)
            if plan.report.level == "caution" and not body.accept_warnings:
                raise AppError("confirmation_required", "Review the warnings and confirm the edit", status=409,
                               details=plan.report.to_dict())
            data, report = dte.apply(doc, req)
        finally:
            doc.close()
        dst.write_bytes(data)
        holder["report"] = report
        return {"modified": [req.page]}

    label = "Delete text" if not req.new_text.strip() else "Edit text"
    res = s.mutate(label, fn, mode="file", base_rev=body.base_revision).to_dict()
    res["report"] = holder.get("report")
    return res
