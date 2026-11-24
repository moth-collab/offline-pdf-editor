"""Typed application errors that are serialised to the frontend."""
from __future__ import annotations

from typing import Any


class AppError(Exception):
    status = 400

    def __init__(self, code: str, message: str, *, status: int | None = None, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details
        if status is not None:
            self.status = status

    def to_dict(self) -> dict:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


class NotFound(AppError):
    status = 404


class Conflict(AppError):
    status = 409


def not_found(what: str) -> NotFound:
    return NotFound("not_found", f"{what} was not found")
