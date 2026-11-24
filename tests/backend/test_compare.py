"""Document comparison (word level, Thai aware)."""
from __future__ import annotations

import pymupdf as fitz

from conftest import ok


def _make(path, lines):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    font = str(__import__("pathlib").Path(__file__).resolve().parents[2] / "assets/fonts/Sarabun-Regular.ttf")
    page.insert_font(fontname="sar", fontfile=font)
    for i, line in enumerate(lines):
        page.insert_text((60, 100 + 24 * i), line, fontname="sar", fontsize=12)
    doc.save(path)


def test_compare_finds_word_changes_including_thai(client, open_doc, tmp_path):
    old = tmp_path / "contract_v1.pdf"
    new = tmp_path / "contract_v2.pdf"
    _make(old, ["The rent is 15,000 baht per month.", "ผู้เช่าต้องชำระค่าเช่าภายในวันที่ห้าของทุกเดือน", "This line stays the same."])
    _make(new, ["The rent is 18,000 baht per month.", "ผู้เช่าต้องชำระค่าเช่าภายในวันที่สิบของทุกเดือน", "This line stays the same.", "A new clause was added."])
    a = open_doc(old)["doc_id"]
    info = ok(client.post("/compare", json={"old_doc_id": a, "new_path": str(new)}))
    res = info["comparison"]
    kinds = [(c["kind"], c["old"], c["new"]) for c in res["changes"]]
    assert ("replace", "15,000", "18,000") in kinds
    # Thai is compared word by word: only the changed word is reported
    thai = [k for k in kinds if "ห้า" in k[1]]
    assert thai and thai[0][2] == "สิบ" and len(thai[0][1]) <= 4
    assert any(k[0] == "insert" and "new clause" in k[2] for k in kinds)
    assert not any("stays" in (k[1] + k[2]) for k in kinds)
    # the side-by-side comparison opens as a new untitled document
    assert info["page_count"] == 1 and info["saved_revision"] is None
    assert info["display_name"].startswith("contract_v1")
    client.post(f"/documents/{info['doc_id']}/close", json={"delete_session": True})


def test_compare_identical(client, open_doc, fixtures):
    a = open_doc(fixtures / "small.pdf")["doc_id"]
    info = ok(client.post("/compare", json={"old_doc_id": a, "new_path": str(fixtures / "small.pdf")}))
    assert info["comparison"]["stats"]["identical_text"] is True
    client.post(f"/documents/{info['doc_id']}/close", json={"delete_session": True})
