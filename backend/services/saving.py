"""Atomic saving.

1. Build the output (current revision + baked overlay objects) in a temp file
   located in the destination directory (same volume => atomic rename).
2. Apply encryption when requested (pikepdf / qpdf, AES-256).
3. Validate the output with two independent parsers.
4. Back up the existing destination file (local backups folder).
5. Atomically replace the destination (``os.replace``).
6. Re-validate the destination; restore the backup if that fails.
"""
from __future__ import annotations

import os
import shutil
import time
import uuid
from pathlib import Path

import pikepdf
import pymupdf as fitz

from core.config import get_settings
from core.errors import AppError
from services.document_manager import DocumentSession, validate_pdf

MAX_BACKUPS_PER_FILE = 5


def backups_dir() -> Path:
    d = get_settings().sessions_root.parent / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def build_output(session: DocumentSession, out_path: Path, overlays: list[dict] | None,
                 *, garbage: int = 3) -> int:
    """Write current revision + overlays (flattened) to ``out_path`` unencrypted."""
    src = session.working_path
    if overlays:
        from services.overlay_editor import bake_overlays  # local import: heavy module

        tmp = out_path.with_name(out_path.name + ".ovl")
        try:
            bake_overlays(src, tmp, overlays)
            doc = fitz.open(str(tmp))
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    else:
        tmp = None
        doc = fitz.open(str(src))
    try:
        n = doc.page_count
        doc.save(str(out_path), garbage=garbage, deflate=True, clean=False)
    finally:
        doc.close()
        if tmp:
            tmp.unlink(missing_ok=True)
    return n


def apply_encryption(src: Path, dst: Path, security: dict) -> None:
    perms = security.get("permissions") or {}
    allow = pikepdf.Permissions(
        accessibility=True,
        extract=bool(perms.get("copy", True)),
        modify_annotation=bool(perms.get("annotate", True)),
        modify_assembly=bool(perms.get("assemble", True)),
        modify_form=bool(perms.get("fill_forms", True)),
        modify_other=bool(perms.get("modify", True)),
        print_lowres=bool(perms.get("print", True)),
        print_highres=bool(perms.get("print", True)) and bool(perms.get("print_high_quality", True)),
    )
    user_pw = security.get("user_password") or ""
    owner_pw = security.get("owner_password") or ""
    if not owner_pw:
        # an owner password is required for permissions to be meaningful
        owner_pw = uuid.uuid4().hex if not user_pw else user_pw
    with pikepdf.open(str(src)) as pdf:
        pdf.save(str(dst), encryption=pikepdf.Encryption(user=user_pw, owner=owner_pw, R=6, allow=allow))


def save_document(session: DocumentSession, target: str, *, overlays: list[dict] | None = None,
                  make_backup: bool = True, mark_saved: bool = True) -> dict:
    target_path = Path(target)
    if target_path.suffix.lower() != ".pdf":
        raise AppError("invalid_target", "The destination must be a .pdf file")
    if not target_path.parent.exists():
        raise AppError("invalid_target", "The destination folder does not exist")
    token = uuid.uuid4().hex[:8]
    tmp1 = target_path.with_name(f".{target_path.stem}.{token}.saving.pdf")
    tmp2 = target_path.with_name(f".{target_path.stem}.{token}.enc.pdf")
    backup: Path | None = None
    with session.lock:
        try:
            try:
                n = build_output(session, tmp1, overlays)
            except PermissionError as exc:
                raise AppError("write_failed", f"Cannot write to the destination folder: {exc}") from exc
            final_tmp = tmp1
            password = None
            if session.security:
                apply_encryption(tmp1, tmp2, session.security)
                final_tmp = tmp2
                password = session.security.get("user_password") or session.security.get("owner_password")
            validate_pdf(final_tmp, password=password, expect_pages=n)

            if target_path.exists() and make_backup:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                backup = backups_dir() / f"{target_path.stem}-{stamp}-{token}.pdf"
                shutil.copy2(target_path, backup)
                _prune_backups(target_path.stem)
            try:
                os.replace(final_tmp, target_path)
            except PermissionError as exc:
                raise AppError(
                    "file_locked",
                    "The destination file is locked by another program. Close it and try again, or use Save As.",
                ) from exc
            try:
                validate_pdf(target_path, password=password, expect_pages=n)
            except AppError:
                if backup and backup.exists():
                    shutil.copy2(backup, target_path)  # restore previous version
                raise
        finally:
            tmp1.unlink(missing_ok=True)
            tmp2.unlink(missing_ok=True)
        if mark_saved:
            session.saved_rev = session.current_rev
            session.original_path = str(target_path.resolve())
            session.display_name = target_path.name
            session.persist()
    return {
        "path": str(target_path),
        "size": target_path.stat().st_size,
        "backup": str(backup) if backup else None,
        "pages": n,
        "info": session.info(),
    }


def _prune_backups(stem: str) -> None:
    files = sorted(backups_dir().glob(f"{stem}-*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[MAX_BACKUPS_PER_FILE:]:
        old.unlink(missing_ok=True)
