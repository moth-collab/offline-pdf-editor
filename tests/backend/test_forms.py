"""Interactive forms: create, fill (Thai), edit, delete, reset, flatten.

Results are verified with independent readers (pypdf, qpdf/pikepdf, MuPDF).
"""
from __future__ import annotations

import shutil

import pikepdf
import pymupdf as fitz
import pypdf

from conftest import ok

THAI = "สมชาย ใจดี ผู้จัดการ"


def _forms(client, doc):
    return ok(client.get(f"/documents/{doc}/forms"))


def _working(client, doc):
    return ok(client.get(f"/documents/{doc}"))["working_path"]


def _save(client, doc, target):
    ok(client.post(f"/documents/{doc}/save", json={"target_path": str(target)}))
    return target


def _create(client, doc, **kw):
    body = {"page": 0, **kw}
    return ok(client.post(f"/documents/{doc}/forms/create", json=body))["result"]


def test_create_all_field_types(client, open_doc, work, tmp_path):
    doc = open_doc(work / "small.pdf")["doc_id"]
    t = _create(client, doc, type="text", rect=[100, 700, 300, 722], name="name")
    _create(client, doc, type="text", rect=[100, 600, 400, 660], name="address", multiline=True)
    _create(client, doc, type="checkbox", rect=[100, 560, 114, 574], name="agree")
    r1 = _create(client, doc, type="radio", rect=[100, 530, 114, 544], name="size", export="S")
    r2 = _create(client, doc, type="radio", rect=[130, 530, 144, 544], name="size", export="L")
    _create(client, doc, type="combo", rect=[100, 490, 250, 510], name="city", options=["Bangkok", "เชียงใหม่"])
    _create(client, doc, type="list", rect=[300, 450, 450, 520], name="langs", options=["Thai", "English", "Lao"], multiselect=True)
    _create(client, doc, type="signature", rect=[300, 700, 500, 760], name="sig")
    assert t["name"] == "name" and r1["export"] == "S" and r2["export"] == "L"
    data = _forms(client, doc)
    # widget ids returned on creation stay valid in the newly written revision
    listed = {w["id"] for w in data["widgets"]}
    assert t["widget"] in listed and r1["widget"] in listed and r2["widget"] in listed
    kinds = {f["name"]: f["type"] for f in data["fields"]}
    assert kinds == {"name": "text", "address": "text", "agree": "checkbox", "size": "radio", "city": "combo",
                     "langs": "list", "sig": "signature"}
    radios = [w for w in data["widgets"] if w["field"] == "size"]
    assert sorted(w["export"] for w in radios) == ["L", "S"]
    assert all(w["page"] == 0 for w in data["widgets"])
    assert [round(v) for v in next(w for w in data["widgets"] if w["field"] == "name")["rect"]] == [100, 700, 300, 722]

    out = _save(client, doc, tmp_path / "form.pdf")
    # independent readers see the same fields
    fields = pypdf.PdfReader(out).get_fields()
    assert set(fields) >= {"name", "address", "agree", "size", "city", "langs", "sig"}
    assert fields["size"].get("/FT") == "/Btn"
    with pikepdf.open(out) as pdf:
        assert [p for p in pdf.check_pdf_syntax() if "error" in str(p).lower()] == []
    m = fitz.open(out)
    assert {w.field_name for w in m[0].widgets()} >= {"name", "agree", "size", "city", "langs", "sig"}


def test_fill_thai_text_and_flatten(client, open_doc, work, tmp_path):
    doc = open_doc(work / "small.pdf")["doc_id"]
    _create(client, doc, type="text", rect=[100, 700, 400, 724], name="name")
    _create(client, doc, type="text", rect=[100, 560, 400, 680], name="notes", multiline=True, font_size=11)
    _create(client, doc, type="checkbox", rect=[100, 520, 114, 534], name="agree")
    _create(client, doc, type="radio", rect=[100, 490, 114, 504], name="size", export="S")
    _create(client, doc, type="radio", rect=[130, 490, 144, 504], name="size", export="L")
    _create(client, doc, type="combo", rect=[100, 450, 250, 470], name="city", options=["Bangkok", "เชียงใหม่"])
    long_text = "บรรทัดแรกของหมายเหตุ ข้อความภาษาไทยที่ยาวพอที่จะต้องตัดบรรทัดอัตโนมัติ and English words"
    res = ok(client.post(f"/documents/{doc}/forms/fill", json={"values": {
        "name": THAI, "notes": long_text, "agree": True, "size": "L", "city": "เชียงใหม่"}}))
    assert sorted(res["result"]) == ["agree", "city", "name", "notes", "size"]
    vals = {f["name"]: f["value"] for f in _forms(client, doc)["fields"]}
    assert vals == {"name": THAI, "notes": long_text, "agree": True, "size": "L", "city": "เชียงใหม่"}

    out = _save(client, doc, tmp_path / "filled.pdf")
    r = pypdf.PdfReader(out)
    f = r.get_fields()
    assert f["name"]["/V"] == THAI
    assert f["agree"]["/V"] == "/Yes"
    assert f["size"]["/V"] == "/L"
    assert f["city"]["/V"] == "เชียงใหม่"
    # our appearance embeds a font that has the Thai glyphs, with a ToUnicode map
    with pikepdf.open(out) as pdf:
        w = next(a for a in pdf.pages[0].Annots if str(a.get("/T", "")) == "name")
        ap = w.AP.N
        fonts = list(ap.Resources.Font.values())
        assert fonts and all("/ToUnicode" in fo for fo in fonts)
        assert "/NeedAppearances" not in pdf.Root.AcroForm
        radios = [a for a in pdf.pages[0].Annots if "/Parent" in a and str(a.Parent.get("/T", "")) == "size"]
        assert sorted(str(a.AS) for a in radios) == ["/L", "/Off"]

    # flatten: values become page content, extractable by independent readers
    ok(client.post(f"/documents/{doc}/forms/flatten", json={}))
    assert _forms(client, doc)["fields"] == []
    flat = _save(client, doc, tmp_path / "flat.pdf")
    text = " ".join(p.extract_text() for p in pypdf.PdfReader(flat).pages)
    assert THAI.split()[0] in text and "เชียงใหม่" in text
    mtext = fitz.open(flat)[0].get_text()
    assert THAI in mtext and "English words" in mtext
    with pikepdf.open(flat) as pdf:
        assert "/AcroForm" not in pdf.Root
        assert not [a for a in pdf.pages[0].get("/Annots", []) if a.get("/Subtype") == "/Widget"]


def test_fill_third_party_form(client, open_doc, fixtures, tmp_path):
    shutil.copy(fixtures / "form.pdf", tmp_path / "form.pdf")
    doc = open_doc(tmp_path / "form.pdf")["doc_id"]
    data = _forms(client, doc)
    kinds = {f["name"]: f["type"] for f in data["fields"]}
    assert kinds == {"full_name": "text", "subscribe": "checkbox", "city": "combo", "notes": "text"}
    notes = next(f for f in data["fields"] if f["name"] == "notes")
    assert notes["multiline"] is True
    ok(client.post(f"/documents/{doc}/forms/fill", json={"values": {
        "full_name": "Ada Lovelace", "subscribe": True, "city": "Phuket", "notes": "ภาษาไทย\nsecond line"}}))
    out = _save(client, doc, tmp_path / "filled.pdf")
    f = pypdf.PdfReader(out).get_fields()
    assert f["full_name"]["/V"] == "Ada Lovelace"
    assert f["subscribe"]["/V"] not in (None, "/Off")
    assert f["city"]["/V"] == "Phuket"
    assert f["notes"]["/V"] == "ภาษาไทย\nsecond line"
    # MuPDF agrees
    vals = {w.field_name: w.field_value for w in fitz.open(out)[0].widgets()}
    assert vals["full_name"] == "Ada Lovelace" and vals["city"] == "Phuket"


def test_validation_readonly_options_and_undo(client, open_doc, work):
    doc = open_doc(work / "small.pdf")["doc_id"]
    _create(client, doc, type="text", rect=[100, 700, 300, 722], name="locked", readonly=True)
    _create(client, doc, type="combo", rect=[100, 650, 300, 670], name="pick", options=["A", "B"])
    r = client.post(f"/documents/{doc}/forms/fill", json={"values": {"locked": "x"}})
    assert r.status_code == 400 and r.json()["error"]["code"] == "field_readonly"
    r = client.post(f"/documents/{doc}/forms/fill", json={"values": {"pick": "Z"}})
    assert r.json()["error"]["code"] == "invalid_value"
    r = client.post(f"/documents/{doc}/forms/fill", json={"values": {"nope": "x"}})
    assert r.status_code == 404
    r = client.post(f"/documents/{doc}/forms/create", json={"page": 0, "type": "text", "rect": [1, 1, 50, 20], "name": "pick"})
    assert r.json()["error"]["code"] == "name_taken"
    before = ok(client.get(f"/documents/{doc}"))["revision"]
    ok(client.post(f"/documents/{doc}/forms/fill", json={"values": {"pick": "B"}}))
    ok(client.post(f"/documents/{doc}/revision", json={"revision": before}))  # undo
    assert next(f for f in _forms(client, doc)["fields"] if f["name"] == "pick")["value"] == ""


def test_update_move_rename_delete_and_reset(client, open_doc, work):
    doc = open_doc(work / "small.pdf")["doc_id"]
    _create(client, doc, type="text", rect=[100, 700, 300, 722], name="first")
    _create(client, doc, type="radio", rect=[100, 600, 114, 614], name="g", export="A")
    _create(client, doc, type="radio", rect=[130, 600, 144, 614], name="g", export="B")
    _create(client, doc, type="list", rect=[300, 500, 450, 560], name="l", options=["x", "y"])
    ok(client.post(f"/documents/{doc}/forms/update", json={"field": "first", "props": {
        "name": "given_name", "required": True, "font_size": 14, "align": "center", "tooltip": "Your first name"}}))
    w = next(w for w in _forms(client, doc)["widgets"] if w["field"] == "given_name")
    ok(client.post(f"/documents/{doc}/forms/update", json={"field": "given_name", "widget": w["id"], "props": {"rect": [120, 650, 320, 674]}}))
    data = _forms(client, doc)
    f = next(f for f in data["fields"] if f["name"] == "given_name")
    assert f["required"] and f["font_size"] == 14 and f["align"] == "center" and f["tooltip"] == "Your first name"
    assert [round(v) for v in next(w for w in data["widgets"] if w["field"] == "given_name")["rect"]] == [120, 650, 320, 674]
    ok(client.post(f"/documents/{doc}/forms/update", json={"field": "l", "props": {"options": ["x", "y", "z"]}}))
    assert next(f for f in _forms(client, doc)["fields"] if f["name"] == "l")["options"] == [["x", "x"], ["y", "y"], ["z", "z"]]

    # fill, then delete one radio button and reset everything
    ok(client.post(f"/documents/{doc}/forms/fill", json={"values": {"given_name": "Somchai", "g": "B", "l": ["z"]}}))
    b = next(w for w in _forms(client, doc)["widgets"] if w["field"] == "g" and w["export"] == "B")
    ok(client.post(f"/documents/{doc}/forms/delete", json={"widget": b["id"]}))
    data = _forms(client, doc)
    assert [w["export"] for w in data["widgets"] if w["field"] == "g"] == ["A"]
    assert next(f for f in data["fields"] if f["name"] == "g")["value"] is None
    ok(client.post(f"/documents/{doc}/forms/reset", json={}))
    vals = {f["name"]: f["value"] for f in _forms(client, doc)["fields"]}
    assert vals == {"given_name": "", "g": None, "l": []}
    # deleting the last widget removes the field
    a = next(w for w in _forms(client, doc)["widgets"] if w["field"] == "g")
    ok(client.post(f"/documents/{doc}/forms/delete", json={"widget": a["id"]}))
    assert "g" not in {f["name"] for f in _forms(client, doc)["fields"]}


def test_restricted_document_allows_filling_only(client, open_doc, fixtures, tmp_path):
    # a form restricted to "fill in forms" (no modify permission)
    src = fixtures / "form.pdf"
    dst = tmp_path / "restricted_form.pdf"
    with pikepdf.open(src) as pdf:
        pdf.save(dst, encryption=pikepdf.Encryption(user="", owner="owner-secret", R=6,
                                                      allow=pikepdf.Permissions(modify_other=False, modify_form=True,
                                                                                modify_annotation=False, modify_assembly=False)))
    info = open_doc(dst)
    doc = info["doc_id"]
    data = _forms(client, doc)
    assert data["can_fill"] is True and data["can_edit"] is False
    ok(client.post(f"/documents/{doc}/forms/fill", json={"values": {"full_name": "นายทดสอบ"}}))
    r = client.post(f"/documents/{doc}/forms/create", json={"page": 0, "type": "text", "rect": [10, 10, 100, 30]})
    assert r.status_code == 403


def test_sign_into_form_signature_field(client, open_doc, work, tmp_path):
    pfx = tmp_path / "me.pfx"
    ok(client.post("/signatures/create-id", json={"target_path": str(pfx), "name": "Form Signer", "email": "f@example.com",
                                                  "organization": "", "country": "TH", "password": "secret123"}))
    doc = open_doc(work / "small.pdf")["doc_id"]
    _create(client, doc, type="text", rect=[100, 700, 300, 722], name="name")
    _create(client, doc, type="signature", rect=[300, 80, 500, 140], name="approver")
    ok(client.post(f"/documents/{doc}/forms/fill", json={"values": {"name": "สมหญิง"}}))
    target = tmp_path / "signed.pdf"
    info = ok(client.post(f"/documents/{doc}/sign", json={"pfx_path": str(pfx), "password": "secret123",
                                                          "target_path": str(target), "field_name": "approver"}))
    sig = info["signature"]
    assert sig["intact"] and sig["valid"] and sig["field"] == "approver"
    # the form value survived and there is still exactly one signature field
    fields = pypdf.PdfReader(target).get_fields()
    assert fields["name"]["/V"] == "สมหญิง"
    assert [k for k, v in fields.items() if v.get("/FT") == "/Sig"] == ["approver"]
    listed = _forms(client, info["doc_id"])
    assert next(f for f in listed["fields"] if f["name"] == "approver")["signed"] is True
    again = client.post(f"/documents/{info['doc_id']}/sign", json={"pfx_path": str(pfx), "password": "secret123",
                                                                   "target_path": str(tmp_path / "s2.pdf"), "field_name": "approver"})
    assert again.status_code == 400 and again.json()["error"]["code"] == "already_signed"
    client.post(f"/documents/{info['doc_id']}/close", json={"delete_session": True})
