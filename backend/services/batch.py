"""Batch processing: apply one action to many PDF files.

Runs as a background job (see core/jobs.py). Every result is written to the
chosen output folder under a new name; original files are never modified and
existing files are never overwritten. Each output is validated before it is
moved into place. One failing file does not stop the batch.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

import pikepdf
import pymupdf as fitz

from core.errors import AppError

ACTIONS = ("ocr", "compress", "header-footer", "watermark", "protect", "sanitize", "flatten", "docx")
SUFFIX = {
    "ocr": "_ocr", "compress": "_compressed", "header-footer": "_numbered", "watermark": "_watermarked",
    "protect": "_protected", "sanitize": "_clean", "flatten": "_flattened", "docx": "",
}


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    i = 2
    while True:
        cand = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not cand.exists():
            return cand
        i += 1


def output_path(src: Path, out_dir: Path, action: str) -> Path:
    ext = ".docx" if action == "docx" else ".pdf"
    target = out_dir / f"{src.stem}{SUFFIX[action]}{ext}"
    if target.resolve() == src.resolve():
        target = out_dir / f"{src.stem}_processed{ext}"
    return _unique(target)


def _scanned_pages(doc: fitz.Document) -> list[int]:
    out = []
    for page in doc:
        if len(page.get_text("text").strip()) >= 10:
            continue
        area = abs(page.rect) or 1
        img = sum(abs(fitz.Rect(i["bbox"]) & page.rect) for i in page.get_image_info())
        if img / area > 0.5:
            out.append(page.number)
    return out


def _process(action: str, src: Path, tmp: Path, opts: dict, state: dict, work: Path, report_page) -> dict:
    from services.document_manager import validate_pdf

    info: dict = {}
    if action == "compress":
        from services.compression import compress

        res = compress(str(src), tmp, str(opts.get("preset", "recommended")), None, lambda *_a, **_k: None)
        info = {"before": res.get("original_size"), "after": res.get("new_size")}
    elif action == "ocr":
        from services.ocr import LANG_OK, apply_text_layer, recognize_page

        lang = str(opts.get("language") or "tha+eng")
        if lang not in LANG_OK:
            raise AppError("invalid_request", f"Unsupported OCR language {lang}")
        dpi = max(150, min(int(opts.get("dpi") or 300), 600))
        doc = fitz.open(str(src))
        pages = _scanned_pages(doc) if opts.get("only_scanned", True) else list(range(doc.page_count))
        results = []
        for n, p in enumerate(pages):
            report_page(n, len(pages))
            results.append(recognize_page(doc[p], lang, dpi, work))
        doc.close()
        if not results:
            shutil.copyfile(src, tmp)
            info = {"pages": 0, "note": "no scanned pages"}
        else:
            apply_text_layer(src, tmp, results)
            info = {"pages": len(results)}
    elif action == "header-footer":
        from services import header_footer

        spec = dict(opts)
        bates = dict(spec.get("bates") or {})
        bates["start"] = state.setdefault("bates_next", int(bates.get("start", 1) or 1))
        spec["bates"] = bates
        with pikepdf.open(src) as pdf:
            header_footer.apply(pdf, spec, file_name=src.stem)
            n = len(pdf.pages)
            pdf.save(tmp)
        # Bates numbers continue across the files of the batch
        state["bates_next"] = bates["start"] + n
        info = {"bates_first": bates["start"], "bates_last": bates["start"] + n - 1}
    elif action == "watermark":
        from services.security import add_watermark

        spec = {k: v for k, v in opts.items() if k != "asset_id"}
        add_watermark(src, tmp, spec)
    elif action == "protect":
        from services.saving import apply_encryption

        user_pw = str(opts.get("user_password") or "")
        owner_pw = str(opts.get("owner_password") or "")
        if not user_pw and not owner_pw:
            raise AppError("invalid_request", "Enter a password")
        apply_encryption(src, tmp, {"user_password": user_pw, "owner_password": owner_pw,
                                    "permissions": opts.get("permissions") or {}})
        with pikepdf.open(tmp, password=user_pw or owner_pw) as check:
            if len(check.pages) < 1:
                raise AppError("invalid_output", "The produced PDF has no pages")
        return info
    elif action == "sanitize":
        from services.redaction import sanitize

        doc = fitz.open(str(src))
        sanitize(doc, {"metadata": True, "javascript": True, "attachments": bool(opts.get("attachments", True)),
                       "links": bool(opts.get("links", False)), "hidden_text": bool(opts.get("hidden_text", False))})
        doc.save(str(tmp), garbage=3, deflate=True)
        doc.close()
    elif action == "flatten":
        from services import forms

        with pikepdf.open(src) as pdf:
            n_fields = forms.flatten(pdf)
            pdf.save(tmp)
        doc = fitz.open(str(tmp))
        doc.bake(annots=True, widgets=True)
        doc.save(str(tmp) + ".2", garbage=3, deflate=True)
        doc.close()
        os.replace(str(tmp) + ".2", tmp)
        info = {"fields": n_fields}
    elif action == "docx":
        from services.conversion import to_docx

        doc = fitz.open(str(src))
        pages = list(range(doc.page_count))
        doc.close()
        to_docx(str(src), tmp, pages, lambda *_a, **_k: None, lambda: False)
        if not tmp.exists() or tmp.stat().st_size == 0:
            raise AppError("invalid_output", "The conversion produced no file")
        return info
    else:  # pragma: no cover - validated before
        raise AppError("invalid_request", "Unknown batch action")
    validate_pdf(tmp)
    return info


def run_batch_job(params: dict, job_dir: Path, report, cancelled) -> dict:
    action = str(params.get("mode") or "")
    if action not in ACTIONS:
        raise AppError("invalid_request", "Choose what to do with the files")
    files = [Path(p) for p in params.get("files_paths") or []]
    if not files:
        raise AppError("invalid_request", "Add at least one file")
    out_dir = Path(params.get("output_dir") or "")
    if not out_dir.is_dir():
        raise AppError("invalid_target", "The output folder does not exist")
    opts = dict(params.get("options") or {})
    state: dict = {}
    results: list[dict] = []
    total = len(files)
    for i, src in enumerate(files):
        if cancelled():
            break
        name = src.name
        report(i / total, f"{name} ({i + 1}/{total})")
        entry = {"file": name, "status": "ok", "output": None, "message": ""}
        tmp = job_dir / f"batch-{i}{'.docx' if action == 'docx' else '.pdf'}"
        work = job_dir / f"work-{i}"
        work.mkdir(exist_ok=True)
        try:
            if not src.is_file():
                raise AppError("not_found", "The file no longer exists")
            try:
                with pikepdf.open(src) as probe:
                    if probe.is_encrypted and action != "protect":
                        raise AppError("password_required", "The file is password protected")
            except pikepdf.PasswordError as exc:
                raise AppError("password_required", "The file is password protected") from exc
            except pikepdf.PdfError as exc:
                raise AppError("invalid_pdf", "The file is not a valid PDF document") from exc

            def page_progress(n, of, _i=i):
                report((_i + (n / max(1, of))) / total, f"{name} ({_i + 1}/{total}) – {n + 1}/{of}")

            info = _process(action, src, tmp, opts, state, work, page_progress)
            target = output_path(src, out_dir, action)
            shutil.move(str(tmp), str(target))
            entry["output"] = target.name
            entry.update({k: v for k, v in info.items() if k not in entry})
        except AppError as exc:
            entry.update(status="error", message=exc.message)
        except Exception as exc:  # one bad file must not stop the batch
            entry.update(status="error", message=str(exc) or exc.__class__.__name__)
        finally:
            tmp.unlink(missing_ok=True)
            shutil.rmtree(work, ignore_errors=True)
        results.append(entry)
    report(1.0, "Done")
    return {
        "action": action,
        "output_dir": str(out_dir),
        "results": results,
        "ok": sum(1 for r in results if r["status"] == "ok"),
        "failed": sum(1 for r in results if r["status"] != "ok"),
        "cancelled": len(results) < total,
    }
