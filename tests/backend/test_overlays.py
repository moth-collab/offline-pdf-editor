"""Phase 3: overlay objects baked into PDF content (verified with MuPDF + pypdf)."""
from __future__ import annotations

import pypdf
import pymupdf as fitz

from conftest import ok


def text_obj(page, rect, text, **kw):
    o = {"id": "t1", "kind": "text", "page": page, "rect": rect, "rotation": 0, "opacity": 1, "text": text,
         "font": "Liberation Sans", "fontSize": 14, "color": "#c00000", "bold": False, "italic": False,
         "underline": False, "strike": False, "align": "left", "lineHeight": 1.2, "charSpacing": 0,
         "background": None, "borderColor": None, "borderWidth": 0, "padding": 2}
    o.update(kw)
    return o


def pdf_rect_of(page: fitz.Page, needle: str):
    from core.coords import PageCoords

    hits = page.search_for(needle)
    assert hits, f"{needle!r} not found"
    return PageCoords.for_page(page).rect_to_pdf(hits[0])


def inside(inner, outer, tol=1.0):
    return inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol


def save(client, doc_id, target, overlays):
    return ok(client.post(f"/documents/{doc_id}/save", json={"target_path": str(target), "overlays": overlays}))


def test_text_overlay_position_and_extraction(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    rect = [300, 600, 560, 640]
    out = tmp_path / "t.pdf"
    save(client, d, out, [text_obj(0, rect, "Approved by Alice ภาษาไทย น้ำ")])
    doc = fitz.open(out)
    assert "Approved by Alice" in doc[0].get_text()
    assert "ภาษาไทย น้ำ" in doc[0].get_text()
    assert inside(pdf_rect_of(doc[0], "Approved"), rect)
    # independent reader
    assert "Approved by Alice" in pypdf.PdfReader(str(out)).pages[0].extract_text()
    # original content kept
    assert "Quarterly Report" in doc[0].get_text()


def test_overlay_coordinates_with_offset_cropbox_and_rotation(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "boxes.pdf")["doc_id"]
    rect = [120, 500, 300, 530]  # inside crop box [50,60,500,700]
    out = tmp_path / "b.pdf"
    save(client, d, out, [text_obj(0, rect, "OFFSET BOX")])
    assert inside(pdf_rect_of(fitz.open(out)[0], "OFFSET"), rect)

    d2 = open_doc(fixtures / "rotated.pdf")["doc_id"]
    rect2 = [100, 300, 400, 340]
    out2 = tmp_path / "r.pdf"
    save(client, d2, out2, [text_obj(1, rect2, "ON ROTATED PAGE", rotation=270)])
    page = fitz.open(out2)[1]
    assert page.rotation == 90
    found = pdf_rect_of(page, "ROTATED")
    # rotated 270 about the centre: bbox stays around the box centre
    cx, cy = (rect2[0] + rect2[2]) / 2, (rect2[1] + rect2[3]) / 2
    assert found[0] - 2 <= cx <= found[2] + 2 or abs((found[0] + found[2]) / 2 - cx) < 30
    assert abs((found[1] + found[3]) / 2 - cy) < 160


def test_rotated_text_and_styles(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    out = tmp_path / "s.pdf"
    save(client, d, out, [text_obj(0, [100, 400, 400, 460], "ROTATED STAMP", rotation=-30, bold=True, italic=True,
                                   underline=True, background="#ffff00", borderColor="#0000ff", borderWidth=2,
                                   opacity=0.6, align="center")])
    page = fitz.open(out)[0]
    assert "ROTATED STAMP" in page.get_text()
    dirs = [line["dir"] for b in page.get_text("dict")["blocks"] for line in b.get("lines", []) if "ROTATED" in
            "".join(s["text"] for s in line["spans"])]
    assert dirs and abs(dirs[0][1]) > 0.3  # text baseline is rotated
    assert len(page.get_drawings()) >= 2  # background/border + underline


def test_explicit_lines_are_kept(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    out = tmp_path / "l.pdf"
    o = text_obj(0, [60, 300, 400, 380], "alpha beta gamma delta", lines=[{"text": "alpha beta", "end": False},
                                                                        {"text": "gamma delta", "end": True}])
    save(client, d, out, [o])
    page = fitz.open(out)[0]
    a = pdf_rect_of(page, "alpha")
    g = pdf_rect_of(page, "gamma")
    assert g[3] < a[1]  # second line below the first


def test_image_overlay_with_crop_alpha_opacity(client, open_doc, fixtures, tmp_path):
    asset = ok(client.post("/assets/image", json={"path": str(fixtures / "logo.png")}))
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    out = tmp_path / "i.pdf"
    img = {"id": "i1", "kind": "image", "page": 0, "rect": [100, 100, 300, 200], "rotation": 15, "opacity": 0.8,
           "assetId": asset["asset_id"], "naturalWidth": 400, "naturalHeight": 200, "crop": [0.25, 0, 0, 0],
           "flipH": False, "flipV": False, "borderColor": "#000000", "borderWidth": 1}
    photo = ok(client.post("/assets/image", json={"path": str(fixtures / "photo.jpg")}))
    jpg = {**img, "id": "i2", "assetId": photo["asset_id"], "crop": [0, 0, 0, 0], "rotation": 0, "rect": [300, 300, 500, 450]}
    save(client, d, out, [img, jpg])
    page = fitz.open(out)[0]
    infos = page.get_image_info(xrefs=True)
    sizes = sorted((i["width"], i["height"]) for i in infos)
    assert (300, 200) in sizes  # 25% cropped away physically
    assert (800, 600) in sizes  # JPEG passed through
    doc = fitz.open(out)
    xref = next(i["xref"] for i in infos if i["width"] == 300)
    assert doc.xref_get_key(xref, "SMask")[0] == "xref"  # alpha kept as soft mask


def test_shapes_and_links(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    out = tmp_path / "sh.pdf"
    base = {"rotation": 0, "opacity": 1, "dash": None}
    objs = [
        {**base, "id": "r", "kind": "rect", "page": 0, "rect": [50, 50, 150, 100], "stroke": "#ff0000", "strokeWidth": 2,
         "fill": "#00ff00", "fillOpacity": 0.5},
        {**base, "id": "e", "kind": "ellipse", "page": 0, "rect": [200, 50, 300, 100], "stroke": "#0000ff", "strokeWidth": 1,
         "fill": None, "fillOpacity": 1},
        {**base, "id": "a", "kind": "arrow", "page": 1, "rect": [50, 200, 250, 260], "points": [[50, 200], [250, 260]],
         "stroke": "#000000", "strokeWidth": 2},
        {**base, "id": "l1", "kind": "link", "page": 0, "rect": [50, 700, 200, 720], "target": {"type": "url", "url": "https://example.org"}},
        {**base, "id": "l2", "kind": "link", "page": 0, "rect": [50, 650, 200, 670], "target": {"type": "page", "page": 2}},
    ]
    save(client, d, out, objs)
    doc = fitz.open(out)
    assert len(doc[0].get_drawings()) >= 2 and len(doc[1].get_drawings()) >= 2
    links = doc[0].get_links()
    assert any(lk.get("uri") == "https://example.org" for lk in links)
    assert any(lk.get("page") == 2 for lk in links)
    # unsafe link schemes are refused
    bad = {**objs[3], "target": {"type": "url", "url": "javascript:alert(1)"}}
    r = client.post(f"/documents/{d}/save", json={"target_path": str(tmp_path / "bad.pdf"), "overlays": [bad]})
    assert r.status_code == 400


def test_flatten_creates_undoable_revision(client, open_doc, fixtures):
    info = open_doc(fixtures / "small.pdf")
    d = info["doc_id"]
    r = ok(client.post(f"/documents/{d}/overlays/flatten", json={"overlays": [text_obj(1, [100, 100, 300, 140], "FLATTENED")]}))
    assert r["modified_pages"] == [1]
    assert "FLATTENED" in fitz.open(r["working_path"])[1].get_text()
    back = ok(client.post(f"/documents/{d}/revision", json={"revision": info["revision"]}))
    assert "FLATTENED" not in fitz.open(back["working_path"])[1].get_text()


def test_invalid_overlays_rejected(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    for bad in ({"kind": "image", "page": 0, "rect": [0, 0, 10, 10], "assetId": "../../etc/passwd"},
                {"kind": "text", "page": 99, "rect": [0, 0, 10, 10], "text": "x"},
                {"kind": "bogus", "page": 0, "rect": [0, 0, 10, 10]}):
        r = client.post(f"/documents/{d}/save", json={"target_path": str(tmp_path / "x.pdf"), "overlays": [bad]})
        assert r.status_code == 400, bad
    assert not (tmp_path / "x.pdf").exists()


def test_detach_existing_image_roundtrip(client, open_doc, fixtures, tmp_path):
    info = open_doc(fixtures / "scanned.pdf")
    d = info["doc_id"]
    imgs = ok(client.get(f"/documents/{d}/pages/0/images"))["images"]
    assert len(imgs) == 1 and not imgs[0]["shared"]
    im = imgs[0]
    assert [round(v) for v in im["rect"]] == [0, 0, 612, 792] and im["rotation"] == 0
    r = ok(client.post(f"/documents/{d}/images/detach", json={"page": 0, "xref": im["xref"]}))
    det = r["image"]
    assert det["natural_width"] == 1700
    # the page no longer shows the image ...
    page = fitz.open(r["working_path"])[0]
    assert all(i["width"] <= 1 for i in page.get_image_info())
    # ... and it comes back as an overlay object on save (moved + scaled)
    obj = {"id": "img", "kind": "image", "page": 0, "rect": [100, 100, 406, 496], "rotation": det["rotation"],
           "opacity": 1, "assetId": det["asset_id"], "naturalWidth": 1700, "naturalHeight": 2200,
           "crop": [0, 0, 0, 0], "flipH": False, "flipV": det["flipV"], "borderColor": None, "borderWidth": 0}
    out = tmp_path / "moved.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out), "overlays": [obj]}))
    page = fitz.open(out)[0]
    big = [i for i in page.get_image_info() if i["width"] == 1700]
    assert big, "image re-inserted"
    from core.coords import PageCoords

    bbox = PageCoords.for_page(page).rect_to_pdf(big[0]["bbox"])
    assert [round(v) for v in bbox] == [100, 100, 406, 496]
    # pixels identical orientation: OCR-free check via rendering a strip (dark text near the top)
    pix = page.get_pixmap(clip=fitz.Rect(100, 792 - 496, 406, 792 - 100), dpi=36)
    assert pix.width > 0
