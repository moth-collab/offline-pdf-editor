"""Text layout engine: Thai segmentation and wrapping, shaping and embedding."""
from __future__ import annotations


def test_thai_dictionary_segmentation(app_settings):
    from services.text_layout import thai_segments

    assert thai_segments("ผู้ใหญ่น้ำปั้นสวัสดีครับ") == ["ผู้ใหญ่", "น้ำ", "ปั้น", "สวัสดี", "ครับ"]
    segs = thai_segments("ที่ต้องตัดบรรทัดอัตโนมัติเมื่อเกินความกว้างของกล่องข้อความ")
    assert "ข้อความ" in segs and "อัตโนมัติ" in segs
    # combining marks never start a segment
    import unicodedata

    assert all(unicodedata.category(s[0]) not in ("Mn", "Mc") for s in segs)


def test_thai_wrapping_breaks_between_words(app_settings):
    from services.fonts import font_index
    from services.text_layout import _wrap, make_style

    font_index.build()
    st = make_style(font_index.find("Sarabun"), 14)
    lines = _wrap("ภาษาไทยยาวมากที่ต้องตัดบรรทัดอัตโนมัติเมื่อเกินความกว้างของกล่องข้อความ", st, 200)
    assert len(lines) >= 2
    joined = "".join(lines)
    assert joined == "ภาษาไทยยาวมากที่ต้องตัดบรรทัดอัตโนมัติเมื่อเกินความกว้างของกล่องข้อความ"
    for a, b in zip(lines, lines[1:]):
        assert not (a.endswith("ข้") and b.startswith("อความ"))


def test_shaped_thai_roundtrip_extraction(app_settings, tmp_path):
    import pikepdf
    import pymupdf as fitz
    import pypdf

    from services.fonts import font_index
    from services.pdf_writer import WriterSession, box_matrix
    from services.text_layout import layout_text, make_style

    font_index.build()
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(500, 200))
    ws = WriterSession(pdf)
    text = "สวัสดีครับ น้ำ ปั้น ผู้ใหญ่ กำลัง Hello"
    st = make_style(font_index.find("Noto Sans Thai"), 16)
    ws.page(0).text_layout(layout_text(text, st, max_width=480), st, box_matrix([10, 100, 490, 190]))
    ws.commit()
    out = tmp_path / "t.pdf"
    pdf.save(out)
    assert text in fitz.open(out)[0].get_text()
    assert "Hello" in pypdf.PdfReader(str(out)).pages[0].extract_text()
