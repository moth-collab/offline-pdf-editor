"""Security, watermark, redaction, signatures and job result endpoints."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

import pymupdf as fitz
from fastapi import APIRouter
from pydantic import BaseModel

from core.errors import AppError
from core.jobs import job_manager
from services import ocr, redaction, security, signatures
from services.document_manager import manager, validate_pdf
from services.saving import build_output

router = APIRouter()


# ---------------------------------------------------------------- passwords & permissions
class ProtectBody(BaseModel):
    user_password: str | None = None
    owner_password: str | None = None
    permissions: dict[str, bool] = {}


class PasswordBody(BaseModel):
    password: str


@router.post("/documents/{doc_id}/security/protect")
def protect(doc_id: str, body: ProtectBody):
    return security.set_protection(manager.get(doc_id), body.user_password, body.owner_password, body.permissions)


@router.post("/documents/{doc_id}/security/remove")
def remove_security(doc_id: str):
    return security.remove_protection(manager.get(doc_id))


@router.post("/documents/{doc_id}/security/unlock")
def unlock(doc_id: str, body: PasswordBody):
    return manager.get(doc_id).unlock(body.password)


# ---------------------------------------------------------------- watermark
class WatermarkBody(BaseModel):
    spec: dict[str, Any]
    base_revision: int | None = None


@router.post("/documents/{doc_id}/watermark")
def watermark(doc_id: str, body: WatermarkBody):
    s = manager.get(doc_id)

    def fn(src, dst):
        res = security.add_watermark(src, dst, body.spec)
        return {"modified": list(range(res["pages"]))}

    return s.mutate("Add watermark", fn, mode="file", base_rev=body.base_revision).to_dict()


# ---------------------------------------------------------------- redaction
class RedactSearchBody(BaseModel):
    query: str | None = None
    pattern: str | None = None
    case_sensitive: bool = False


class RedactMarkBody(BaseModel):
    items: list[dict[str, Any]]
    base_revision: int | None = None


class RedactApplyBody(BaseModel):
    images: str = "pixels"
    graphics: str = "covered"
    fill: bool = True
    sanitize: dict[str, bool] = {}
    base_revision: int | None = None


class SanitizeBody(BaseModel):
    options: dict[str, bool]
    base_revision: int | None = None


@router.post("/documents/{doc_id}/redact/search")
def redact_search(doc_id: str, body: RedactSearchBody):
    doc = manager.get(doc_id).open_read()
    return {"matches": redaction.search(doc, body.query, body.pattern, body.case_sensitive)[:5000]}


@router.post("/documents/{doc_id}/redact/mark")
def redact_mark(doc_id: str, body: RedactMarkBody):
    if not body.items:
        raise AppError("invalid_request", "Nothing selected to mark")
    s = manager.get(doc_id)
    pages = sorted({int(i["page"]) for i in body.items})

    def fn(doc):
        redaction.mark(doc, body.items)
        return {"modified": pages}

    return s.mutate(f"Mark {len(body.items)} areas for redaction", fn, base_rev=body.base_revision).to_dict()


@router.get("/documents/{doc_id}/redact/pending")
def redact_pending(doc_id: str):
    return {"marks": redaction.pending(manager.get(doc_id).open_read())}


@router.post("/documents/{doc_id}/redact/apply")
def redact_apply(doc_id: str, body: RedactApplyBody):
    s = manager.get(doc_id)
    holder: dict = {}

    def fn(doc):
        holder["report"] = redaction.apply(doc, body.images, body.graphics, body.fill, body.sanitize)
        return {"modified": holder["report"]["pages"]}

    # full rewrite: removed objects must not survive in the file
    res = s.mutate("Apply redactions", fn, base_rev=body.base_revision, full_save=True).to_dict()
    res["report"] = holder["report"]
    return res


@router.post("/documents/{doc_id}/sanitize")
def sanitize(doc_id: str, body: SanitizeBody):
    s = manager.get(doc_id)
    holder: dict = {}

    def fn(doc):
        holder["removed"] = redaction.sanitize(doc, body.options)
        return {"modified": []}

    res = s.mutate("Sanitize document", fn, base_rev=body.base_revision, full_save=True).to_dict()
    res["removed"] = holder["removed"]
    return res


# ---------------------------------------------------------------- signatures
class CreateIdBody(BaseModel):
    target_path: str
    name: str
    email: str = ""
    organization: str = ""
    country: str = ""
    password: str


class SignBody(BaseModel):
    pfx_path: str
    password: str
    target_path: str
    page: int = 0
    rect: list[float] | None = None
    reason: str = ""
    location: str = ""
    contact: str = ""
    field_name: str | None = None
    overlays: list[dict[str, Any]] = []


class SavedSignatureBody(BaseModel):
    data_base64: str
    kind: str = "drawn"


@router.post("/signatures/create-id")
def create_id(body: CreateIdBody):
    return signatures.create_digital_id(Path(body.target_path), body.name, body.email, body.organization, body.country,
                                        body.password)


@router.post("/documents/{doc_id}/sign")
def sign(doc_id: str, body: SignBody):
    """Produce a signed copy (current state + objects) and open it as the document."""
    s = manager.get(doc_id)
    if s.security:
        raise AppError("unsupported", "Remove password protection before signing; signed files must not be "
                       "re-encrypted afterwards.")
    target = Path(body.target_path)
    if target.suffix.lower() != ".pdf" or not target.parent.is_dir():
        raise AppError("invalid_target", "Choose a .pdf destination")
    tmp = target.with_name(f".{target.stem}.{uuid.uuid4().hex[:6]}.unsigned.pdf")
    try:
        build_output(s, tmp, body.overlays, garbage=3)
        doc = fitz.open(str(tmp))
        if not 0 <= body.page < doc.page_count:
            raise AppError("invalid_page", "Page out of range")
        doc.close()
        signatures.sign_pdf(tmp, target, Path(body.pfx_path), body.password, page=body.page, rect=body.rect,
                            reason=body.reason, location=body.location, contact=body.contact,
                            field_name=body.field_name)
    finally:
        tmp.unlink(missing_ok=True)
    report = signatures.validate(target)
    new = manager.open(str(target))
    info = new.info()
    info["signature"] = report[-1] if report else None
    return info


@router.get("/documents/{doc_id}/signatures")
def validate_signatures(doc_id: str):
    s = manager.get(doc_id)
    return {"signatures": signatures.validate(s.working_path), "modified_since_open": s.current_rev != 0}


@router.get("/signatures/saved")
def saved_signatures():
    return {"signatures": signatures.list_saved()}


@router.post("/signatures/saved")
def add_saved_signature(body: SavedSignatureBody):
    return signatures.save_signature(body.data_base64, body.kind)


@router.post("/signatures/saved/{sig_id}/delete")
def delete_saved_signature(sig_id: str):
    signatures.delete_saved(sig_id)
    return {"ok": True}


# ---------------------------------------------------------------- job results
class OcrApplyBody(BaseModel):
    job_id: str
    pages: list[dict[str, Any]] | None = None  # reviewed/edited lines
    base_revision: int | None = None


class CandidateBody(BaseModel):
    job_id: str
    base_revision: int | None = None


class CandidateSaveBody(BaseModel):
    job_id: str
    target_path: str


@router.post("/documents/{doc_id}/ocr/apply")
def ocr_apply(doc_id: str, body: OcrApplyBody):
    s = manager.get(doc_id)
    job = job_manager.get(body.job_id)
    if job.kind != "ocr" or job.status != "done" or job.doc_id != doc_id:
        raise AppError("invalid_request", "The OCR results are not available")
    pages = body.pages if body.pages is not None else job.result["pages"]
    holder: dict = {}

    def fn(src, dst):
        holder["lines"] = ocr.apply_text_layer(src, dst, pages)
        return {"modified": [int(p["index"]) for p in pages]}

    res = s.mutate("Make searchable (OCR)", fn, mode="file", base_rev=body.base_revision).to_dict()
    res["lines_written"] = holder["lines"]
    return res


@router.post("/documents/{doc_id}/candidate/commit")
def candidate_commit(doc_id: str, body: CandidateBody):
    s = manager.get(doc_id)
    job = job_manager.get(body.job_id)
    if job.status != "done" or job.doc_id != doc_id or not (job.result or {}).get("candidate"):
        raise AppError("invalid_request", "No result is available")
    path = job.dir / job.result["candidate"]
    label = {"compress": "Compress document"}.get(job.kind, "Apply result")
    return s.commit_file(path, label, extra={"modified": list(range(s.open_read().page_count))}).to_dict()


@router.post("/documents/{doc_id}/candidate/save-as")
def candidate_save_as(doc_id: str, body: CandidateSaveBody):
    job = job_manager.get(body.job_id)
    if job.status != "done" or job.doc_id != doc_id or not (job.result or {}).get("candidate"):
        raise AppError("invalid_request", "No result is available")
    target = Path(body.target_path)
    if target.suffix.lower() != ".pdf" or not target.parent.is_dir():
        raise AppError("invalid_target", "Choose a .pdf destination")
    tmp = target.with_name(f".{target.stem}.{uuid.uuid4().hex[:6]}.part.pdf")
    shutil.copyfile(job.dir / job.result["candidate"], tmp)
    validate_pdf(tmp)
    tmp.replace(target)
    return {"path": str(target), "size": target.stat().st_size}
