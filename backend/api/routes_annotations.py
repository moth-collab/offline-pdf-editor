"""Annotation (comments) API."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from core.errors import AppError
from services import annotations as ann
from services.document_manager import manager

router = APIRouter()


class AddBody(BaseModel):
    page: int
    spec: dict[str, Any]
    author: str = "User"
    base_revision: int | None = None


class UpdateBody(BaseModel):
    page: int
    xref: int
    spec: dict[str, Any]
    author: str | None = None
    base_revision: int | None = None


class DeleteBody(BaseModel):
    page: int
    xrefs: list[int]
    base_revision: int | None = None


class FlattenBody(BaseModel):
    base_revision: int | None = None


def _page(doc, page: int):
    if not 0 <= page < doc.page_count:
        raise AppError("invalid_page", "Page out of range")
    return doc[page]


@router.get("/documents/{doc_id}/pages/{page}/annotations")
def page_annotations(doc_id: str, page: int):
    doc = manager.get(doc_id).open_read()
    return {"annotations": ann.list_page(_page(doc, page))}


@router.get("/documents/{doc_id}/annotations")
def all_annotations(doc_id: str):
    doc = manager.get(doc_id).open_read()
    return {"annotations": ann.list_all(doc)}


def _needs_owner(s) -> bool:
    """Restricted documents that still allow commenting accept annotations."""
    perms = s.source_permissions or {}
    return not (s.source_encrypted and perms.get("annotate"))


@router.post("/documents/{doc_id}/annotations/add")
def add(doc_id: str, body: AddBody):
    s = manager.get(doc_id)
    out: dict = {}

    def fn(doc):
        out["annotation"] = ann.add(_page(doc, body.page), body.spec, body.author[:200])
        return {"modified": [body.page]}

    label = f"Add {body.spec.get('type', 'comment')}"
    res = s.mutate(label, fn, base_rev=body.base_revision, check_editable=_needs_owner(s)).to_dict()
    res.update(out)
    return res


@router.post("/documents/{doc_id}/annotations/update")
def update(doc_id: str, body: UpdateBody):
    s = manager.get(doc_id)
    out: dict = {}

    def fn(doc):
        out["annotation"] = ann.update(_page(doc, body.page), body.xref, body.spec, body.author)
        return {"modified": [body.page]}

    res = s.mutate("Edit comment", fn, base_rev=body.base_revision, check_editable=_needs_owner(s)).to_dict()
    res.update(out)
    return res


@router.post("/documents/{doc_id}/annotations/delete")
def delete(doc_id: str, body: DeleteBody):
    s = manager.get(doc_id)

    def fn(doc):
        n = ann.delete(_page(doc, body.page), body.xrefs)
        if not n:
            raise AppError("annotation_not_found", "The comment no longer exists")
        return {"modified": [body.page]}

    return s.mutate("Delete comment", fn, base_rev=body.base_revision, check_editable=_needs_owner(s)).to_dict()


@router.post("/documents/{doc_id}/annotations/flatten")
def flatten(doc_id: str, body: FlattenBody):
    s = manager.get(doc_id)
    holder: dict = {}

    def fn(doc):
        holder["count"] = ann.flatten(doc)
        return {"modified": list(range(doc.page_count))}

    res = s.mutate("Flatten comments", fn, base_rev=body.base_revision, full_save=True).to_dict()
    res["flattened"] = holder.get("count", 0)
    return res
