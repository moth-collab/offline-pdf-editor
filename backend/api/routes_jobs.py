"""Background job endpoints. Status endpoints are async so they never wait
behind the serialised command queue."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from core.errors import AppError
from core.jobs import job_manager
from services.document_manager import manager

router = APIRouter()


class StartJobRequest(BaseModel):
    kind: str
    doc_id: str | None = None
    params: dict[str, Any] = {}


@router.post("/jobs")
def start_job(req: StartJobRequest):
    params = dict(req.params)
    if req.doc_id:
        s = manager.get(req.doc_id)
        params["source_path"] = str(s.working_path)
        params["display_name"] = s.display_name
    elif req.kind == "batch":
        pass  # works on files chosen by the user, not on an open document
    elif req.kind != "convert" or params.get("mode") != "images-to-pdf":
        if "source_path" not in params:
            raise AppError("invalid_request", "A document is required for this job")
    job = job_manager.start(req.kind, params, req.doc_id)
    return job.public()


@router.get("/jobs/{job_id}")
async def job_status(job_id: str):
    return job_manager.get(job_id).public()


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    return job_manager.cancel(job_id).public()


@router.post("/jobs/{job_id}/dispose")
async def dispose_job(job_id: str):
    job_manager.dispose(job_id)
    return {"ok": True}
