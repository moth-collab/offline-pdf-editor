"""FastAPI application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import anyio.to_thread
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from core.config import APP_VERSION, get_settings
from core.errors import AppError
from core.security import TokenAuthMiddleware

log = logging.getLogger("pdfed")


def create_app(token: str | None = None) -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # MuPDF is not thread safe: run all synchronous handlers on ONE worker
        # thread. This is also the global per-document command queue: every
        # mutation is executed strictly one after another. Long running work
        # (OCR, conversion, compression) runs in separate processes (jobs).
        anyio.to_thread.current_default_thread_limiter().total_tokens = 1
        from services.fonts import font_index

        font_index.build_async()
        yield

    app = FastAPI(title="Offline PDF Editor backend", version=APP_VERSION, docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    app.add_middleware(TokenAuthMiddleware, token=token if token is not None else settings.token)

    @app.exception_handler(AppError)
    async def _app_error(_req: Request, exc: AppError):
        return JSONResponse(exc.to_dict(), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation(_req: Request, exc: RequestValidationError):
        return JSONResponse({"error": {"code": "invalid_request", "message": "Invalid request",
                                       "details": exc.errors()[:5]}}, status_code=422)

    @app.exception_handler(Exception)
    async def _unexpected(_req: Request, exc: Exception):
        log.exception("unexpected error")
        return JSONResponse({"error": {"code": "internal_error", "message": str(exc) or exc.__class__.__name__}},
                            status_code=500)

    from api import (routes_annotations, routes_documents, routes_forms, routes_jobs, routes_pages, routes_security,
                     routes_text, routes_tools)

    for module in (routes_documents, routes_pages, routes_text, routes_annotations, routes_security,
                   routes_tools, routes_jobs, routes_forms):
        app.include_router(module.router)
    return app
