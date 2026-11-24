"""Compare two PDF documents (text changes).

Text is split into words (Thai with dictionary word segmentation, since Thai
has no spaces between words) and diffed. The result is a side-by-side PDF:
old version left with deletions highlighted red, new version right with
insertions highlighted green (changed words get both), plus a list of the
changes for the UI. Everything runs locally.
"""
from __future__ import annotations

import difflib
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import pymupdf as fitz

from core.errors import AppError
from services.text_layout import thai_segments

RED = (0.92, 0.18, 0.18)
GREEN = (0.12, 0.65, 0.25)
GAP = 24.0
HEADER = 30.0
MAX_TOKENS = 400_000


@dataclass
class Token:
    text: str  # normalised, used for matching
    raw: str
    page: int
    bbox: fitz.Rect  # displayed page coordinates (rotation applied)


def _is_thai(ch: str) -> bool:
    return "฀" <= ch <= "๿"


def tokens_of(doc: fitz.Document) -> list[Token]:
    return [t for line in lines_of(doc) for t in line]


def lines_of(doc: fitz.Document) -> list[list[Token]]:
    """Text lines (in reading order) as lists of word tokens."""
    lines: list[list[Token]] = []
    count = 0
    for page in doc:
        rm = page.rotation_matrix
        raw = page.get_text("rawdict", flags=fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP)
        for block in raw.get("blocks", []):
            for line in block.get("lines", []):
                chars = [c for span in line.get("spans", []) for c in span.get("chars", [])]
                word: list[dict] = []
                out: list[Token] = []

                def flush():
                    if not word:
                        return
                    text = "".join(c["c"] for c in word)
                    pieces = [text]
                    if any(_is_thai(ch) for ch in text):
                        pieces = _split_mixed(text)
                    pos = 0
                    for piece in pieces:
                        cs = word[pos:pos + len(piece)]
                        pos += len(piece)
                        if not piece.strip():
                            continue
                        r = fitz.Rect()
                        for c in cs:
                            r |= fitz.Rect(c["bbox"])
                        out.append(Token(unicodedata.normalize("NFC", piece).casefold(), piece, page.number, r * rm))
                    word.clear()

                for c in chars:
                    if c["c"].isspace():
                        flush()
                    else:
                        word.append(c)
                flush()
                if out:
                    lines.append(out)
                    count += len(out)
        if count > MAX_TOKENS:
            raise AppError("too_large", "The documents are too large to compare")
    return lines


def _split_mixed(text: str) -> list[str]:
    """Split a space-free run into Thai words and non-Thai pieces."""
    pieces: list[str] = []
    buf = ""
    thai = None
    for ch in text:
        t = _is_thai(ch)
        if thai is None or t == thai or unicodedata.category(ch).startswith("M"):
            buf += ch
        else:
            pieces.extend(thai_segments(buf) if thai else [buf])
            buf = ch
        if not unicodedata.category(ch).startswith("M"):
            thai = t
    if buf:
        pieces.extend(thai_segments(buf) if thai else [buf])
    return pieces


def _merge_rects(rects: list[fitz.Rect]) -> list[fitz.Rect]:
    """Join rectangles on the same line into one band."""
    out: list[fitz.Rect] = []
    for r in sorted(rects, key=lambda r: (round(r.y0), r.x0)):
        if out and abs(out[-1].y0 - r.y0) < 2 and abs(out[-1].y1 - r.y1) < 2 and r.x0 - out[-1].x1 < 12:
            out[-1] |= r
        else:
            out.append(fitz.Rect(r))
    return out


def compare(a_path: Path, b_path: Path, out_path: Path, *, a_name: str, b_name: str, a_password: str | None = None,
            b_password: str | None = None) -> dict:
    a = fitz.open(str(a_path))
    b = fitz.open(str(b_path))
    for d, pw in ((a, a_password), (b, b_password)):
        if d.needs_pass and not d.authenticate(pw or ""):
            raise AppError("password_required", "Remove the password protection before comparing")
    la, lb = lines_of(a), lines_of(b)
    # two levels: lines first (few, mostly unique: fast), then words inside changed lines
    line_sm = difflib.SequenceMatcher(None, [" ".join(t.text for t in ln) for ln in la],
                                      [" ".join(t.text for t in ln) for ln in lb], autojunk=False)
    word_ops: list[tuple[str, list[Token], list[Token]]] = []
    for op, i1, i2, j1, j2 in line_sm.get_opcodes():
        if op == "equal":
            continue
        ta = [t for ln in la[i1:i2] for t in ln]
        tb = [t for ln in lb[j1:j2] for t in ln]
        sm = difflib.SequenceMatcher(None, [t.text for t in ta], [t.text for t in tb], autojunk=False)
        for wop, x1, x2, y1, y2 in sm.get_opcodes():
            if wop != "equal":
                word_ops.append((wop, ta[x1:x2], tb[y1:y2]))
    changes: list[dict] = []
    marks_a: dict[int, list[fitz.Rect]] = {}
    marks_b: dict[int, list[fitz.Rect]] = {}
    for op, old, new in word_ops:
        for t in old:
            marks_a.setdefault(t.page, []).append(t.bbox)
        for t in new:
            marks_b.setdefault(t.page, []).append(t.bbox)
        page = new[0].page if new else (old[0].page if old else 0)
        changes.append({
            "kind": {"insert": "insert", "delete": "delete", "replace": "replace"}[op],
            "old": _join(old)[:300],
            "new": _join(new)[:300],
            "old_page": old[0].page if old else None,
            "new_page": new[0].page if new else None,
            "page": page,
        })
    n = max(a.page_count, b.page_count)
    out = fitz.open()
    archive = fitz.Archive(str(Path(__file__).resolve().parents[2] / "assets" / "fonts")) if _fonts_dir().exists() else None
    for i in range(n):
        pa = a[i] if i < a.page_count else None
        pb = b[i] if i < b.page_count else None
        wa, ha = (pa.rect.width, pa.rect.height) if pa else (0, 0)
        wb, hb = (pb.rect.width, pb.rect.height) if pb else (0, 0)
        w = max(wa, 200) + GAP + max(wb, 200)
        h = max(ha, hb) + HEADER
        page = out.new_page(width=w, height=h)
        left = fitz.Rect(0, HEADER, wa, HEADER + ha)
        right = fitz.Rect(max(wa, 200) + GAP, HEADER, max(wa, 200) + GAP + wb, HEADER + hb)
        if pa:
            page.show_pdf_page(left, a, i)
            _frame(page, left)
            for r in _merge_rects(marks_a.get(i, [])):
                page.draw_rect(r + (left.x0, left.y0, left.x0, left.y0), color=None, fill=RED, fill_opacity=0.28, overlay=True)
        if pb:
            page.show_pdf_page(right, b, i)
            _frame(page, right)
            for r in _merge_rects(marks_b.get(i, [])):
                page.draw_rect(r + (right.x0, right.y0, right.x0, right.y0), color=None, fill=GREEN, fill_opacity=0.28, overlay=True)
        _label(page, fitz.Rect(4, 6, max(wa, 200) - 4, HEADER - 4), f"{a_name} — {i + 1}" if pa else "—", RED, archive)
        _label(page, fitz.Rect(max(wa, 200) + GAP + 4, 6, w - 4, HEADER - 4), f"{b_name} — {i + 1}" if pb else "—", GREEN, archive)
    out.set_metadata({"title": f"{a_name} ↔ {b_name}", "creator": "Offline PDF Editor", "producer": "Offline PDF Editor"})
    out.save(str(out_path), garbage=3, deflate=True)
    stats = {
        "inserted": sum(len(c["new"].split()) for c in changes if c["kind"] == "insert"),
        "deleted": sum(len(c["old"].split()) for c in changes if c["kind"] == "delete"),
        "replaced": sum(1 for c in changes if c["kind"] == "replace"),
        "changes": len(changes),
        "pages_old": a.page_count,
        "pages_new": b.page_count,
        "identical_text": not changes,
    }
    return {"changes": changes[:2000], "stats": stats}


def _join(tokens: list[Token]) -> str:
    out = ""
    prev: Token | None = None
    for t in tokens:
        # Thai words of one line are written without spaces
        if prev is not None and not (_is_thai(prev.raw[-1]) and _is_thai(t.raw[0]) and prev.page == t.page):
            out += " "
        out += t.raw
        prev = t
    return out


def _fonts_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "assets" / "fonts"


def _frame(page: fitz.Page, r: fitz.Rect) -> None:
    page.draw_rect(r, color=(0.75, 0.75, 0.78), width=0.6, overlay=True)


def _label(page: fitz.Page, r: fitz.Rect, text: str, color, archive) -> None:
    css = "* {font-family: sans-serif; font-size: 10pt;}"
    if archive is not None:
        css = ("@font-face {font-family: lbl; src: url(Sarabun-Regular.ttf);} "
               "* {font-family: lbl; font-size: 10pt;}")
    hexcol = "#%02x%02x%02x" % tuple(int(c * 255) for c in color)
    html = f'<div style="color:{hexcol}">{_esc(text)}</div>'
    try:
        page.insert_htmlbox(r, html, css=css, archive=archive)
    except Exception:  # pragma: no cover - labels are cosmetic
        page.insert_text((r.x0, r.y1 - 6), text.encode("ascii", "replace").decode(), fontsize=9, color=color)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
