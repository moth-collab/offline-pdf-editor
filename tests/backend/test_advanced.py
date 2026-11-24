"""Phase 6: OCR, conversion, compression, security, watermark, redaction, signatures."""
from __future__ import annotations

import io
import time

import pikepdf
import pypdf
import pymupdf as fitz
from PIL import Image

from conftest import ok


def wait_job(client, job_id, timeout=180):
    t = time.time()
    while time.time() - t < timeout:
        j = ok(client.get(f"/jobs/{job_id}"))
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.2)
    raise AssertionError("job timed out")


def start(client, kind, doc_id=None, **params):
    return ok(client.post("/jobs", json={"kind": kind, "doc_id": doc_id, "params": params}))["job_id"]


# ---------------------------------------------------------------- OCR
def test_ocr_review_and_searchable_layer(client, open_doc, fixtures, tmp_path):
    info = open_doc(fixtures / "scanned.pdf")
    d = info["doc_id"]
    j = wait_job(client, start(client, "ocr", d, language="tha+eng", dpi=300))
    assert j["status"] == "done", j
    p0 = j["result"]["pages"][0]
    texts = [ln["text"] for ln in p0["lines"]]
    assert any("Invoice total 4,500 Baht" in t for t in texts)
    assert any("สวัสดีครับ" in t for t in texts)
    assert p0["mean_conf"] > 70
    # the user corrects a line during review
    pages = j["result"]["pages"]
    pages[0]["lines"][0]["text"] = "SCANNED DOCUMENT ONE"
    res = ok(client.post(f"/documents/{d}/ocr/apply", json={"job_id": j["job_id"], "pages": pages}))
    assert res["lines_written"] >= 6
    page = fitz.open(res["working_path"])[0]
    assert page.search_for("Invoice") and page.search_for("สวัสดี") and page.search_for("ONE")
    # appearance preserved: the scan is still the only image and the text is invisible
    assert len(page.get_image_info()) == 1
    assert all(t["type"] == 3 for t in page.get_texttrace())
    out = tmp_path / "searchable.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out)}))
    assert "Invoice" in pypdf.PdfReader(str(out)).pages[0].extract_text()


def test_ocr_job_can_be_cancelled(client, open_doc, fixtures):
    d = open_doc(fixtures / "pages100.pdf")["doc_id"]
    jid = start(client, "ocr", d, language="eng", dpi=300)
    time.sleep(0.5)
    ok(client.post(f"/jobs/{jid}/cancel"))
    j = wait_job(client, jid, 30)
    assert j["status"] == "cancelled"


# ---------------------------------------------------------------- compression
def test_compression_presets(client, open_doc, tmp_path):
    big = tmp_path / "big.pdf"
    doc = fitz.open()
    img = Image.effect_noise((2400, 2400), 60).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    for _ in range(2):
        p = doc.new_page()
        p.insert_image(p.rect, stream=buf.getvalue())
        p.insert_text((72, 72), "Compressed text stays", fontsize=12)
    doc.save(big)
    info = open_doc(big)
    d = info["doc_id"]
    j = wait_job(client, start(client, "compress", d, preset="recommended"))
    assert j["status"] == "done", j
    r = j["result"]
    assert r["new_size"] < r["original_size"] * 0.6, r
    res = ok(client.post(f"/documents/{d}/candidate/commit", json={"job_id": j["job_id"]}))
    assert res["file_size"] == r["new_size"]
    assert "Compressed text stays" in fitz.open(res["working_path"])[0].get_text()
    out = tmp_path / "small.pdf"
    ok(client.post(f"/documents/{d}/candidate/save-as", json={"job_id": j["job_id"], "target_path": str(out)}))
    assert out.stat().st_size == r["new_size"]
    jl = wait_job(client, start(client, "compress", d, preset="low"))
    assert jl["status"] == "done" and jl["result"]["new_size"] <= jl["result"]["original_size"]


# ---------------------------------------------------------------- conversion
def test_conversions(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    docx = tmp_path / "out.docx"
    j = wait_job(client, start(client, "convert", d, mode="docx", output_path=str(docx)))
    assert j["status"] == "done", j
    import docx as pydocx

    text = "\n".join(p.text for p in pydocx.Document(str(docx)).paragraphs)
    assert "Invoice number INV-2024-0042" in text

    xlsx = tmp_path / "out.xlsx"
    j = wait_job(client, start(client, "convert", d, mode="xlsx", output_path=str(xlsx)))
    assert j["status"] == "done", j
    from openpyxl import load_workbook

    wb = load_workbook(xlsx)
    cells = [str(c.value) for ws in wb.worksheets for row in ws.iter_rows() for c in row if c.value]
    assert any("Invoice" in c for c in cells)

    pptx = tmp_path / "out.pptx"
    j = wait_job(client, start(client, "convert", d, mode="pptx", output_path=str(pptx), editable=True))
    assert j["status"] == "done", j
    from pptx import Presentation

    prs = Presentation(str(pptx))
    assert len(prs.slides) == 3
    slide_text = " ".join(sh.text_frame.text for sh in prs.slides[0].shapes if sh.has_text_frame)
    assert "Quarterly Report" in slide_text

    imgdir = tmp_path / "imgs"
    imgdir.mkdir()
    j = wait_job(client, start(client, "convert", d, mode="jpg", output_dir=str(imgdir), dpi=72, pages=[0, 2]))
    assert j["status"] == "done", j
    files = sorted(p.name for p in imgdir.iterdir())
    assert len(files) == 2 and files[0].endswith(".jpg")
    assert Image.open(imgdir / files[0]).size == (595, 842)

    txt = tmp_path / "out.txt"
    j = wait_job(client, start(client, "convert", d, mode="text", output_path=str(txt)))
    assert "Page 3" in txt.read_text(encoding="utf-8")

    d2 = open_doc(fixtures / "scanned.pdf")["doc_id"]
    ex = tmp_path / "ex"
    ex.mkdir()
    j = wait_job(client, start(client, "convert", d2, mode="extract-images", output_dir=str(ex)))
    assert j["result"]["count"] == 2


# ---------------------------------------------------------------- security
def test_password_protection_and_removal(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    info = ok(client.post(f"/documents/{d}/security/protect", json={"user_password": "open", "owner_password": "owner",
                                                                     "permissions": {"print": True, "copy": False, "modify": False}}))
    assert info["security"]["has_user_password"]
    out = tmp_path / "p.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out)}))
    with pikepdf.open(out, password="open") as pdf:
        assert pdf.is_encrypted and not pdf.allow.extract and not pdf.allow.modify_other and pdf.allow.print_lowres
    assert pypdf.PdfReader(str(out)).decrypt("owner")
    ok(client.post(f"/documents/{d}/security/remove"))
    out2 = tmp_path / "np.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out2)}))
    assert not pypdf.PdfReader(str(out2)).is_encrypted
    r = client.post(f"/documents/{d}/security/protect", json={})
    assert r.status_code == 400


def test_restricted_document_unlock_and_remove(client, open_doc, fixtures):
    info = open_doc(fixtures / "restricted.pdf")
    d = info["doc_id"]
    assert client.post(f"/documents/{d}/security/remove").status_code == 403
    assert client.post(f"/documents/{d}/security/unlock", json={"password": "bad"}).status_code == 401
    ok(client.post(f"/documents/{d}/security/unlock", json={"password": "owner123"}))
    assert ok(client.post(f"/documents/{d}/security/remove"))["security"] is None


def test_watermark(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    r = ok(client.post(f"/documents/{d}/watermark", json={"spec": {"text": "CONFIDENTIAL ลับ", "opacity": 0.2, "rotation": 45}}))
    doc = fitz.open(r["working_path"])
    assert all("CONFIDENTIAL" in p.get_text() for p in doc)
    assert any(cfg.get("text") == "Watermark" or "Watermark" in str(cfg) for cfg in doc.layer_ui_configs())
    asset = ok(client.post("/assets/image", json={"path": str(fixtures / "logo.png")}))
    r = ok(client.post(f"/documents/{d}/watermark", json={"spec": {"asset_id": asset["asset_id"], "behind": True, "pages": [0]}}))
    assert len(fitz.open(r["working_path"])[0].get_images()) == 1


# ---------------------------------------------------------------- redaction
def test_true_redaction_removes_content(client, open_doc, fixtures, tmp_path):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    matches = ok(client.post(f"/documents/{d}/redact/search", json={"pattern": "email"}))["matches"]
    assert len(matches) == 3 and matches[0]["text"] == "alice@example.com"
    ok(client.post(f"/documents/{d}/redact/mark", json={"items": matches}))
    pend = ok(client.get(f"/documents/{d}/redact/pending"))["marks"]
    assert len(pend) == 3
    res = ok(client.post(f"/documents/{d}/redact/apply", json={"sanitize": {"metadata": True}}))
    rep = res["report"]
    assert rep["verified"] and rep["redacted_areas"] == 3 and not rep["occurs_elsewhere"]
    doc = fitz.open(res["working_path"])
    full = "".join(p.get_text() for p in doc)
    assert "alice@example.com" not in full and "Contact:" in full
    assert not doc.metadata.get("author")
    assert all(p.first_annot is None for p in doc)  # marks consumed
    # independent extraction + raw bytes (no remnants after full rewrite)
    out = tmp_path / "r.pdf"
    ok(client.post(f"/documents/{d}/save", json={"target_path": str(out)}))
    assert "alice@example.com" not in "".join(p.extract_text() for p in pypdf.PdfReader(str(out)).pages)
    with pikepdf.open(out) as pdf:
        raw = b"".join(pg.Contents.read_bytes() if isinstance(pg.obj.get("/Contents"), pikepdf.Stream) else
                       b"".join(c.read_bytes() for c in pg.obj.Contents) for pg in pdf.pages)
    assert b"alice" not in raw


def test_redact_area_over_image_removes_pixels(client, open_doc, fixtures):
    d = open_doc(fixtures / "scanned.pdf")["doc_id"]
    ok(client.post(f"/documents/{d}/annotations/add", json={"page": 0, "spec": {"type": "redact", "rect": [50, 620, 300, 650]}}))
    res = ok(client.post(f"/documents/{d}/redact/apply", json={"images": "pixels"}))
    page = fitz.open(res["working_path"])[0]
    pix = page.get_pixmap(clip=fitz.Rect(60, 792 - 645, 280, 792 - 625), dpi=36)
    # area is filled black and image pixels are blanked: no light pixels remain
    assert max(pix.samples) < 60


def test_redaction_requires_marks(client, open_doc, fixtures):
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    r = client.post(f"/documents/{d}/redact/apply", json={})
    assert r.status_code == 400 and r.json()["error"]["code"] == "nothing_to_redact"


# ---------------------------------------------------------------- signatures
def test_digital_id_sign_and_validate(client, open_doc, fixtures, tmp_path):
    pfx = tmp_path / "me.pfx"
    ok(client.post("/signatures/create-id", json={"target_path": str(pfx), "name": "Somchai Tester", "email": "s@example.com",
                                                  "organization": "Test Co", "country": "TH", "password": "secret123"}))
    d = open_doc(fixtures / "small.pdf")["doc_id"]
    target = tmp_path / "signed.pdf"
    overlay = {"id": "t", "kind": "text", "page": 0, "rect": [60, 60, 300, 90], "rotation": 0, "opacity": 1,
               "text": "Signed copy", "font": "Liberation Sans", "fontSize": 12, "color": "#000000", "bold": False,
               "italic": False, "underline": False, "strike": False, "align": "left", "lineHeight": 1.2,
               "charSpacing": 0, "background": None, "borderColor": None, "borderWidth": 0, "padding": 2}
    info = ok(client.post(f"/documents/{d}/sign", json={"pfx_path": str(pfx), "password": "secret123",
                                                        "target_path": str(target), "page": 0,
                                                        "rect": [350, 40, 560, 100], "reason": "Approved",
                                                        "location": "Bangkok", "overlays": [overlay]}))
    sig = info["signature"]
    assert sig["intact"] and sig["valid"] and not sig["trusted"] and sig["self_signed"]
    assert "Somchai Tester" in sig["signer"] and sig["coverage"] == "ENTIRE_FILE"
    assert info["has_signatures"]
    v = ok(client.get(f"/documents/{info['doc_id']}/signatures"))["signatures"]
    assert v[0]["intact"]
    assert "Signed copy" in fitz.open(str(target))[0].get_text()
    bad = client.post(f"/documents/{d}/sign", json={"pfx_path": str(pfx), "password": "wrong", "target_path": str(tmp_path / "x.pdf")})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_digital_id"
    client.post(f"/documents/{info['doc_id']}/close", json={"delete_session": True})


def test_saved_signatures(client):
    img = Image.new("RGBA", (300, 100), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    import base64

    e = ok(client.post("/signatures/saved", json={"data_base64": base64.b64encode(buf.getvalue()).decode(), "kind": "drawn"}))
    assert any(x["id"] == e["id"] for x in ok(client.get("/signatures/saved"))["signatures"])
    ok(client.post(f"/signatures/saved/{e['id']}/delete"))
    assert not any(x["id"] == e["id"] for x in ok(client.get("/signatures/saved"))["signatures"])
