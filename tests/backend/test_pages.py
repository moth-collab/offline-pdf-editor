"""Phase 2: page operations, merge, split, extract (verified with independent readers)."""
from __future__ import annotations

import pypdf
import pymupdf as fitz

from conftest import ok


def _texts(path):
    return [p.extract_text() for p in pypdf.PdfReader(str(path)).pages]


def test_delete_pages_page_map(client, open_doc, fixtures):
    d = open_doc(fixtures / "pages100.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{d}/pages/delete", json={"pages": [0, 5, 99]}))
    assert r["page_count"] == 97
    assert r["page_map"][0] == 1 and r["page_map"][4] == 6 and r["page_map"][-1] == 98
    r = client.post(f"/documents/{d}/pages/delete", json={"pages": list(range(97))})
    assert r.status_code == 400  # cannot delete all pages


def test_reorder_and_move(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{d}/pages/reorder", json={"order": [2, 0, 1]}))
    assert r["page_map"] == [2, 0, 1]
    out = tmp_path / "o.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out)}))
    t = _texts(out)
    assert "Page 3" in t[0] and "Page 1" in t[1] and "Page 2" in t[2]
    r = ok(client.post(f"/documents/{d}/pages/move", json={"pages": [0], "to": 2}))
    assert r["page_map"] == [1, 2, 0]
    bad = client.post(f"/documents/{d}/pages/reorder", json={"order": [0, 0, 1]})
    assert bad.status_code == 400


def test_rotate_reverse_duplicate(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{d}/pages/rotate", json={"pages": [0, 1], "angle": -90}))
    assert [p["rotation"] for p in r["pages"]] == [270, 270, 0]
    assert r["modified_pages"] == [0, 1]
    r = ok(client.post(f"/documents/{d}/pages/reverse", json={"pages": []}))
    assert r["page_map"] == [2, 1, 0]
    r = ok(client.post(f"/documents/{d}/pages/duplicate", json={"pages": [0]}))
    assert r["page_count"] == 4 and r["page_map"] == [0, None, 1, 2]


def test_insert_blank_and_file(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{d}/pages/insert-blank", json={"at": 1, "count": 2, "width": 612,
                                                                   "height": 792}))
    assert r["page_count"] == 5 and r["page_map"] == [0, None, None, 1, 2]
    assert r["pages"][1]["width"] == 612
    r = ok(client.post(f"/documents/{d}/pages/insert-file", json={"at": 5, "path": str(fixtures / "pages100.pdf"),
                                                                  "pages": [0, 1, 2, 50]}))
    assert r["page_count"] == 9
    # password protected source
    r = client.post(f"/documents/{d}/pages/insert-file", json={"at": 0, "path": str(fixtures / "encrypted.pdf")})
    assert r.status_code == 401
    r = ok(client.post(f"/documents/{d}/pages/insert-file", json={"at": 0, "path": str(fixtures / "encrypted.pdf"),
                                                                  "password": "user123"}))
    assert r["page_count"] == 12


def test_copy_pages_between_documents(client, open_doc, fixtures):
    a = open_doc(fixtures / "small.pdf")["doc_id"]
    b = open_doc(fixtures / "pages100.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{a}/pages/copy-from", json={"source_doc_id": b, "pages": [9, 10], "at": 3}))
    assert r["page_count"] == 5


def test_crop_and_reset(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{d}/pages/crop", json={"pages": [0], "margins": [50, 100, 50, 20]}))
    p = r["pages"][0]
    assert abs(p["width"] - 495) < 0.01 and abs(p["height"] - 722) < 0.01
    assert p["cropbox"] == [50, 100, 545, 822]
    r = ok(client.post(f"/documents/{d}/pages/crop", json={"pages": [1], "box": [100, 100, 400, 500]}))
    assert r["pages"][1]["cropbox"] == [100, 100, 400, 500]
    r = ok(client.post(f"/documents/{d}/pages/crop", json={"pages": [0, 1], "reset": True}))
    assert r["pages"][0]["width"] == 595 and r["pages"][1]["cropbox"] == [0, 0, 595, 842]


def test_resize(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{d}/pages/resize", json={"pages": [0], "width": 612, "height": 792}))
    assert r["pages"][0]["width"] == 612
    out = tmp_path / "r.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out)}))
    assert "Quarterly Report - Page 1" in _texts(out)[0]


def test_extract_split_merge(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "pages100.pdf")["doc_id"]
    res = ok(client.post(f"/documents/{d}/pages/extract", json={"pages": [4, 5, 6],
                                                                 "target_path": str(tmp_path / "ex.pdf")}))
    assert res["pages"] == 3
    assert "Page 5 of 100" in _texts(tmp_path / "ex.pdf")[0]

    outdir = tmp_path / "split"
    outdir.mkdir()
    files = ok(client.post(f"/documents/{d}/split", json={"mode": "every", "every": 30,
                                                          "output_dir": str(outdir)}))["files"]
    assert len(files) == 4 and files[-1]["pages"] == [90, 99]
    assert sum(len(pypdf.PdfReader(f["path"]).pages) for f in files) == 100

    outdir2 = tmp_path / "split2"
    outdir2.mkdir()
    files = ok(client.post(f"/documents/{d}/split", json={"mode": "ranges", "ranges": [[0, 9], [10, 10]],
                                                          "output_dir": str(outdir2)}))["files"]
    assert [len(pypdf.PdfReader(f["path"]).pages) for f in files] == [10, 1]

    outdir3 = tmp_path / "split3"
    outdir3.mkdir()
    files = ok(client.post(f"/documents/{d}/split", json={"mode": "bookmarks", "output_dir": str(outdir3)}))["files"]
    assert len(files) == 5

    items = [{"path": str(fixtures / "small.pdf")},
             {"path": str(fixtures / "encrypted.pdf"), "password": "user123"},
             {"path": files[0]["path"], "pages": [0, 1]}]
    merged = ok(client.post("/merge", json={"items": items, "display_name": "Merged.pdf"}))
    assert merged["page_count"] == 8 and merged["original_path"] is None and merged["saved_revision"] is None
    client.post(f"/documents/{merged['doc_id']}/close", json={"delete_session": True})


def test_split_by_size(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "pages100.pdf")["doc_id"]
    out = tmp_path / "sz"
    out.mkdir()
    files = ok(client.post(f"/documents/{d}/split", json={"mode": "size", "max_bytes": 200_000,
                                                          "output_dir": str(out)}))["files"]
    assert len(files) >= 2
    assert sum(len(pypdf.PdfReader(f["path"]).pages) for f in files) == 100


def test_images_to_pdf(client, fixtures):
    r = ok(client.post("/images-to-pdf", json={"paths": [str(fixtures / "photo.jpg"), str(fixtures / "logo.png")],
                                               "page_size": "a4", "margin": 20}))
    assert r["page_count"] == 2
    assert r["pages"][0]["width"] > r["pages"][0]["height"]  # landscape photo -> landscape A4
    doc = fitz.open(r["working_path"])
    assert doc[0].get_images()
    client.post(f"/documents/{r['doc_id']}/close", json={"delete_session": True})


def test_insert_images_into_document(client, open_doc, fixtures, tmp_path):
    """Images become pages of the open document at the chosen position (one undo step)."""
    import shutil

    from conftest import ok

    shutil.copy(fixtures / "small.pdf", tmp_path / "small.pdf")
    info = open_doc(tmp_path / "small.pdf")
    doc = info["doc_id"]
    base = ok(client.get(f"/documents/{doc}"))
    n, rev = base["page_count"], base["revision"]
    first = base["pages"][0]
    res = ok(client.post(f"/documents/{doc}/pages/insert-images", json={
        "at": 1, "paths": [str(fixtures / "logo.png"), str(fixtures / "photo.jpg")]}))
    assert res["page_count"] == n + 2
    # "match": new pages take the size of the neighbouring page (orientation follows the image)
    for p in res["pages"][1:3]:
        assert sorted([round(p["width"]), round(p["height"])]) == sorted([round(first["width"]), round(first["height"])])
    # the pages contain the images
    import pymupdf as fitz
    w = ok(client.get(f"/documents/{doc}"))
    d = fitz.open(w["working_path"]) if "working_path" in w else None
    if d is not None:
        assert d[1].get_images() and d[2].get_images()
    # undo restores the original page count
    back = ok(client.post(f"/documents/{doc}/revision", json={"revision": rev}))
    assert back["page_count"] == n
    bad = client.post(f"/documents/{doc}/pages/insert-images", json={"at": 0, "paths": [str(fixtures / "small.pdf")]})
    assert bad.status_code == 400
