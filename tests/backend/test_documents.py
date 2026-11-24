"""Phase 1: opening, revisions (undo/redo), atomic saving, recovery, security of the API."""
from __future__ import annotations

import json
from pathlib import Path

import pikepdf
import pymupdf as fitz
import pypdf

from conftest import TOKEN, ok


def test_auth_required(client):
    r = client.get("/health", headers={"X-PDFEd-Token": "wrong"})
    assert r.status_code == 401
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.get("/health", headers={"Host": "evil.example"})
    assert r.status_code == 403
    assert ok(client.get("/health"))["status"] == "ok"


def test_open_small(open_doc, fixtures):
    info = open_doc(fixtures / "small.pdf")
    assert info["page_count"] == 3
    assert info["pages"][0]["width"] == 595
    assert info["metadata"]["title"] == "Small sample"
    assert info["has_outline"]
    assert not info["can_undo"]
    assert Path(info["working_path"]).exists()


def test_open_rejects_non_pdf(client, fixtures):
    r = client.post("/documents/open", json={"path": str(fixtures / "not_a_pdf.pdf")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_pdf"
    r = client.post("/documents/open", json={"path": str(fixtures / "missing.pdf")})
    assert r.status_code == 404


def test_open_encrypted_requires_password(client, open_doc, fixtures):
    r = client.post("/documents/open", json={"path": str(fixtures / "encrypted.pdf")})
    assert r.status_code == 401 and r.json()["error"]["code"] == "password_required"
    r = client.post("/documents/open", json={"path": str(fixtures / "encrypted.pdf"), "password": "nope"})
    assert r.json()["error"]["code"] == "invalid_password"
    info = open_doc(fixtures / "encrypted.pdf", "user123")
    assert info["source_encrypted"] and info["page_count"] == 3
    # working copy is decrypted
    assert not fitz.open(info["working_path"]).needs_pass


def test_restricted_document_is_read_only_until_unlocked(client, open_doc, fixtures):
    info = open_doc(fixtures / "restricted.pdf")
    assert info["source_encrypted"] and info["owner_authenticated"] is False
    assert info["permissions"]["modify"] is False
    r = client.post(f"/documents/{info['doc_id']}/pages/rotate", json={"pages": [0], "angle": 90})
    assert r.status_code == 403
    from services.document_manager import manager

    s = manager.get(info["doc_id"])
    try:
        s.unlock("wrong")
        raise AssertionError("expected failure")
    except Exception as exc:  # noqa: BLE001
        assert "owner" in str(exc)
    s.unlock("owner123")
    ok(client.post(f"/documents/{info['doc_id']}/pages/rotate", json={"pages": [0], "angle": 90}))


def test_open_corrupted_is_repaired(open_doc, fixtures):
    info = open_doc(fixtures / "corrupted.pdf")
    assert info["repaired"] is True
    assert info["page_count"] == 3


def test_coordinate_geometry_with_offset_boxes(open_doc, fixtures):
    info = open_doc(fixtures / "boxes.pdf")
    p = info["pages"][0]
    assert p["mediabox"] == [10, 20, 610, 820]
    assert p["cropbox"] == [50, 60, 500, 700]
    assert p["width"] == 450 and p["height"] == 640


def test_search_returns_pdf_coordinates(client, open_doc, fixtures):
    info = open_doc(fixtures / "boxes.pdf")
    res = ok(client.post(f"/documents/{info['doc_id']}/search", json={"query": "MARK"}))
    assert res["total"] == 1
    x0, y0, x1, y1 = res["results"][0]["rect"]
    # text drawn at PDF (100, 300): rect must contain the baseline origin
    assert abs(x0 - 100) < 1 and y0 < 300 < y1


def test_undo_redo_revisions(client, open_doc, fixtures):
    info = open_doc(fixtures / "small.pdf")
    d = info["doc_id"]
    r1 = ok(client.post(f"/documents/{d}/pages/rotate", json={"pages": [0], "angle": 90}))
    assert r1["pages"][0]["rotation"] == 90 and r1["can_undo"]
    r2 = ok(client.post(f"/documents/{d}/pages/delete", json={"pages": [2]}))
    assert r2["page_count"] == 2
    # undo twice
    u1 = ok(client.post(f"/documents/{d}/revision", json={"revision": r1["revision"]}))
    assert u1["page_count"] == 3 and u1["can_redo"]
    u0 = ok(client.post(f"/documents/{d}/revision", json={"revision": info["revision"]}))
    assert u0["pages"][0]["rotation"] == 0
    # redo
    rr = ok(client.post(f"/documents/{d}/revision", json={"revision": r2["revision"]}))
    assert rr["page_count"] == 2
    # new mutation after undo truncates redo branch
    ok(client.post(f"/documents/{d}/revision", json={"revision": r1["revision"]}))
    r3 = ok(client.post(f"/documents/{d}/pages/rotate", json={"pages": [1], "angle": 180}))
    assert r2["revision"] not in r3["revisions"]
    # stale base revision is rejected
    r = client.post(f"/documents/{d}/pages/rotate", json={"pages": [1], "angle": 90, "base_revision": 0})
    assert r.status_code == 409


def test_original_never_modified_until_save(client, open_doc, work):
    src = work / "small.pdf"
    before = src.read_bytes()
    info = open_doc(src)
    ok(client.post(f"/documents/{info['doc_id']}/pages/delete", json={"pages": [0]}))
    assert src.read_bytes() == before


def test_atomic_save_and_reopen(client, open_doc, work):
    src = work / "small.pdf"
    info = open_doc(src)
    d = info["doc_id"]
    ok(client.post(f"/documents/{d}/pages/rotate", json={"pages": [1], "angle": 90}))
    res = ok(client.post(f"/documents/{d}/save", json={"target_path": str(src)}))
    assert res["backup"] and Path(res["backup"]).exists()
    assert res["info"]["saved_revision"] == res["info"]["revision"]
    # independent readers
    assert len(pypdf.PdfReader(str(src)).pages) == 3
    assert pypdf.PdfReader(str(src)).pages[1].get("/Rotate") == 90
    with pikepdf.open(src) as pdf:
        assert len(pdf.pages) == 3
    # no temp files left behind
    assert not [p for p in work.iterdir() if ".saving." in p.name or ".enc." in p.name]
    # reopen saved file
    info2 = open_doc(src)
    assert info2["pages"][1]["rotation"] == 90


def test_save_as_new_file(client, open_doc, work):
    info = open_doc(work / "pages100.pdf")
    target = work / "copy.pdf"
    res = ok(client.post(f"/documents/{info['doc_id']}/save", json={"target_path": str(target)}))
    assert res["pages"] == 100 and target.exists()
    assert res["info"]["display_name"] == "copy.pdf"


def test_save_rejects_bad_target(client, open_doc, work):
    info = open_doc(work / "small.pdf")
    r = client.post(f"/documents/{info['doc_id']}/save", json={"target_path": str(work / "x.txt")})
    assert r.status_code == 400
    r = client.post(f"/documents/{info['doc_id']}/save", json={"target_path": str(work / "nope" / "x.pdf")})
    assert r.status_code == 400


def test_save_with_encryption_roundtrip(client, open_doc, work):
    from services.document_manager import manager

    info = open_doc(work / "small.pdf")
    s = manager.get(info["doc_id"])
    s.security = {"user_password": "open-me", "owner_password": "owner!", "permissions": {"print": True,
                                                                                           "copy": False}}
    target = work / "secured.pdf"
    ok(client.post(f"/documents/{info['doc_id']}/save", json={"target_path": str(target)}))
    r = pypdf.PdfReader(str(target))
    assert r.is_encrypted
    assert r.decrypt("open-me")
    assert len(r.pages) == 3


def test_recovery_restore(client, app_settings, work):
    from services.document_manager import manager

    info = ok(client.post("/documents/open", json={"path": str(work / "small.pdf")}))
    d = info["doc_id"]
    ok(client.post(f"/documents/{d}/pages/delete", json={"pages": [0]}))
    ok(client.post(f"/documents/{d}/ui-state", json={"state": {"overlays": [{"id": "o1"}]}}))
    # simulate a crash: forget the in-memory session but keep files
    manager.sessions.pop(d)._drop_cache()
    rec = ok(client.get("/recovery"))["sessions"]
    entry = next(x for x in rec if x["session_id"] == d)
    assert entry["unsaved"] and entry["display_name"] == "small.pdf"
    restored = ok(client.post("/recovery/restore", json={"session_id": d}))
    assert restored["page_count"] == 2
    assert restored["ui_state"]["overlays"][0]["id"] == "o1"
    ok(client.post(f"/documents/{d}/close", json={"delete_session": True}))
    assert not (app_settings.sessions_root / d).exists()


def test_session_json_has_no_secrets(client, open_doc, fixtures, app_settings):
    info = open_doc(fixtures / "encrypted.pdf", "user123")
    meta = (app_settings.sessions_root / info["doc_id"] / "session.json").read_text()
    assert "user123" not in meta
    json.loads(meta)


def test_large_document_opens_fast(open_doc, fixtures):
    import time

    t = time.time()
    info = open_doc(fixtures / "pages500.pdf")
    assert info["page_count"] == 500
    assert time.time() - t < 10


def test_outline_and_attachments(client, open_doc, work):
    info = open_doc(work / "attachment.pdf")
    d = info["doc_id"]
    att = ok(client.get(f"/documents/{d}/attachments"))["attachments"]
    assert att[0]["name"] == "notes.txt"
    ok(client.post(f"/documents/{d}/attachments/extract", json={"name": "notes.txt",
                                                                  "target_path": str(work / "out.txt")}))
    assert (work / "out.txt").read_text() == "hello attachment"
    ok(client.post(f"/documents/{d}/attachments/add", json={"path": str(work / "logo.png")}))
    assert len(ok(client.get(f"/documents/{d}/attachments"))["attachments"]) == 2
    ok(client.post(f"/documents/{d}/outline", json={"toc": [[1, "Start", 1]]}))
    assert ok(client.get(f"/documents/{d}/outline"))["toc"] == [[1, "Start", 1]]


def test_page_analysis_detects_scans(client, open_doc, fixtures):
    info = open_doc(fixtures / "scanned.pdf")
    pages = ok(client.get(f"/documents/{info['doc_id']}/pages/analysis"))["pages"]
    assert all(p["scanned"] for p in pages)
    info2 = open_doc(fixtures / "small.pdf")
    pages2 = ok(client.get(f"/documents/{info2['doc_id']}/pages/analysis"))["pages"]
    assert not any(p["scanned"] for p in pages2)


def test_image_asset(client, fixtures):
    res = ok(client.post("/assets/image", json={"path": str(fixtures / "logo.png")}))
    assert res["width"] == 400 and res["asset_id"].endswith(".png")
    r = client.post("/assets/image", json={"path": str(fixtures / "small.pdf")})
    assert r.status_code == 400


def test_protection_is_kept_on_save(client, open_doc, fixtures, tmp_path):
    """Saving a password-protected document must not silently remove its protection."""
    info = open_doc(fixtures / "encrypted.pdf", "user123")
    assert info["security"]["preserved"] and info["security"]["has_user_password"]
    out = tmp_path / "kept.pdf"
    ok(client.post(f"/documents/{info['doc_id']}/save", json={"target_path": str(out)}))
    r = pypdf.PdfReader(str(out))
    assert r.is_encrypted and r.decrypt("user123")
    assert not pypdf.PdfReader(str(out)).decrypt("wrong")
    with pikepdf.open(out, password="user123") as pdf:
        assert pdf.allow.print_lowres


def test_revision_disk_budget_prunes_oldest(client, open_doc, fixtures, app_settings):
    """Undo history of a large document stays within the disk budget."""
    info = open_doc(fixtures / "pages100.pdf")
    doc = info["doc_id"]
    session_dir = app_settings.sessions_root / doc
    one = max(p.stat().st_size for p in session_dir.glob("rev-*.pdf"))
    old = app_settings.max_revision_bytes
    app_settings.max_revision_bytes = int(one * 3.5)  # room for ~3 revisions
    try:
        for _ in range(6):
            r = client.post(f"/documents/{doc}/pages/rotate", json={"pages": [0], "angle": 90})
            assert r.status_code == 200, r.text
        revs = sorted(session_dir.glob("rev-*.pdf"))
        assert 2 <= len(revs) <= 4
        assert sum(p.stat().st_size for p in revs) <= app_settings.max_revision_bytes
        # the remaining (newest) undo steps still work
        rev_ids = ok(client.get(f"/documents/{doc}"))["revisions"]
        assert len(rev_ids) == len(revs)
        ok(client.post(f"/documents/{doc}/revision", json={"revision": rev_ids[-2]}))
    finally:
        app_settings.max_revision_bytes = old
