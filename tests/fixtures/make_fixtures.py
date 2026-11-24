"""Generate test PDF fixtures (run with the backend virtualenv).

    backend/.venv/bin/python tests/fixtures/make_fixtures.py [outdir]
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import pikepdf
import pymupdf as fitz
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "generated"

THAI_FONT_CANDIDATES = [
    Path(__file__).resolve().parents[2] / "assets/fonts/Sarabun-Regular.ttf",  # Thai + Latin
    Path(__file__).resolve().parents[2] / "assets/fonts/NotoSansThai-Regular.ttf",
    Path("/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf"),
    Path("C:/Windows/Fonts/tahoma.ttf"),
]
LATIN_TTF_CANDIDATES = [
    Path(__file__).resolve().parents[2] / "assets/fonts/LiberationSans-Regular.ttf",
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
    Path("C:/Windows/Fonts/arial.ttf"),
]


def first(paths):
    for p in paths:
        if p.exists():
            return str(p)
    raise SystemExit(f"No font found in {paths}")


def small(path: Path):
    doc = fitz.open()
    for i in range(3):
        p = doc.new_page(width=595, height=842)
        p.draw_rect(fitz.Rect(50, 60, 545, 110), color=None, fill=(0.9, 0.95, 1))
        p.insert_text((60, 92), f"Quarterly Report - Page {i + 1}", fontsize=22, fontname="helv")
        y = 150
        for line in ["The quick brown fox jumps over the lazy dog.", "Invoice number INV-2024-0042 total 1,250.00 USD",
                     "Contact: alice@example.com phone +66 2 123 4567", "Second paragraph line for editing tests."]:
            p.insert_text((60, y), line, fontsize=12, fontname="helv")
            y += 22
        p.draw_line((60, 260), (535, 260), color=(0.2, 0.2, 0.2), width=1)
        p.insert_text((60, 300), "Times body text sample", fontsize=14, fontname="tiro")
    doc.set_metadata({"title": "Small sample", "author": "Fixture Generator", "subject": "tests"})
    doc.set_toc([[1, "Page one", 1], [1, "Page two", 2], [2, "Sub section", 2], [1, "Page three", 3]])
    doc.save(path)


def many(path: Path, n: int):
    doc = fitz.open()
    for i in range(n):
        p = doc.new_page(width=612, height=792)
        p.insert_text((72, 72), f"Page {i + 1} of {n}", fontsize=18, fontname="helv")
        for k in range(30):
            p.insert_text((72, 110 + k * 20), f"Line {k + 1}: lorem ipsum dolor sit amet, consectetur {i}-{k}",
                          fontsize=10, fontname="helv")
    doc.set_toc([[1, f"Chapter {c + 1}", c * (n // 5) + 1] for c in range(5)])
    doc.save(path, garbage=3, deflate=True)


def scanned(path: Path):
    """Image-only pages (simulated scan) with Thai + English text."""
    doc = fitz.open()
    thai_font = first(THAI_FONT_CANDIDATES)
    latin_font = first(LATIN_TTF_CANDIDATES)
    for i in range(2):
        img = Image.new("L", (1700, 2200), 250)
        d = ImageDraw.Draw(img)
        f_en = ImageFont.truetype(latin_font, 56)
        f_th = ImageFont.truetype(thai_font, 60)
        d.text((150, 200), f"SCANNED DOCUMENT {i + 1}", font=f_en, fill=10)
        d.text((150, 400), "Invoice total 4,500 Baht", font=f_en, fill=20)
        d.text((150, 600), "สวัสดีครับ ภาษาไทย", font=f_th, fill=15)
        d.text((150, 800), "ใบแจ้งหนี้ เลขที่ 12345", font=f_th, fill=15)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        p = doc.new_page(width=612, height=792)
        p.insert_image(p.rect, stream=buf.getvalue())
    doc.save(path, deflate=True)


def thai(path: Path):
    font = first(THAI_FONT_CANDIDATES)
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    p.insert_font(fontname="th", fontfile=font)
    lines = ["สวัสดีครับ นี่คือเอกสารภาษาไทย", "ราคาสินค้า 1,500 บาท", "English and ไทย mixed text"]
    for i, line in enumerate(lines):
        p.insert_text((60, 100 + i * 30), line, fontsize=16, fontname="th")
    doc.save(path, garbage=3, deflate=True)


def encrypted(path: Path, src: Path):
    with pikepdf.open(src) as pdf:
        pdf.save(path, encryption=pikepdf.Encryption(user="user123", owner="owner123", R=6))


def restricted(path: Path, src: Path):
    with pikepdf.open(src) as pdf:
        pdf.save(path, encryption=pikepdf.Encryption(
            user="", owner="owner123", R=6,
            allow=pikepdf.Permissions(modify_other=False, extract=False, modify_annotation=False,
                                      modify_assembly=False, print_highres=True, print_lowres=True)))


def embedded_fonts(path: Path):
    """TrueType font embedded as a subset (as produced by Word)."""
    font = first(LATIN_TTF_CANDIDATES)
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    p.insert_font(fontname="F1", fontfile=font)
    p.insert_text((72, 100), "Embedded TrueType font sample", fontsize=18, fontname="F1")
    p.insert_text((72, 140), "Edit me: The total amount is 300 EUR", fontsize=12, fontname="F1")
    doc.subset_fonts()
    doc.save(path, garbage=3, deflate=True)


def corrupted(path: Path, src: Path):
    data = bytearray(src.read_bytes())
    idx = data.rfind(b"startxref")
    data[idx:idx + 30] = b"startxref\n999999\n%%EOF\n" + b" " * 7  # broken xref offset
    data = data.replace(b"/Type /Catalog", b"/Type /Catalog ", 1)
    path.write_bytes(bytes(data))


def boxes(path: Path):
    pdf = pikepdf.new()
    font = pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica)
    content = b"BT /F1 12 Tf 100 300 Td (MARK at 100 300) Tj ET"
    page = pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[10, 20, 610, 820], CropBox=[50, 60, 500, 700],
                              Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
                              Contents=pdf.make_stream(content))
    pdf.pages.append(pikepdf.Page(page))
    pdf.save(path)


def rotated(path: Path):
    doc = fitz.open()
    for rot in (0, 90, 180, 270):
        p = doc.new_page(width=595, height=842)
        p.insert_text((72, 100), f"Rotation {rot}", fontsize=20)
        p.set_rotation(rot)
    doc.save(path)


def with_attachment(path: Path):
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 72), "Document with attachment")
    doc.embfile_add("notes.txt", "hello attachment".encode(), filename="notes.txt", desc="Notes")
    doc.save(path)


def image_png(path: Path):
    img = Image.new("RGBA", (400, 200), (255, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((10, 10, 390, 190), fill=(30, 120, 220, 255))
    d.text((150, 90), "LOGO", fill=(255, 255, 255, 255))
    img.save(path)


def image_jpg(path: Path):
    img = Image.new("RGB", (800, 600), (240, 240, 230))
    d = ImageDraw.Draw(img)
    for i in range(0, 800, 40):
        d.line((i, 0, 800 - i, 600), fill=(i % 255, 100, 150), width=3)
    img.save(path, "JPEG", quality=90)


def form(path: Path):
    """An AcroForm made by another tool (PyMuPDF), with labels drawn on the page."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 90), "Application form", fontsize=18)
    labels = [("Full name", 130), ("Subscribe", 170), ("City", 210), ("Notes", 250)]
    for text, y in labels:
        page.insert_text((60, y), text, fontsize=11)

    def add(kind, name, rect, **kw):
        w = fitz.Widget()
        w.field_type = kind
        w.field_name = name
        w.rect = fitz.Rect(*rect)
        for k, v in kw.items():
            setattr(w, k, v)
        page.add_widget(w)

    add(fitz.PDF_WIDGET_TYPE_TEXT, "full_name", (160, 116, 420, 136), text_fontsize=11)
    add(fitz.PDF_WIDGET_TYPE_CHECKBOX, "subscribe", (160, 158, 174, 172), field_value=False)
    add(fitz.PDF_WIDGET_TYPE_COMBOBOX, "city", (160, 196, 320, 216), choice_values=["Bangkok", "Chiang Mai", "Phuket"],
        field_value="Bangkok")
    add(fitz.PDF_WIDGET_TYPE_TEXT, "notes", (160, 236, 520, 300), text_fontsize=0,
        field_flags=fitz.PDF_TX_FIELD_IS_MULTILINE)
    doc.save(path)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    small(OUT / "small.pdf")
    many(OUT / "pages100.pdf", 100)
    many(OUT / "pages500.pdf", 500)
    scanned(OUT / "scanned.pdf")
    thai(OUT / "thai.pdf")
    encrypted(OUT / "encrypted.pdf", OUT / "small.pdf")
    restricted(OUT / "restricted.pdf", OUT / "small.pdf")
    embedded_fonts(OUT / "embedded_fonts.pdf")
    corrupted(OUT / "corrupted.pdf", OUT / "small.pdf")
    boxes(OUT / "boxes.pdf")
    rotated(OUT / "rotated.pdf")
    with_attachment(OUT / "attachment.pdf")
    form(OUT / "form.pdf")
    image_png(OUT / "logo.png")
    image_jpg(OUT / "photo.jpg")
    (OUT / "not_a_pdf.pdf").write_text("hello, I am not a PDF")
    print("fixtures written to", OUT)


if __name__ == "__main__":
    main()
