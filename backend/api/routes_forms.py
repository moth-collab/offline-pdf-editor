"""Interactive form (AcroForm) API."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import pikepdf
from fastapi import APIRouter
from pydantic import BaseModel, Field

from services import forms
from services.document_manager import manager

router = APIRouter()


class FillBody(BaseModel):
    values: dict[str, Any]
    base_revision: int | None = None


class CreateBody(BaseModel):
    page: int
    type: Literal["text", "checkbox", "radio", "combo", "list", "signature"]
    rect: list[float] = Field(min_length=4, max_length=4)
    name: str | None = Field(default=None, max_length=120)
    options: list[str] | None = Field(default=None, max_length=500)
    multiline: bool = False
    font_size: float = Field(default=0, ge=0, le=200)
    required: bool = False
    readonly: bool = False
    tooltip: str = Field(default="", max_length=500)
    export: str | None = Field(default=None, max_length=60)
    maxlen: int = Field(default=0, ge=0, le=10000)
    comb: bool = False
    password: bool = False
    multiselect: bool = False
    editable: bool = False
    align: Literal["left", "center", "right"] = "left"
    value: Any = None
    base_revision: int | None = None


class UpdateBody(BaseModel):
    field: str
    widget: str | None = None
    props: dict[str, Any]
    base_revision: int | None = None


class DeleteBody(BaseModel):
    widget: str
    base_revision: int | None = None


class NamesBody(BaseModel):
    names: list[str] | None = None
    base_revision: int | None = None


def _fill_allowed_without_owner(s) -> bool:
    """Restricted documents that allow form filling accept new values."""
    perms = s.source_permissions or {}
    return bool(s.source_encrypted and (perms.get("fill_forms") or perms.get("annotate")))


def _run(s, label: str, op, *, base_revision=None, check_editable=True, out: dict | None = None):
    def fn(src: Path, dst: Path):
        with pikepdf.open(src) as pdf:
            result = op(pdf)
            if out is not None:
                out["result"] = result
            pdf.save(dst)
        return {}

    res = s.mutate(label, fn, mode="file", base_rev=base_revision, check_editable=check_editable).to_dict()
    if out is not None:
        res["result"] = out.get("result")
    return res


@router.get("/documents/{doc_id}/forms")
def list_forms(doc_id: str):
    s = manager.get(doc_id)
    with pikepdf.open(s.working_path) as pdf:
        data = forms.list_fields(pdf)
    data["can_fill"] = bool(s.owner_authenticated or _fill_allowed_without_owner(s))
    data["can_edit"] = bool(s.owner_authenticated)
    return data


@router.post("/documents/{doc_id}/forms/fill")
def fill(doc_id: str, body: FillBody):
    s = manager.get(doc_id)
    n = len(body.values)
    label = "Fill in form field" if n == 1 else f"Fill in {n} form fields"
    return _run(s, label, lambda pdf: forms.fill(pdf, body.values), base_revision=body.base_revision,
                check_editable=not _fill_allowed_without_owner(s), out={})


@router.post("/documents/{doc_id}/forms/reset")
def reset(doc_id: str, body: NamesBody):
    s = manager.get(doc_id)
    return _run(s, "Reset form", lambda pdf: forms.reset(pdf, body.names), base_revision=body.base_revision,
                check_editable=not _fill_allowed_without_owner(s), out={})


@router.post("/documents/{doc_id}/forms/create")
def create(doc_id: str, body: CreateBody):
    s = manager.get(doc_id)
    kw = body.model_dump(exclude={"page", "type", "rect", "base_revision"})
    return _run(s, "Add form field", lambda pdf: forms.create(pdf, body.page, body.type, body.rect, **kw),
                base_revision=body.base_revision, out={})


@router.post("/documents/{doc_id}/forms/update")
def update(doc_id: str, body: UpdateBody):
    s = manager.get(doc_id)
    label = "Move form field" if set(body.props) == {"rect"} else "Change form field"
    return _run(s, label, lambda pdf: forms.update(pdf, body.field, body.props, body.widget),
                base_revision=body.base_revision, out={})


@router.post("/documents/{doc_id}/forms/delete")
def delete(doc_id: str, body: DeleteBody):
    s = manager.get(doc_id)
    return _run(s, "Delete form field", lambda pdf: forms.delete_widget(pdf, body.widget),
                base_revision=body.base_revision, out={})


@router.post("/documents/{doc_id}/forms/flatten")
def flatten(doc_id: str, body: NamesBody):
    s = manager.get(doc_id)
    return _run(s, "Flatten form", lambda pdf: forms.flatten(pdf, body.names), base_revision=body.base_revision, out={})


@router.get("/documents/{doc_id}/forms/data")
def form_data(doc_id: str):
    s = manager.get(doc_id)
    with pikepdf.open(s.working_path) as pdf:
        return {"values": forms.export_data(pdf)}
