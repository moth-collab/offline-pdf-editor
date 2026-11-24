"""Centralised Document Session Manager.

Every open document owns a *session directory* that contains immutable
working-copy revisions (``rev-000000.pdf``, ``rev-000001.pdf`` ...). The
original file is never modified; it is only replaced by an explicit, atomic
save. All mutations go through :meth:`DocumentSession.mutate`, which

1. serialises access per document (command queue),
2. produces a new revision from the current one,
3. validates the produced PDF before accepting it,
4. truncates the redo branch and prunes old revisions,
5. persists ``session.json`` for crash recovery.

Undo/redo moves the revision pointer (``set_revision``). Passwords are kept
in memory only and are never written to disk.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import pikepdf
import pymupdf as fitz

from core.config import get_settings
from core.coords import page_geometry
from core.errors import AppError, Conflict, not_found

SESSION_FILE = "session.json"
UI_STATE_FILE = "ui-state.json"


def _now() -> float:
    return time.time()


def is_pdf_file(path: Path) -> bool:
    try:
        with open(path, "rb") as fh:
            head = fh.read(1024)
        return b"%PDF-" in head
    except OSError:
        return False


@dataclass
class Revision:
    id: int
    file: str
    label: str
    ts: float

    def to_dict(self) -> dict:
        return {"id": self.id, "file": self.file, "label": self.label, "ts": self.ts}


@dataclass
class MutationResult:
    session: "DocumentSession"
    page_map: list[int | None] | None = None
    modified: list[int] | None = None
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = self.session.info()
        d["page_map"] = self.page_map
        d["modified_pages"] = self.modified
        # operation details never replace the document info itself
        clash = set(self.extra) & set(d)
        if clash:
            raise RuntimeError(f"operation result keys clash with document info: {sorted(clash)}")
        d.update(self.extra)
        return d


class DocumentSession:
    def __init__(self, doc_id: str, session_dir: Path, original_path: str | None, display_name: str):
        self.id = doc_id
        self.dir = session_dir
        self.original_path = original_path
        self.display_name = display_name
        self.revisions: list[Revision] = []
        self.current_rev: int = 0
        self.saved_rev: int | None = 0
        self.next_rev_id = 0
        self.lock = threading.RLock()
        # memory-only secrets / state
        self.password: str | None = None
        self.source_encrypted = False
        self.source_permissions: dict | None = None
        self.owner_authenticated = True
        self.repaired = False
        self.security: dict | None = None  # encryption to apply on save
        self._fitz_cache: tuple[str, fitz.Document] | None = None
        self.created = _now()

    # ------------------------------------------------------------------
    # paths
    # ------------------------------------------------------------------
    def rev_path(self, rev_id: int) -> Path:
        return self.dir / f"rev-{rev_id:06d}.pdf"

    def _rev(self, rev_id: int) -> Revision:
        for r in self.revisions:
            if r.id == rev_id:
                return r
        raise not_found(f"Revision {rev_id}")

    @property
    def working_path(self) -> Path:
        return self.dir / self._rev(self.current_rev).file

    # ------------------------------------------------------------------
    # read access
    # ------------------------------------------------------------------
    def open_read(self) -> fitz.Document:
        """Return a cached read-only fitz document for the current revision.

        Callers must not mutate it. All backend request handling is
        serialised, so sharing the cached handle is safe.
        """
        path = str(self.working_path)
        if self._fitz_cache and self._fitz_cache[0] == path:
            return self._fitz_cache[1]
        self._drop_cache()
        doc = fitz.open(path)
        self._fitz_cache = (path, doc)
        return doc

    def _drop_cache(self) -> None:
        if self._fitz_cache:
            try:
                self._fitz_cache[1].close()
            except Exception:  # pragma: no cover - defensive
                pass
        self._fitz_cache = None

    def info(self) -> dict:
        doc = self.open_read()
        pages = []
        for i in range(doc.page_count):
            g = page_geometry(doc[i])
            g["index"] = i
            pages.append(g)
        rev_ids = [r.id for r in self.revisions]
        return {
            "doc_id": self.id,
            "display_name": self.display_name,
            "original_path": self.original_path,
            "working_path": str(self.working_path),
            "revision": self.current_rev,
            "revisions": rev_ids,
            "saved_revision": self.saved_rev,
            "can_undo": rev_ids.index(self.current_rev) > 0,
            "can_redo": rev_ids.index(self.current_rev) < len(rev_ids) - 1,
            "page_count": doc.page_count,
            "pages": pages,
            "metadata": {k: v for k, v in (doc.metadata or {}).items() if v},
            "file_size": self.working_path.stat().st_size,
            "source_encrypted": self.source_encrypted,
            "permissions": self.source_permissions,
            "owner_authenticated": self.owner_authenticated,
            "repaired": self.repaired,
            "security": _public_security(self.security),
            "has_outline": bool(doc.get_toc(simple=True)),
            "has_signatures": _has_signatures(doc),
        }

    # ------------------------------------------------------------------
    # mutation (the command queue)
    # ------------------------------------------------------------------
    def ensure_editable(self) -> None:
        if not self.owner_authenticated:
            raise AppError(
                "permission_denied",
                "This document is protected against changes. Enter the owner (permissions) password to edit it.",
                status=403,
            )

    def unlock(self, password: str) -> dict:
        """Enable editing of a permission-restricted document with its owner password."""
        if self.owner_authenticated:
            return self.info()
        if not self.original_path or not Path(self.original_path).exists():
            raise AppError("unlock_failed", "The original file is no longer available to verify the password")
        d = fitz.open(self.original_path)
        try:
            auth = d.authenticate(password)
        finally:
            d.close()
        if not auth & 4:
            raise AppError("invalid_password", "This is not the owner (permissions) password", status=401)
        self.owner_authenticated = True
        self.password = password
        return self.info()

    def mutate(
        self,
        label: str,
        fn: Callable[..., Any],
        *,
        mode: str = "fitz",
        base_rev: int | None = None,
        full_save: bool = False,
        check_editable: bool = True,
    ) -> MutationResult:
        """Run ``fn`` to produce a new revision.

        ``mode="fitz"``: ``fn(doc: fitz.Document) -> dict | None`` mutates an
        opened copy of the current revision.
        ``mode="file"``: ``fn(src: Path, dst: Path) -> dict | None`` writes the
        new revision itself (pikepdf, external tools, ...).

        The callback may return ``{"page_map": [...], "modified": [...], ...}``.
        """
        with self.lock:
            if check_editable:
                self.ensure_editable()
            if base_rev is not None and base_rev != self.current_rev:
                raise Conflict(
                    "revision_conflict",
                    "The document changed in the meantime. Please retry.",
                    details={"current": self.current_rev, "base": base_rev},
                )
            src = self.working_path
            new_id = self.next_rev_id
            dst = self.rev_path(new_id)
            tmp = dst.with_suffix(".tmp")
            meta: dict | None
            try:
                if mode == "fitz":
                    doc = fitz.open(str(src))
                    try:
                        meta = fn(doc)
                        doc.save(str(tmp), garbage=4 if full_save else 1, deflate=True)
                    finally:
                        doc.close()
                elif mode == "file":
                    meta = fn(src, tmp)
                else:  # pragma: no cover
                    raise ValueError(mode)
                validate_pdf(tmp)
                os.replace(tmp, dst)
            except AppError:
                tmp.unlink(missing_ok=True)
                raise
            except Exception as exc:
                tmp.unlink(missing_ok=True)
                raise AppError("operation_failed", f"{label} failed: {exc}") from exc

            # truncate redo branch
            idx = [r.id for r in self.revisions].index(self.current_rev)
            for r in self.revisions[idx + 1 :]:
                (self.dir / r.file).unlink(missing_ok=True)
                if self.saved_rev == r.id:
                    self.saved_rev = None
            self.revisions = self.revisions[: idx + 1]
            self.revisions.append(Revision(new_id, dst.name, label, _now()))
            self.next_rev_id = new_id + 1
            self.current_rev = new_id
            self._prune()
            self._drop_cache()
            self.persist()
            meta = meta or {}
            return MutationResult(
                self,
                page_map=meta.pop("page_map", None),
                modified=meta.pop("modified", None),
                extra=meta,
            )

    def _prune(self) -> None:
        """Drop the oldest undo steps beyond the count limit or the per-document
        disk budget (large scans would otherwise use GBs of working copies).
        The active revision and at least two revisions are always kept."""
        settings = get_settings()

        def size_of(r: Revision) -> int:
            try:
                return (self.dir / r.file).stat().st_size
            except OSError:
                return 0

        total = sum(size_of(r) for r in self.revisions)
        while len(self.revisions) > 2 and (
            len(self.revisions) > settings.max_revisions or total > settings.max_revision_bytes
        ):
            old = self.revisions[0]
            if old.id == self.current_rev:  # never prune the active revision
                break
            self.revisions.pop(0)
            total -= size_of(old)
            (self.dir / old.file).unlink(missing_ok=True)
            if self.saved_rev == old.id:
                self.saved_rev = None

    def set_revision(self, rev_id: int) -> dict:
        with self.lock:
            self._rev(rev_id)  # raises when pruned/unknown
            self.current_rev = rev_id
            self._drop_cache()
            self.persist()
            return self.info()

    def commit_file(self, path: Path, label: str, *, check_editable: bool = True, extra: dict | None = None) -> MutationResult:
        """Accept an externally produced PDF (job output) as a new revision."""

        def _copy(src: Path, dst: Path):
            shutil.copyfile(path, dst)
            return dict(extra or {})

        return self.mutate(label, _copy, mode="file", check_editable=check_editable)

    # ------------------------------------------------------------------
    # persistence for crash recovery
    # ------------------------------------------------------------------
    def persist(self) -> None:
        data = {
            "doc_id": self.id,
            "original_path": self.original_path,
            "display_name": self.display_name,
            "revisions": [r.to_dict() for r in self.revisions],
            "current_rev": self.current_rev,
            "saved_rev": self.saved_rev,
            "next_rev_id": self.next_rev_id,
            "source_encrypted": self.source_encrypted,
            "created": self.created,
            "updated": _now(),
        }
        tmp = self.dir / (SESSION_FILE + ".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        os.replace(tmp, self.dir / SESSION_FILE)

    def save_ui_state(self, state: dict) -> None:
        tmp = self.dir / (UI_STATE_FILE + ".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, self.dir / UI_STATE_FILE)

    def load_ui_state(self) -> dict | None:
        p = self.dir / UI_STATE_FILE
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return None
        return None

    @classmethod
    def restore(cls, session_dir: Path) -> "DocumentSession":
        data = json.loads((session_dir / SESSION_FILE).read_text(encoding="utf-8"))
        s = cls(data["doc_id"], session_dir, data.get("original_path"), data.get("display_name") or "Recovered.pdf")
        s.revisions = [Revision(**r) for r in data["revisions"] if (session_dir / r["file"]).exists()]
        if not s.revisions:
            raise AppError("recovery_failed", "No usable revision found in the recovery data")
        ids = [r.id for r in s.revisions]
        s.current_rev = data["current_rev"] if data["current_rev"] in ids else ids[-1]
        s.saved_rev = data.get("saved_rev") if data.get("saved_rev") in ids else None
        s.next_rev_id = max(data.get("next_rev_id", 0), ids[-1] + 1)
        s.source_encrypted = bool(data.get("source_encrypted"))
        s.created = data.get("created", _now())
        validate_pdf(s.working_path)
        return s

    def close(self, delete: bool = True) -> None:
        self._drop_cache()
        if delete:
            shutil.rmtree(self.dir, ignore_errors=True)


def _public_security(sec: dict | None) -> dict | None:
    if not sec:
        return None
    return {
        "encrypt": True,
        "has_user_password": bool(sec.get("user_password")),
        "has_owner_password": bool(sec.get("owner_password")),
        "permissions": sec.get("permissions"),
        "preserved": bool(sec.get("preserved")),
        "owner_unknown": bool(sec.get("owner_unknown")),
    }


def _has_signatures(doc: fitz.Document) -> bool:
    try:
        if not doc.is_form_pdf:
            return False
        for page in doc:
            for w in page.widgets() or []:
                if w.field_type == fitz.PDF_WIDGET_TYPE_SIGNATURE:
                    return True
    except Exception:
        return False
    return False


def validate_pdf(path: Path, *, password: str | None = None, expect_pages: int | None = None) -> int:
    """Validate a produced PDF with two independent parsers (MuPDF + qpdf)."""
    if not path.exists() or path.stat().st_size == 0:
        raise AppError("invalid_output", "The produced PDF is empty")
    try:
        doc = fitz.open(str(path))
    except Exception as exc:
        raise AppError("invalid_output", f"The produced PDF cannot be opened: {exc}") from exc
    try:
        if doc.needs_pass and not doc.authenticate(password or ""):
            raise AppError("invalid_output", "The produced PDF cannot be decrypted")
        n = doc.page_count
        if n < 1:
            raise AppError("invalid_output", "The produced PDF has no pages")
        if expect_pages is not None and n != expect_pages:
            raise AppError("invalid_output", f"Expected {expect_pages} pages, got {n}")
    finally:
        doc.close()
    try:
        with pikepdf.open(str(path), password=password or "") as pdf:
            if len(pdf.pages) != n:
                raise AppError("invalid_output", "Page count mismatch between validators")
    except pikepdf.PdfError as exc:
        raise AppError("invalid_output", f"The produced PDF failed structural validation: {exc}") from exc
    return n


class DocumentManager:
    def __init__(self) -> None:
        self.sessions: dict[str, DocumentSession] = {}

    @property
    def root(self) -> Path:
        return get_settings().sessions_root

    def get(self, doc_id: str) -> DocumentSession:
        s = self.sessions.get(doc_id)
        if not s:
            raise not_found("Document")
        return s

    # ------------------------------------------------------------------
    def open(self, path: str, password: str | None = None, display_name: str | None = None,
             original_path: str | None | bool = True) -> DocumentSession:
        src = Path(path)
        if not src.exists() or not src.is_file():
            raise AppError("file_not_found", f"File not found: {src.name}", status=404)
        if src.stat().st_size == 0:
            raise AppError("invalid_pdf", "The file is empty")
        if not is_pdf_file(src):
            raise AppError("invalid_pdf", "The file is not a PDF document")
        try:
            probe = fitz.open(str(src))
        except Exception as exc:
            raise AppError("corrupted_pdf", f"The PDF is damaged and cannot be opened: {exc}") from exc

        doc_id = uuid.uuid4().hex
        session_dir = self.root / doc_id
        session_dir.mkdir(parents=True, exist_ok=False)
        orig = str(src.resolve()) if original_path is True else (original_path or None)
        s = DocumentSession(doc_id, session_dir, orig, display_name or src.name)
        rev0 = s.rev_path(0)
        try:
            # MuPDF silently opens files with an empty user password, so ask qpdf
            # whether the file is encrypted (owner-restricted documents).
            try:
                with pikepdf.open(str(src), password=password or "") as chk:
                    encrypted_empty_user = chk.is_encrypted
            except pikepdf.PasswordError:
                encrypted_empty_user = False
            except pikepdf.PdfError:
                encrypted_empty_user = False
            needs_user = probe.needs_pass
            if probe.needs_pass or encrypted_empty_user:
                if probe.needs_pass and not password:
                    raise AppError("password_required", "This document is password protected", status=401)
                auth = probe.authenticate(password or "")
                if probe.needs_pass and not auth:
                    raise AppError("invalid_password", "The password is incorrect", status=401)
                if not probe.needs_pass and password:
                    # an owner password supplied for a restricted document
                    auth = probe.authenticate(password) or 2
                s.password = password or ""
                s.source_encrypted = True
                perms = probe.permissions
                s.source_permissions = _decode_permissions(perms)
                # owner password unlocks everything; user password honours restrictions
                s.owner_authenticated = bool(auth & 4) or bool(perms & fitz.PDF_PERM_MODIFY)
                probe.close()
                with pikepdf.open(str(src), password=password or "") as pdf:
                    orig = _pikepdf_permissions(pdf.allow)
                    pdf.save(str(rev0))
                # keep the protection by default: re-applied (AES-256) on save
                if auth & 4:  # owner password supplied
                    user_pw = (password or "") if needs_user else ""
                    owner_pw = password or ""
                else:  # user password: the owner password is unknown
                    user_pw = password or ""
                    owner_pw = None
                s.security = {"user_password": user_pw, "owner_password": owner_pw, "permissions": orig,
                              "preserved": True, "owner_unknown": owner_pw is None}
            elif probe.is_repaired:
                s.repaired = True
                probe.save(str(rev0), garbage=1, deflate=True)
                probe.close()
            else:
                probe.close()
                shutil.copyfile(src, rev0)
            validate_pdf(rev0)
        except Exception:
            shutil.rmtree(session_dir, ignore_errors=True)
            raise
        s.revisions = [Revision(0, rev0.name, "Open", _now())]
        s.current_rev = 0
        s.saved_rev = 0
        s.next_rev_id = 1
        s.persist()
        self.sessions[doc_id] = s
        return s

    def create_from_file(self, produced: Path, display_name: str) -> DocumentSession:
        """Open a generated PDF (merge, images-to-PDF ...) as an untitled document."""
        s = self.open(str(produced), display_name=display_name, original_path=None)
        s.saved_rev = None  # untitled: needs Save As
        s.persist()
        return s

    def restore(self, session_dir: Path) -> DocumentSession:
        s = DocumentSession.restore(session_dir)
        if s.id in self.sessions:
            return self.sessions[s.id]
        self.sessions[s.id] = s
        return s

    def close(self, doc_id: str, delete: bool = True) -> None:
        s = self.sessions.pop(doc_id, None)
        if s:
            s.close(delete=delete)

    def list_recoverable(self) -> list[dict]:
        out = []
        if not self.root.exists():
            return out
        for d in sorted(self.root.iterdir()):
            if not d.is_dir() or d.name in self.sessions:
                continue
            meta = d / SESSION_FILE
            if not meta.exists():
                continue
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
                out.append(
                    {
                        "session_id": d.name,
                        "display_name": data.get("display_name"),
                        "original_path": data.get("original_path"),
                        "updated": data.get("updated"),
                        "revisions": len(data.get("revisions", [])),
                        "unsaved": data.get("saved_rev") != data.get("current_rev")
                        or (d / UI_STATE_FILE).exists(),
                    }
                )
            except (OSError, ValueError):
                continue
        return out

    def discard_recoverable(self, session_id: str) -> None:
        d = self.root / session_id
        if session_id in self.sessions or not d.is_dir() or d.parent != self.root:
            raise not_found("Recovery session")
        shutil.rmtree(d, ignore_errors=True)


def _pikepdf_permissions(allow) -> dict:
    return {
        "print": bool(allow.print_lowres),
        "print_high_quality": bool(allow.print_highres),
        "modify": bool(allow.modify_other),
        "copy": bool(allow.extract),
        "annotate": bool(allow.modify_annotation),
        "fill_forms": bool(allow.modify_form),
        "assemble": bool(allow.modify_assembly),
    }


def _decode_permissions(p: int) -> dict:
    return {
        "print": bool(p & fitz.PDF_PERM_PRINT),
        "modify": bool(p & fitz.PDF_PERM_MODIFY),
        "copy": bool(p & fitz.PDF_PERM_COPY),
        "annotate": bool(p & fitz.PDF_PERM_ANNOTATE),
        "fill_forms": bool(p & fitz.PDF_PERM_FORM),
        "assemble": bool(p & fitz.PDF_PERM_ASSEMBLE),
        "print_high_quality": bool(p & fitz.PDF_PERM_PRINT_HQ),
    }


manager = DocumentManager()
