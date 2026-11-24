"""Phase 4: direct text editing (verified with MuPDF, pypdf and pixel checks)."""
from __future__ import annotations

import pypdf
import pymupdf as fitz

from conftest import ok


def objects(client, d, page=0):
    return ok(client.get(f"/documents/{d}/pages/{page}/text-objects"))


def find_line(objs, needle):
    for b in objs["blocks"]:
        for ln in b["lines"]:
            if needle in ln["text"]:
                return ln
    raise AssertionError(f"{needle!r} not found")


def apply(client, d, body, accept=True, status=200):
    r = client.post(f"/documents/{d}/text/apply", json={**body, "accept_warnings": accept})
    assert r.status_code == status, r.text
    return r.json()


def page_text(path_or_info, page=0):
    path = path_or_info["working_path"] if isinstance(path_or_info, dict) else path_or_info
    return fitz.open(path)[page].get_text()


def test_text_objects_listing(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    objs = objects(client, d)
    ln = find_line(objs, "Invoice number")
    assert ln["style"]["family"] == "Helvetica" and ln["style"]["size"] == 12
    assert ln["style"]["font_status"] == "standard"
    assert abs(ln["origin"][0] - 60) < 0.01 and abs(ln["origin"][1] - (842 - 172)) < 0.01
    assert objs["scanned"] is False
    assert objects(client, open_doc(fixtures / "scanned.pdf")["doc_id"])["scanned"] is True


def test_standard_font_edit_requires_confirmation_and_keeps_position(client, open_doc, fixtures):
    info = open_doc(fixtures / "small.pdf")
    d = info["doc_id"]
    ln = find_line(objects(client, d), "Invoice number")
    body = {"page": 0, "line_ids": [ln["id"]], "new_text": "Invoice number INV-2025-0099 total 9,999.00 USD"}
    pv = ok(client.post(f"/documents/{d}/text/preview", json=body))
    rep = pv["report"]
    assert rep["font"]["plan"] == "substitute" and rep["font"]["used"] == "Liberation Sans"
    assert any(w["code"] == "font_substituted" for w in rep["warnings"])
    assert rep["verification"]["ok"] and pv["before"].startswith("data:image/png") and pv["after"]
    # without confirmation the edit is refused (font appearance may change)
    r = client.post(f"/documents/{d}/text/apply", json={**body, "accept_warnings": False})
    assert r.status_code == 409
    res = apply(client, d, body)
    txt = page_text(res)
    assert "INV-2025-0099" in txt and "INV-2024-0042" not in txt
    for other in ("The quick brown fox", "Contact: alice@example.com", "Quarterly Report - Page 1"):
        assert other in txt
    new = find_line(objects(client, d), "INV-2025")
    assert abs(new["origin"][0] - 60) < 0.05 and abs(new["origin"][1] - ln["origin"][1]) < 0.05
    assert abs(new["style"]["size"] - 12) < 0.01
    # independent reader
    assert "INV-2025-0099" in pypdf.PdfReader(res["working_path"]).pages[0].extract_text()
    # undo restores the original text
    back = ok(client.post(f"/documents/{d}/revision", json={"revision": info["revision"]}))
    assert "INV-2024-0042" in page_text(back)


def test_reuse_embedded_subset_font(client, open_doc, fixtures):
    d = open_doc(fixtures / "embedded_fonts.pdf")["doc_id"]
    ln = find_line(objects(client, d), "Edit me")
    assert ln["style"]["font_status"] == "subset"
    # every new glyph exists in the subset -> original font program is reused
    pv = ok(client.post(f"/documents/{d}/text/preview", json={"page": 0, "line_ids": [ln["id"]], "new_text": "Edit me: The total amount is 300 RUE"}))
    assert pv["report"]["font"]["plan"] == "original", pv["report"]["font"]
    assert pv["report"]["level"] == "safe"
    res = apply(client, d, {"page": 0, "line_ids": [ln["id"]], "new_text": "Edit me: The total amount is 300 RUE"}, accept=False)
    assert "300 RUE" in page_text(res)
    # a glyph missing from the subset -> the installed font with the same name is used
    ln2 = find_line(objects(client, d), "300 RUE")
    pv2 = ok(client.post(f"/documents/{d}/text/preview", json={"page": 0, "line_ids": [ln2["id"]], "new_text": "Total: 450 SEK"}))
    assert pv2["report"]["font"]["plan"] == "local"
    assert "subset does not contain" in pv2["report"]["font"]["reason"]


def test_thai_edit_shaping_and_extraction(client, open_doc, fixtures):
    d = open_doc(fixtures / "thai.pdf")["doc_id"]
    ln = find_line(objects(client, d), "ราคาสินค้า")
    res = apply(client, d, {"page": 0, "line_ids": [ln["id"]], "new_text": "ราคาสินค้า 2,750 บาท น้ำปั้น"})
    txt = page_text(res)
    assert "2,750 บาท น้ำปั้น" in txt and "1,500" not in txt
    assert "สวัสดีครับ" in txt
    assert fitz.open(res["working_path"])[0].search_for("น้ำปั้น")


def test_background_is_preserved_not_covered(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    ln = find_line(objects(client, d), "Quarterly Report")
    res = apply(client, d, {"page": 0, "line_ids": [ln["id"]], "new_text": "Annual Report"})
    page = fitz.open(res["working_path"])[0]
    assert "Annual Report" in page.get_text()
    # the light blue header rectangle is still filled where the old glyphs were
    fills = [dr for dr in page.get_drawings() if dr.get("fill")]
    assert any(abs(dr["fill"][0] - 0.9) < 0.01 for dr in fills)
    pix = page.get_pixmap(clip=fitz.Rect(300, 70, 301, 71))  # where "Page 1" used to be
    r, g, b = pix.pixel(0, 0)
    assert (r, g, b) != (255, 255, 255) and b > r  # light blue, not a white box


def test_delete_and_move_text(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    ln = find_line(objects(client, d), "The quick brown fox")
    res = apply(client, d, {"page": 0, "line_ids": [ln["id"]], "new_text": ""})
    txt = page_text(res)
    assert "quick brown" not in txt and "Invoice number" in txt
    ln2 = find_line(objects(client, d), "Second paragraph")
    apply(client, d, {"page": 0, "line_ids": [ln2["id"]], "new_text": ln2["text"], "offset": [100, -50]})
    moved = find_line(objects(client, d), "Second paragraph")
    assert abs(moved["origin"][0] - (ln2["origin"][0] + 100)) < 0.1
    assert abs(moved["origin"][1] - (ln2["origin"][1] - 50)) < 0.1


def test_paragraph_reflow_in_box(client, open_doc, tmp_path):
    doc = fitz.open()
    p = doc.new_page()
    p.insert_textbox(fitz.Rect(72, 72, 300, 200), "This paragraph has several lines of text that wrap inside a box.", fontsize=12)
    src = tmp_path / "para.pdf"
    doc.save(src)
    d = open_doc(src)["doc_id"]
    objs = objects(client, d)
    block = objs["blocks"][0]
    assert len(block["lines"]) >= 2
    new = "Replaced paragraph with a considerably longer sentence that must wrap over several lines inside the same width."
    res = apply(client, d, {"page": 0, "line_ids": [ln["id"] for ln in block["lines"]], "new_text": new})
    page = fitz.open(res["working_path"])[0]
    lines = [ln for b in page.get_text("dict")["blocks"] for ln in b.get("lines", [])]
    assert len(lines) >= 3
    assert all(ln["bbox"][2] <= 300 + 2 for ln in lines)  # stays within the box width
    assert "considerably longer" in page.get_text().replace("\n", " ")


def test_safety_detection(client, open_doc, tmp_path):
    # overlapping lines -> collateral warning
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 100), "AAAA BBBB", fontsize=20)
    p.insert_text((80, 104), "OVERLAP", fontsize=20)
    src = tmp_path / "ov.pdf"
    doc.save(src)
    d = open_doc(src)["doc_id"]
    objs = objects(client, d)
    a = find_line(objs, "AAAA")
    pv = ok(client.post(f"/documents/{d}/text/preview", json={"page": 0, "line_ids": [a["id"]], "new_text": "CCCC"}))
    assert any(w["code"] == "collateral" for w in pv["report"]["warnings"])

    # invisible OCR-like text -> warning
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 100), "hidden layer", fontsize=12, render_mode=3)
    src2 = tmp_path / "inv.pdf"
    doc.save(src2)
    d2 = open_doc(src2)["doc_id"]
    ln = find_line(objects(client, d2), "hidden")
    assert ln["invisible"] is True
    pv = ok(client.post(f"/documents/{d2}/text/preview", json={"page": 0, "line_ids": [ln["id"]], "new_text": "x"}))
    assert any(w["code"] == "invisible_text" for w in pv["report"]["warnings"])

    # stale selection
    r = client.post(f"/documents/{d2}/text/preview", json={"page": 0, "line_ids": ["b99l0"], "new_text": "x"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "text_not_found"


def test_overflow_warning_and_shrink(client, open_doc, tmp_path):
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 100), "Name:", fontsize=12)
    p.insert_text((200, 100), "Value", fontsize=12)
    src = tmp_path / "of.pdf"
    doc.save(src)
    d = open_doc(src)["doc_id"]
    ln = find_line(objects(client, d), "Name:")
    body = {"page": 0, "line_ids": [ln["id"]], "new_text": "A much longer label than before:"}
    pv = ok(client.post(f"/documents/{d}/text/preview", json=body))
    assert any(w["code"] == "overflow" for w in pv["report"]["warnings"])
    pv2 = ok(client.post(f"/documents/{d}/text/preview", json={**body, "fit": "shrink"}))
    assert pv2["report"]["layout"]["size"] < 12
    assert not any(w["code"] == "overflow" for w in pv2["report"]["warnings"])


def test_thai_combining_marks_are_fully_replaced(client, open_doc, fixtures):
    """Zero-width tone marks/vowels of the old text must not remain on the page."""
    d = open_doc(fixtures / "thai.pdf")["doc_id"]
    ln = find_line(objects(client, d), "ราคาสินค้า")
    new = "ราคาสินค้า 2,750 บาท"
    res = apply(client, d, {"page": 0, "line_ids": [ln["id"]], "new_text": new})
    page = fitz.open(res["working_path"])[0]
    line = next(x for x in page.get_text().splitlines() if "2,750" in x)
    assert line.count("้") == new.count("้")  # MAI THO
    assert line.count("ิ") == new.count("ิ")  # SARA I
    # every glyph of the page is accounted for by the extracted text (no orphan marks)
    chars = [c for b in page.get_text("rawdict")["blocks"] for l in b.get("lines", []) for s in l["spans"] for c in s["chars"]]
    assert sum(1 for c in chars if c["c"] == "้") == sum(t.count("้") for t in page.get_text().splitlines())
