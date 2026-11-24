"""Phase 5: annotations (create, list, edit, move, delete, save, flatten)."""
from __future__ import annotations

import pypdf
import pymupdf as fitz

from conftest import ok


def add(client, d, page, spec, author="Tester"):
    return ok(client.post(f"/documents/{d}/annotations/add", json={"page": page, "spec": spec, "author": author}))


def listing(client, d, page=0):
    return ok(client.get(f"/documents/{d}/pages/{page}/annotations"))["annotations"]


def test_text_markup_from_selection_points(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    # "Invoice number INV-2024-0042 total 1,250.00 USD" baseline at PDF y=670, x from 60
    res = add(client, d, 0, {"type": "highlight", "start": [61, 674], "stop": [150, 674], "contents": "check this"})
    a = res["annotation"]
    assert a["type"] == "highlight" and a["author"] == "Tester" and a["contents"] == "check this"
    x0, y0, x1, y1 = a["rect"]
    assert 55 < x0 < 65 and 140 < x1 < 175 and y0 < 670 < y1  # includes the glyph under the stop point
    page = fitz.open(res["working_path"])[0]
    hl = next(page.annots())
    assert "Invoice" in page.get_textbox(hl.rect)
    for t in ("underline", "strikeout", "squiggly"):
        r = add(client, d, 0, {"type": t, "start": [61, 652], "stop": [300, 652]})
        assert r["annotation"]["type"] == t
    r = client.post(f"/documents/{d}/annotations/add", json={"page": 0, "spec": {"type": "highlight", "start": [500, 50], "stop": [520, 52]}})
    assert r.status_code in (200, 400)


def test_all_annotation_types_and_save(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    specs = [
        {"type": "note", "point": [500, 800], "contents": "A sticky note ภาษาไทย", "icon": "Comment"},
        {"type": "freetext", "rect": [300, 500, 500, 560], "contents": "Text comment\nภาษาไทย น้ำ", "font_size": 11, "stroke": "#0000ff"},
        {"type": "callout", "rect": [350, 400, 520, 440], "contents": "Callout", "callout": [[200, 380], [300, 420], [350, 420]]},
        {"type": "rect", "rect": [50, 50, 150, 120], "stroke": "#ff0000", "fill": "#ffff00", "border_width": 3},
        {"type": "circle", "rect": [200, 50, 300, 120]},
        {"type": "line", "points": [[50, 200], [250, 250]]},
        {"type": "arrow", "points": [[50, 300], [250, 320]], "stroke": "#00aa00"},
        {"type": "ink", "strokes": [[[100, 600], [150, 620], [200, 590]], [[100, 580], [200, 580]]]},
        {"type": "stamp", "rect": [380, 600, 560, 650], "stamp": "Confidential"},
    ]
    for s in specs:
        add(client, d, 0, s)
    items = listing(client, d)
    types = sorted(a["type"] for a in items)
    assert types == sorted(["note", "freetext", "freetext", "rect", "circle", "line", "line", "ink", "stamp"])
    note = next(a for a in items if a["type"] == "note")
    assert note["contents"] == "A sticky note ภาษาไทย" and note["icon"] == "Comment"
    arrow = next(a for a in items if a["type"] == "line" and a["stroke"] == "#00aa00")
    assert arrow["line_ends"][1] == "open"
    stamp = next(a for a in items if a["type"] == "stamp")
    assert stamp["stamp"] == "Confidential"
    ink = next(a for a in items if a["type"] == "ink")
    assert len(ink["strokes"]) == 2 and abs(ink["strokes"][0][0][0] - 100) < 1
    out = tmp_path / "annots.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out)}))
    r = pypdf.PdfReader(str(out))
    subtypes = sorted(str(a.get_object()["/Subtype"]) for a in r.pages[0]["/Annots"] if a.get_object()["/Subtype"] != "/Popup")
    assert subtypes.count("/FreeText") == 2 and "/Ink" in subtypes and "/Stamp" in subtypes and "/Text" in subtypes
    ft = next(a.get_object() for a in r.pages[0]["/Annots"] if a.get_object()["/Subtype"] == "/FreeText" and "Text comment" in str(a.get_object().get("/Contents", "")))
    assert "ภาษาไทย" in str(ft["/Contents"])
    assert all(a.get_object().get("/AP") is not None for a in r.pages[0]["/Annots"] if a.get_object()["/Subtype"] != "/Popup")


def test_edit_move_resize_delete(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    rect = add(client, d, 0, {"type": "rect", "rect": [50, 50, 150, 120]})["annotation"]
    ink = add(client, d, 0, {"type": "ink", "strokes": [[[100, 300], [200, 350]]]})["annotation"]
    note = add(client, d, 0, {"type": "note", "point": [400, 400], "contents": "old"})["annotation"]
    r = ok(client.post(f"/documents/{d}/annotations/update", json={"page": 0, "xref": rect["xref"], "spec": {"rect": [60, 60, 260, 160], "stroke": "#00ff00", "opacity": 0.5}}))
    a = r["annotation"]
    assert [round(v) for v in a["rect"]][0] in (58, 59, 60) and a["stroke"] == "#00ff00" and abs(a["opacity"] - 0.5) < 0.01
    r = ok(client.post(f"/documents/{d}/annotations/update", json={"page": 0, "xref": ink["xref"], "spec": {"rect": [ink["rect"][0] + 50, ink["rect"][1] + 10, ink["rect"][2] + 50, ink["rect"][3] + 10]}}))
    moved = r["annotation"]
    assert abs(moved["strokes"][0][0][0] - 150) < 2
    r = ok(client.post(f"/documents/{d}/annotations/update", json={"page": 0, "xref": note["xref"], "spec": {"contents": "new text", "icon": "Key"}}))
    assert r["annotation"]["contents"] == "new text"
    ok(client.post(f"/documents/{d}/annotations/delete", json={"page": 0, "xrefs": [r["annotation"]["xref"]]}))
    assert not any(a["type"] == "note" for a in listing(client, d))


def test_flatten_annotations(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    add(client, d, 0, {"type": "freetext", "rect": [300, 500, 500, 560], "contents": "FLATTEN ME"})
    add(client, d, 1, {"type": "rect", "rect": [50, 50, 150, 120]})
    r = ok(client.post(f"/documents/{d}/annotations/flatten", json={}))
    assert r["flattened"] == 2
    doc = fitz.open(r["working_path"])
    assert doc[0].first_annot is None and doc[1].first_annot is None
    assert "FLATTEN ME" in doc[0].get_text()


def test_all_annotations_listing(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    add(client, d, 2, {"type": "note", "point": [100, 100], "contents": "page three"})
    items = ok(client.get(f"/documents/{d}/annotations"))["annotations"]
    assert items[-1]["page"] == 2 and items[-1]["contents"] == "page three"
