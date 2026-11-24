"""Background jobs executed in separate processes.

Long running work (OCR, conversions, compression) runs in a spawned child
process so that the interactive API stays responsive and MuPDF state is
isolated. Progress is reported through a multiprocessing queue; jobs can be
cancelled cooperatively (and are terminated if they do not stop).
"""
from __future__ import annotations

import importlib
import multiprocessing as mp
import shutil
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from core.config import Settings, get_settings, set_settings
from core.errors import AppError, not_found

JOB_KINDS = {
    "ocr": "services.ocr:run_ocr_job",
    "compress": "services.compression:run_compress_job",
    "convert": "services.conversion:run_convert_job",
    "batch": "services.batch:run_batch_job",
}


def jobs_root() -> Path:
    d = get_settings().sessions_root.parent / "jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Job:
    id: str
    kind: str
    doc_id: str | None
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: dict | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None
    process: Any = None
    cancel_event: Any = None
    dir: Path | None = None

    def public(self) -> dict:
        return {"job_id": self.id, "kind": self.kind, "doc_id": self.doc_id, "status": self.status,
                "progress": round(self.progress, 4), "message": self.message, "result": self.result,
                "error": self.error}


def _settings_dict(s: Settings) -> dict:
    return {"sessions_root": str(s.sessions_root), "assets_dir": str(s.assets_dir),
            "tesseract_cmd": s.tesseract_cmd, "tessdata_dir": str(s.tessdata_dir) if s.tessdata_dir else None,
            "extra_font_dirs": [str(p) for p in s.extra_font_dirs],
            "cache_dir": str(s.cache_dir) if s.cache_dir else None}


def _job_entry(target: str, params: dict, settings: dict, job_dir: str, queue, cancel_event) -> None:
    """Runs inside the child process."""
    try:
        set_settings(Settings(
            sessions_root=Path(settings["sessions_root"]), assets_dir=Path(settings["assets_dir"]),
            tesseract_cmd=settings.get("tesseract_cmd"),
            tessdata_dir=Path(settings["tessdata_dir"]) if settings.get("tessdata_dir") else None,
            extra_font_dirs=[Path(p) for p in settings.get("extra_font_dirs", [])],
            cache_dir=Path(settings["cache_dir"]) if settings.get("cache_dir") else None,
        ))
        mod_name, fn_name = target.split(":")
        fn = getattr(importlib.import_module(mod_name), fn_name)
        last = [0.0]

        def report(progress: float, message: str = "") -> None:
            now = time.time()
            if now - last[0] > 0.15 or progress >= 1:
                last[0] = now
                queue.put({"type": "progress", "progress": float(progress), "message": message})

        def cancelled() -> bool:
            return cancel_event.is_set()

        result = fn(params, Path(job_dir), report, cancelled)
        if cancel_event.is_set():
            queue.put({"type": "cancelled"})
        else:
            queue.put({"type": "result", "result": result})
    except AppError as exc:
        queue.put({"type": "error", "error": {"code": exc.code, "message": exc.message}})
    except Exception as exc:  # pragma: no cover - reported to the UI
        queue.put({"type": "error", "error": {"code": "job_failed", "message": str(exc),
                                               "trace": traceback.format_exc()[-2000:]}})


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self._ctx = mp.get_context("spawn")
        self._lock = threading.Lock()

    def start(self, kind: str, params: dict, doc_id: str | None = None) -> Job:
        if kind not in JOB_KINDS:
            raise AppError("invalid_request", f"Unknown job type {kind}")
        job = Job(id=uuid.uuid4().hex, kind=kind, doc_id=doc_id)
        job.dir = jobs_root() / job.id
        job.dir.mkdir(parents=True)
        queue = self._ctx.Queue()
        job.cancel_event = self._ctx.Event()
        proc = self._ctx.Process(target=_job_entry, name=f"job-{kind}",
                                 args=(JOB_KINDS[kind], params, _settings_dict(get_settings()), str(job.dir),
                                       queue, job.cancel_event), daemon=True)
        job.process = proc
        with self._lock:
            self.jobs[job.id] = job
        proc.start()
        job.status = "running"
        threading.Thread(target=self._monitor, args=(job, queue), daemon=True).start()
        return job

    def _monitor(self, job: Job, queue) -> None:
        import queue as q

        while True:
            try:
                msg = queue.get(timeout=0.5)
            except q.Empty:
                if not job.process.is_alive():
                    if job.status == "running":
                        if job.cancel_event.is_set():
                            job.status = "cancelled"
                        else:
                            job.status = "error"
                            job.error = {"code": "job_crashed",
                                         "message": f"The worker process stopped unexpectedly "
                                                    f"(exit code {job.process.exitcode})"}
                        job.finished = time.time()
                    return
                continue
            t = msg.get("type")
            if t == "progress":
                job.progress = msg["progress"]
                job.message = msg.get("message", "")
            elif t == "result":
                job.result = msg["result"]
                job.status = "done"
                job.progress = 1.0
                job.finished = time.time()
            elif t == "error":
                job.error = msg["error"]
                job.status = "error"
                job.finished = time.time()
            elif t == "cancelled":
                job.status = "cancelled"
                job.finished = time.time()
            if job.status in ("done", "error", "cancelled"):
                job.process.join(timeout=5)
                return

    def get(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise not_found("Job")
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job.status in ("queued", "running"):
            job.cancel_event.set()

            def _kill():
                job.process.join(timeout=4)
                if job.process.is_alive():
                    job.process.terminate()
                job.status = "cancelled"
                job.finished = job.finished or time.time()

            threading.Thread(target=_kill, daemon=True).start()
        return job

    def dispose(self, job_id: str) -> None:
        job = self.jobs.pop(job_id, None)
        if job and job.dir:
            shutil.rmtree(job.dir, ignore_errors=True)

    def shutdown(self) -> None:
        for job in list(self.jobs.values()):
            if job.process and job.process.is_alive():
                job.cancel_event.set()
                job.process.terminate()
        shutil.rmtree(jobs_root(), ignore_errors=True)


job_manager = JobManager()
