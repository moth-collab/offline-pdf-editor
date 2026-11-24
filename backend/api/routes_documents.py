"""Document lifecycle, saving, search, outline, attachments and assets."""
from __future__ import annotations

import base64
import hashlib
import io
import re
import shutil
from pathlib import Path

import pymupdf as fitz
from fastapi import APIRouter
from PIL import Image

from core.config import APP_VERSION, get_settings
from core.coords import PageCoords
from core.errors import AppError
from models.schemas import (AssetImageRequest, AttachmentAddRequest, AttachmentExtractRequest,
                            AttachmentNameRequest, CloseRequest, OpenRequest, OutlineRequest, RestoreRequest,
                            RevisionRequest, SaveRequest, SearchRequest, UiStateRequest)
from services.document_manager import manager
from services.fonts import font_index
from services.saving import save_document

router = APIRouter()


@router.get("/health")
async def health():
    s = get_settings()
    cmd, tessdata = s.resolve_tesseract()
    return {"status": "ok", "version": APP_VERSION, "tesseract": bool(cmd), "pymupdf": fitz.VersionBind}


@router.get("/capabilities")
def capabilities():
    from services import ocr

    caps = {"ocr": ocr.status()}
    try:
        import pyhanko  # noqa: F401

        caps["digital_signatures"] = True
    except Exception:  # pragma: no cover
        caps["digital_signatures"] = False
    try:
        import pdf2docx  # noqa: F401

        caps["pdf_to_word"] = True
    except Exception:  # pragma: no cover
        caps["pdf_to_word"] = False
    return caps


# ----------------------------------------------------------------------
# lifecycle
# ----------------------------------------------------------------------


@router.post("/documents/open")
def open_document(req: OpenRequest):
    s = manager.open(req.path, req.password)
    return s.info()


@router.get("/recovery")
def list_recovery():
    return {"sessions": manager.list_recoverable()}


@router.post("/recovery/restore")
def restore(req: RestoreRequest):
    if not re.fullmatch(r"[0-9a-f]{32}", req.session_id):
        raise AppError("invalid_request", "Invalid session id")
    s = manager.restore(manager.root / req.session_id)
    info = s.info()
    info["ui_state"] = s.load_ui_state()
    return info


@router.post("/recovery/{session_id}/discard")
def discard(session_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", session_id):
        raise AppError("invalid_request", "Invalid session id")
    manager.discard_recoverable(session_id)
    return {"ok": True}


@router.post("/documents/{doc_id}/close")
def close_document(doc_id: str, req: CloseRequest):
    manager.close(doc_id, delete=req.delete_session)
    return {"ok": True}


@router.get("/documents/{doc_id}")
def document_info(doc_id: str):
    return manager.get(doc_id).info()


@router.post("/documents/{doc_id}/revision")
def set_revision(doc_id: str, req: RevisionRequest):
    return manager.get(doc_id).set_revision(req.revision)


@router.post("/documents/{doc_id}/save")
def save(doc_id: str, req: SaveRequest):
    s = manager.get(doc_id)
    return save_document(s, req.target_path, overlays=req.overlays, make_backup=req.make_backup)


@router.post("/documents/{doc_id}/ui-state")
def ui_state(doc_id: str, req: UiStateRequest):
    manager.get(doc_id).save_ui_state(req.state)
    return {"ok": True}


# ----------------------------------------------------------------------
# analysis / search
# ----------------------------------------------------------------------


@router.get("/documents/{doc_id}/pages/analysis")
def page_analysis(doc_id: str):
    """Classify pages: text pages vs scanned (image-only) pages."""
    doc = manager.get(doc_id).open_read()
    out = []
    for page in doc:
        text = page.get_text("text").strip()
        area = abs(page.rect) or 1
        img_area = 0.0
        for info in page.get_image_info():
            r = fitz.Rect(info["bbox"]) & page.rect
            img_area += abs(r)
        coverage = min(img_area / area, 1.0)
        out.append({
            "index": page.number,
            "text_chars": len(text),
            "image_coverage": round(coverage, 3),
            "scanned": len(text) < 10 and coverage > 0.5,
            "has_invisible_text": _has_invisible_text(page) if text else False,
        })
    return {"pages": out}


def _has_invisible_text(page: fitz.Page) -> bool:
    try:
        for tr in page.get_texttrace()[:50]:
            if tr.get("type") == 3:  # render mode 3 = invisible (typical OCR layer)
                return True
    except Exception:
        return False
    return False


@router.post("/documents/{doc_id}/search")
def search(doc_id: str, req: SearchRequest):
    doc = manager.get(doc_id).open_read()
    q = req.query.strip()
    if not q:
        return {"results": [], "total": 0}
    results = []
    total = 0
    flags = fitz.TEXT_DEHYPHENATE | fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP
    for page in doc:
        coords = PageCoords.for_page(page)
        quads = page.search_for(q, quads=True, flags=flags)
        if not quads:
            continue
        words = None
        for qd in quads:
            rect = qd.rect
            if req.case_sensitive or req.whole_word:
                found = page.get_textbox(rect + (-1, -1, 1, 1)) or ""
                if req.case_sensitive and q not in found:
                    continue
                if req.whole_word:
                    if words is None:
                        words = page.get_text("words")
                    if not any(fitz.Rect(w[:4]).intersects(rect) and w[4].strip(".,;:!?()\"'").lower() == q.lower()
                               for w in words):
                        continue
            total += 1
            if len(results) < req.max_results:
                ctx_rect = fitz.Rect(page.rect.x0, rect.y0 - 1, page.rect.x1, rect.y1 + 1)
                context = " ".join(page.get_textbox(ctx_rect).split())[:160]
                results.append({"page": page.number, "rect": coords.rect_to_pdf(rect), "quad": coords.quad_to_pdf(qd),
                                "context": context})
    return {"results": results, "total": total}


@router.get("/documents/{doc_id}/pages/{page}/links")
def links(doc_id: str, page: int):
    doc = manager.get(doc_id).open_read()
    if not 0 <= page < doc.page_count:
        raise AppError("invalid_page", "Page out of range")
    p = doc[page]
    coords = PageCoords.for_page(p)
    out = []
    for ln in p.get_links():
        kind = ln.get("kind")
        item = {"rect": coords.rect_to_pdf(ln["from"]), "kind": kind}
        if kind == fitz.LINK_URI:
            item["uri"] = ln.get("uri")
        elif kind in (fitz.LINK_GOTO, fitz.LINK_NAMED):
            item["page"] = ln.get("page")
        out.append(item)
    return {"links": out}


# ----------------------------------------------------------------------
# outline (bookmarks)
# ----------------------------------------------------------------------


@router.get("/documents/{doc_id}/outline")
def outline(doc_id: str):
    doc = manager.get(doc_id).open_read()
    return {"toc": [[lvl, title, page] for lvl, title, page, *_ in doc.get_toc(simple=False)]}


@router.post("/documents/{doc_id}/outline")
def set_outline(doc_id: str, req: OutlineRequest):
    s = manager.get(doc_id)

    def fn(doc: fitz.Document):
        toc = []
        prev = 0
        for item in req.toc:
            lvl, title, page = int(item[0]), str(item[1]), int(item[2])
            lvl = max(1, min(lvl, prev + 1))
            page = max(1, min(page, doc.page_count))
            toc.append([lvl, title, page])
            prev = lvl
        doc.set_toc(toc)
        return {"modified": []}

    return s.mutate("Edit bookmarks", fn, base_rev=req.base_revision).to_dict()


# ----------------------------------------------------------------------
# attachments
# ----------------------------------------------------------------------


@router.get("/documents/{doc_id}/attachments")
def attachments(doc_id: str):
    doc = manager.get(doc_id).open_read()
    out = []
    for name in doc.embfile_names():
        info = doc.embfile_info(name)
        out.append({"name": name, "filename": info.get("filename") or name, "size": info.get("size"),
                    "description": info.get("description"), "created": info.get("creationDate")})
    return {"attachments": out}


@router.post("/documents/{doc_id}/attachments/add")
def add_attachment(doc_id: str, req: AttachmentAddRequest):
    s = manager.get(doc_id)
    p = Path(req.path)
    if not p.is_file():
        raise AppError("file_not_found", "Attachment file not found")
    data = p.read_bytes()

    def fn(doc: fitz.Document):
        name = p.name
        existing = set(doc.embfile_names())
        n = 1
        while name in existing:
            n += 1
            name = f"{p.stem} ({n}){p.suffix}"
        doc.embfile_add(name, data, filename=p.name, ufilename=p.name, desc=req.description or "")
        return {"modified": []}

    return s.mutate("Add attachment", fn, base_rev=req.base_revision).to_dict()


@router.post("/documents/{doc_id}/attachments/delete")
def delete_attachment(doc_id: str, req: AttachmentNameRequest):
    s = manager.get(doc_id)

    def fn(doc: fitz.Document):
        doc.embfile_del(req.name)
        return {"modified": []}

    return s.mutate("Delete attachment", fn, base_rev=req.base_revision).to_dict()


@router.post("/documents/{doc_id}/attachments/extract")
def extract_attachment(doc_id: str, req: AttachmentExtractRequest):
    doc = manager.get(doc_id).open_read()
    data = doc.embfile_get(req.name)
    target = Path(req.target_path)
    tmp = target.with_name(target.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(target)
    return {"path": str(target), "size": len(data)}


# ----------------------------------------------------------------------
# assets (images inserted as overlay objects)
# ----------------------------------------------------------------------


def assets_dir() -> Path:
    d = get_settings().sessions_root.parent / "assets"
    d.mkdir(parents=True, exist_ok=True)
    return d


ALLOWED_IMAGE_FORMATS = {"JPEG": "jpg", "PNG": "png", "GIF": "gif", "BMP": "bmp", "TIFF": "tif", "WEBP": "webp"}


@router.post("/assets/image")
def add_image_asset(req: AssetImageRequest):
    if req.path:
        p = Path(req.path)
        if not p.is_file():
            raise AppError("file_not_found", "Image not found")
        data = p.read_bytes()
    elif req.data_base64:
        data = base64.b64decode(req.data_base64.split(",")[-1])
    else:
        raise AppError("invalid_request", "No image supplied")
    if len(data) > 80 * 1024 * 1024:
        raise AppError("too_large", "The image is too large (max 80 MB)")
    try:
        im = Image.open(io.BytesIO(data))
        im.verify()
        im = Image.open(io.BytesIO(data))
        fmt = (im.format or "").upper()
        w, h = im.size
    except Exception as exc:
        raise AppError("invalid_image", f"Unsupported or damaged image: {exc}") from exc
    if fmt not in ALLOWED_IMAGE_FORMATS:
        raise AppError("invalid_image", f"Unsupported image format: {fmt}")
    if fmt in ("TIFF", "BMP", "WEBP", "GIF"):
        # normalise to PNG for display + embedding
        buf = io.BytesIO()
        im.seek(0)
        im.convert("RGBA" if "A" in im.getbands() or "transparency" in im.info else "RGB").save(buf, "PNG")
        data = buf.getvalue()
        ext = "png"
    else:
        ext = ALLOWED_IMAGE_FORMATS[fmt]
    digest = hashlib.sha256(data).hexdigest()[:40]
    asset_id = f"{digest}.{ext}"
    target = assets_dir() / asset_id
    if not target.exists():
        target.write_bytes(data)
    return {"asset_id": asset_id, "width": w, "height": h, "path": str(target)}


# ----------------------------------------------------------------------
# fonts
# ----------------------------------------------------------------------


@router.get("/fonts")
def fonts():
    return {"families": font_index.families()}


@router.post("/fonts/rescan")
def rescan_fonts():
    font_index.build()
    return {"families": len(font_index.families())}


@router.get("/documents/{doc_id}/fonts")
def document_fonts(doc_id: str):
    from services.fonts import analyze_page_fonts

    doc = manager.get(doc_id).open_read()
    seen: dict[int, dict] = {}
    for page in doc:
        for f in analyze_page_fonts(doc, page):
            entry = seen.setdefault(f["xref"], {**f, "pages": []})
            entry["pages"].append(page.number)
    return {"fonts": list(seen.values())}


@router.post("/maintenance/cleanup-assets")
def cleanup_assets():
    """Delete image assets not referenced by any session UI state."""
    referenced: set[str] = set()
    root = manager.root
    for d in root.iterdir() if root.exists() else []:
        st = d / "ui-state.json"
        if st.exists():
            referenced.update(re.findall(r"[0-9a-f]{40}\.(?:jpg|png|gif)", st.read_text(encoding="utf-8")))
    removed = 0
    for f in assets_dir().iterdir():
        if f.name not in referenced:
            f.unlink(missing_ok=True)
            removed += 1
    return {"removed": removed}


def copy_into(src: Path, target: Path) -> None:
    tmp = target.with_name(target.name + ".part")
    shutil.copyfile(src, tmp)
    tmp.replace(target)
