"""Headers, footers, page numbers and Bates numbering."""
from __future__ import annotations

import datetime as dt

import pymupdf as fitz
import pypdf

from conftest import ok
from services.header_footer import expand, format_date


def _save(client, doc, target):
    ok(client.post(f"/documents/{doc}/save", json={"target_path": str(target)}))
    return target


def test_tokens_and_dates():
    d = dt.date(2026, 11, 23)
    assert format_date("thai", d) == "23 พฤศจิกายน 2569"
    assert format_date("thai-short", d) == "23/11/2569"
    assert format_date("iso", d) == "2026-11-23"
    s = expand("หน้า {page} จาก {total} · {file} · {bates}", page=3, total=12, date="", file="report2026",
               bates="ABC000007", thai_digits=True)
    assert s == "หน้า ๓ จาก ๑๒ · report2026 · ABC๐๐๐๐๐๗"


def test_page_numbers_thai_and_replace(client, open_doc, fixtures, tmp_path):
    doc = open_doc(fixtures / "pages100.pdf")["doc_id"]
    ok(client.post(f"/documents/{doc}/header-footer", json={
        "bottom-center": "หน้า {page} จาก {total}", "top-right": "{file}", "font": "Sarabun", "font_size": 9}))
    out = _save(client, doc, tmp_path / "numbered.pdf")
    r = pypdf.PdfReader(out)
    assert "หน้า 1 จาก 100" in r.pages[0].extract_text()
    assert "หน้า 57 จาก 100" in r.pages[56].extract_text()
    assert "pages100" in r.pages[3].extract_text()
    # position: footer near the bottom edge, header near the top (MuPDF, top-down coordinates)
    m = fitz.open(out)
    foot = m[0].search_for("100")[-1]
    head = m[0].search_for("pages100")[0]
    assert foot.y1 > m[0].rect.height - 40 and head.y0 < 40
    # applying again replaces instead of stacking
    ok(client.post(f"/documents/{doc}/header-footer", json={"bottom-right": "Folio {page}"}))
    out2 = _save(client, doc, tmp_path / "renumbered.pdf")
    t = pypdf.PdfReader(out2).pages[4].extract_text()
    assert "Folio 5" in t and "หน้า" not in t
    # remove
    ok(client.post(f"/documents/{doc}/header-footer/remove", json={}))
    assert ok(client.get(f"/documents/{doc}/header-footer"))["present"] is False
    out3 = _save(client, doc, tmp_path / "plain.pdf")
    assert "Folio 5" not in pypdf.PdfReader(out3).pages[4].extract_text()
    r = client.post(f"/documents/{doc}/header-footer/remove", json={})
    assert r.status_code == 400


def test_bates_on_selected_pages_and_rotated_page(client, open_doc, fixtures, tmp_path):
    doc = open_doc(fixtures / "rotated.pdf")["doc_id"]
    info = ok(client.get(f"/documents/{doc}"))
    n = info["page_count"]
    rotations = [p["rotation"] for p in info["pages"]]
    assert any(r % 360 for r in rotations)
    ok(client.post(f"/documents/{doc}/header-footer", json={
        "bottom-right": "{bates}", "top-left": "CONFIDENTIAL", "bates": {"prefix": "CASE-", "start": 41, "digits": 5}}))
    out = _save(client, doc, tmp_path / "bates.pdf")
    m = fitz.open(out)
    for i in range(n):
        page = m[i]
        assert f"CASE-{41 + i:05d}" in page.get_text()
        # on every page (rotated or not) the header text renders at the visible top-left
        pix = page.get_pixmap(dpi=36)
        hit = page.search_for("CONFIDENTIAL")[0] * page.rotation_matrix
        assert hit.y0 < pix.height * 72 / 36 * 0.15, (i, page.rotation, hit)
        assert hit.x0 < page.rect.width * 0.25, (i, page.rotation, hit)


def test_validation(client, open_doc, fixtures):
    doc = open_doc(fixtures / "small.pdf")["doc_id"]
    r = client.post(f"/documents/{doc}/header-footer", json={"top-left": "  "})
    assert r.status_code == 400
    r = client.post(f"/documents/{doc}/header-footer", json={"top-left": "x", "pages": [99]})
    assert r.status_code == 400
