"""Font discovery, matching and PDF font analysis.

* Discovers fonts from the bundled ``assets/fonts`` directory and the local
  operating system font folders (no network).
* Matches PDF font names (``ABCDEF+Arial-BoldMT``) to local fonts, including
  metric-compatible substitutes, and reports when appearance may change.
* Analyses fonts used in a PDF page: embedded / subset / standard / missing /
  unsupported (Type3).
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

import pymupdf as fitz
from fontTools.ttLib import TTCollection, TTFont

from core.config import get_settings

FONT_EXTS = {".ttf", ".otf", ".ttc", ".otc"}

SCRIPT_PROBES = {
    "latin": [0x41, 0x61],
    "thai": [0x0E01, 0x0E48],
    "cyrillic": [0x0414],
    "greek": [0x03A9],
    "arabic": [0x0627],
    "hebrew": [0x05D0],
    "devanagari": [0x0915],
    "cjk": [0x4E00],
    "hangul": [0xAC00],
    "kana": [0x3042],
}

# Metric compatible / visually close substitutes (bundled fonts first).
ALIASES: dict[str, list[str]] = {
    "helvetica": ["Arial", "Liberation Sans", "Noto Sans"],
    "arial": ["Arial", "Liberation Sans", "Noto Sans"],
    "arialmt": ["Arial", "Liberation Sans"],
    "arialnarrow": ["Arial Narrow", "Liberation Sans Narrow", "Liberation Sans"],
    "times": ["Times New Roman", "Liberation Serif", "Noto Serif"],
    "timesroman": ["Times New Roman", "Liberation Serif"],
    "timesnewroman": ["Times New Roman", "Liberation Serif"],
    "timesnewromanps": ["Times New Roman", "Liberation Serif"],
    "courier": ["Courier New", "Liberation Mono"],
    "couriernew": ["Courier New", "Liberation Mono"],
    "calibri": ["Calibri", "Carlito", "Liberation Sans"],
    "cambria": ["Cambria", "Caladea", "Liberation Serif"],
    "verdana": ["Verdana", "DejaVu Sans", "Noto Sans"],
    "tahoma": ["Tahoma", "Noto Sans", "Noto Sans Thai"],
    "segoeui": ["Segoe UI", "Noto Sans"],
    "georgia": ["Georgia", "Noto Serif"],
    "symbol": ["Symbol"],
    # Thai
    "angsananew": ["Angsana New", "AngsanaUPC", "Sarabun", "Noto Serif Thai"],
    "angsanaupc": ["AngsanaUPC", "Angsana New", "Sarabun"],
    "cordianew": ["Cordia New", "CordiaUPC", "Sarabun", "Noto Sans Thai"],
    "cordiaupc": ["CordiaUPC", "Cordia New", "Sarabun"],
    "browallianew": ["Browallia New", "Sarabun", "Noto Sans Thai"],
    "thsarabunnew": ["TH Sarabun New", "TH SarabunPSK", "Sarabun"],
    "thsarabunpsk": ["TH SarabunPSK", "TH Sarabun New", "Sarabun"],
    "leelawadee": ["Leelawadee UI", "Leelawadee", "Noto Sans Thai"],
    "leelawadeeui": ["Leelawadee UI", "Leelawadee", "Noto Sans Thai"],
}

BASE14 = {
    "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
    "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
    "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
    "Symbol", "ZapfDingbats",
}

SCRIPT_DEFAULTS = {
    "thai": ["Sarabun", "Noto Sans Thai", "Leelawadee UI", "Tahoma", "Noto Serif Thai", "Garuda", "Loma"],
    "latin": ["Noto Sans", "Liberation Sans", "Arial", "DejaVu Sans"],
    "cyrillic": ["Noto Sans", "Arial", "DejaVu Sans"],
    "greek": ["Noto Sans", "Arial", "DejaVu Sans"],
    "cjk": ["Noto Sans CJK SC", "Microsoft YaHei", "SimSun", "MS Gothic"],
    "arabic": ["Noto Sans Arabic", "Arial", "Segoe UI"],
    "hebrew": ["Noto Sans Hebrew", "Arial"],
    "devanagari": ["Noto Sans Devanagari", "Mangal", "Nirmala UI"],
}


@dataclass
class FontFace:
    path: str
    index: int
    family: str
    subfamily: str
    full_name: str
    postscript: str
    weight: int
    italic: bool
    is_cff: bool
    scripts: list[str] = field(default_factory=list)
    bundled: bool = False

    @property
    def id(self) -> str:
        return f"{self.path}#{self.index}"

    @property
    def bold(self) -> bool:
        return self.weight >= 600

    def to_public(self) -> dict:
        return {
            "id": self.id,
            "family": self.family,
            "style": self.subfamily,
            "full_name": self.full_name,
            "postscript": self.postscript,
            "bold": self.bold,
            "italic": self.italic,
            "scripts": self.scripts,
            "bundled": self.bundled,
        }


def norm(name: str) -> str:
    """Normalise a font family name for comparisons."""
    name = re.sub(r"^[A-Z]{6}\+", "", name or "")
    name = unicodedata.normalize("NFKD", name)
    return re.sub(r"[^a-z0-9]", "", name.lower())


STYLE_TOKENS = re.compile(
    r"[-,_ ]?(bold|bd|black|heavy|semibold|demibold|medium|light|thin|italic|it|oblique|regular|roman|book|"
    r"mt|ps|psmt|condensed|narrow)$",
    re.IGNORECASE,
)


def split_pdf_font_name(name: str) -> tuple[str, bool, bool, bool]:
    """'ABCDEF+Arial-BoldItalicMT' -> ('Arial', bold, italic, subset)."""
    subset = bool(re.match(r"^[A-Z]{6}\+", name or ""))
    base = re.sub(r"^[A-Z]{6}\+", "", name or "")
    low = base.lower()
    bold = any(t in low for t in ("bold", "black", "heavy", "semibold", "demi")) or low.endswith(",bd")
    italic = any(t in low for t in ("italic", "oblique")) or bool(re.search(r"[-,]it$", low))
    fam = base.split("-")[0].split(",")[0]
    prev = None
    while prev != fam:
        prev = fam
        fam = STYLE_TOKENS.sub("", fam)
    fam = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", fam).strip() or base
    return fam, bold, italic, subset


def _system_font_dirs() -> list[Path]:
    dirs: list[Path] = []
    if sys.platform == "win32":
        windir = os.environ.get("WINDIR", r"C:\Windows")
        dirs.append(Path(windir) / "Fonts")
        local = os.environ.get("LOCALAPPDATA")
        if local:
            dirs.append(Path(local) / "Microsoft" / "Windows" / "Fonts")
    elif sys.platform == "darwin":
        dirs += [Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library/Fonts"]
    else:
        dirs += [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts",
                 Path.home() / ".local/share/fonts"]
    return dirs


def _read_name(tt: TTFont, *ids: int) -> str:
    name = tt["name"]
    for nid in ids:
        rec = name.getName(nid, 3, 1, 0x409) or name.getName(nid, 1, 0, 0) or name.getDebugName(nid)
        if rec:
            return str(rec)
    return ""


def _face_from_ttfont(tt: TTFont, path: str, index: int, bundled: bool) -> FontFace | None:
    if "name" not in tt or "cmap" not in tt:
        return None
    family = _read_name(tt, 16, 1)
    sub = _read_name(tt, 17, 2) or "Regular"
    if not family:
        return None
    os2 = tt["OS/2"] if "OS/2" in tt else None
    weight = int(getattr(os2, "usWeightClass", 400) or 400)
    if "bold" in sub.lower() and weight < 600:
        weight = 700
    italic = bool(os2 and (os2.fsSelection & 1)) or "italic" in sub.lower() or "oblique" in sub.lower()
    cmap = tt.getBestCmap() or {}
    scripts = [s for s, probes in SCRIPT_PROBES.items() if all(p in cmap for p in probes)]
    return FontFace(
        path=path, index=index, family=family, subfamily=sub, full_name=_read_name(tt, 4) or family,
        postscript=_read_name(tt, 6) or family.replace(" ", ""), weight=weight, italic=italic,
        is_cff="CFF " in tt or "CFF2" in tt, scripts=scripts, bundled=bundled,
    )


def scan_font_file(path: Path, bundled: bool = False) -> list[FontFace]:
    faces: list[FontFace] = []
    try:
        if path.suffix.lower() in (".ttc", ".otc"):
            coll = TTCollection(str(path), lazy=True)
            for i, tt in enumerate(coll.fonts):
                f = _face_from_ttfont(tt, str(path), i, bundled)
                if f:
                    faces.append(f)
        else:
            tt = TTFont(str(path), lazy=True, fontNumber=0)
            f = _face_from_ttfont(tt, str(path), 0, bundled)
            if f:
                faces.append(f)
    except Exception:
        return []
    return faces


class FontIndex:
    def __init__(self) -> None:
        self.faces: list[FontFace] = []
        self._by_family: dict[str, list[FontFace]] = {}
        self._lock = threading.Lock()
        self._ready = threading.Event()

    # ------------------------------------------------------------------
    def _cache_path(self) -> Path:
        s = get_settings()
        base = s.cache_dir or s.sessions_root.parent
        base.mkdir(parents=True, exist_ok=True)
        return base / "font-index.json"

    def build(self) -> None:
        s = get_settings()
        cache_file = self._cache_path()
        try:
            cache = json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cache = {}
        new_cache: dict = {}
        faces: list[FontFace] = []
        sources: list[tuple[Path, bool]] = [(s.fonts_dir, True)] + [(d, False) for d in s.extra_font_dirs] + [
            (d, False) for d in _system_font_dirs()
        ]
        seen: set[str] = set()
        for base, bundled in sources:
            if not base.exists():
                continue
            for root, _dirs, files in os.walk(base):
                for fn in files:
                    p = Path(root) / fn
                    if p.suffix.lower() not in FONT_EXTS:
                        continue
                    key = str(p)
                    if key in seen:
                        continue
                    seen.add(key)
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    sig = f"{st.st_mtime_ns}:{st.st_size}"
                    entry = cache.get(key)
                    if entry and entry.get("sig") == sig:
                        ff = [FontFace(**d) for d in entry["faces"]]
                    else:
                        ff = scan_font_file(p, bundled)
                    for f in ff:
                        f.bundled = bundled
                    new_cache[key] = {"sig": sig, "faces": [asdict(f) for f in ff]}
                    faces.extend(ff)
        try:
            cache_file.write_text(json.dumps(new_cache), encoding="utf-8")
        except OSError:
            pass
        by_family: dict[str, list[FontFace]] = {}
        for f in faces:
            by_family.setdefault(norm(f.family), []).append(f)
            # also index by postscript base name (e.g. "ArialMT")
            ps_base = norm(f.postscript.split("-")[0])
            if ps_base and ps_base != norm(f.family):
                by_family.setdefault(ps_base, []).append(f)
        with self._lock:
            self.faces = faces
            self._by_family = by_family
        self._ready.set()

    def ensure(self) -> None:
        if not self._ready.is_set():
            with self._lock:
                pass
            if not self._ready.is_set():
                self.build()

    def build_async(self) -> None:
        threading.Thread(target=self.build, name="font-index", daemon=True).start()

    # ------------------------------------------------------------------
    def families(self) -> list[dict]:
        self.ensure()
        fams: dict[str, dict] = {}
        for f in self.faces:
            e = fams.setdefault(f.family, {"family": f.family, "styles": [], "scripts": set(), "bundled": False})
            e["styles"].append({"id": f.id, "style": f.subfamily, "bold": f.bold, "italic": f.italic})
            e["scripts"].update(f.scripts)
            e["bundled"] = e["bundled"] or f.bundled
        out = []
        for e in sorted(fams.values(), key=lambda x: x["family"].lower()):
            e["scripts"] = sorted(e["scripts"])
            out.append(e)
        return out

    def by_id(self, face_id: str) -> FontFace | None:
        self.ensure()
        for f in self.faces:
            if f.id == face_id:
                return f
        return None

    def find(self, family: str, bold: bool = False, italic: bool = False) -> FontFace | None:
        """Exact family lookup with best style match."""
        self.ensure()
        cands = self._by_family.get(norm(family))
        if not cands:
            return None
        return min(cands, key=lambda f: _style_distance(f, bold, italic))

    def find_exact_style(self, family: str, bold: bool, italic: bool) -> FontFace | None:
        f = self.find(family, bold, italic)
        if f and f.bold == bold and f.italic == italic:
            return f
        return None

    def for_script(self, script: str, bold: bool = False, italic: bool = False) -> FontFace | None:
        self.ensure()
        for fam in SCRIPT_DEFAULTS.get(script, []):
            f = self.find(fam, bold, italic)
            if f and script in f.scripts:
                return f
        for f in self.faces:
            if script in f.scripts:
                return f
        return None

    def match_pdf_font(self, pdf_name: str, bold: bool | None = None, italic: bool | None = None,
                       needs_scripts: list[str] | None = None) -> list[dict]:
        """Return ranked candidate local fonts for a PDF font name."""
        self.ensure()
        fam, nb, ni, _subset = split_pdf_font_name(pdf_name)
        bold = nb if bold is None else bold
        italic = ni if italic is None else italic
        out: list[dict] = []
        seen: set[str] = set()

        def add(face: FontFace | None, quality: str, reason: str):
            if not face or face.id in seen:
                return
            if needs_scripts and not all(s in face.scripts for s in needs_scripts):
                return
            seen.add(face.id)
            out.append({"face": face.to_public(), "quality": quality, "reason": reason})

        exact = self.find(fam, bold, italic)
        if exact:
            add(exact, "exact", f"'{exact.family}' is installed on this computer")
        for alias in ALIASES.get(norm(fam), []):
            f = self.find(alias, bold, italic)
            if f:
                q = "exact" if norm(alias) == norm(fam) else "similar"
                add(f, q, f"'{f.family}' is a {'metric-compatible' if q == 'similar' else 'matching'} substitute")
        if needs_scripts:
            for s in needs_scripts:
                add(self.for_script(s, bold, italic), "fallback", f"Default font for {s} text")
        # generic serif / sans / mono guess
        low = norm(fam)
        generic = "Liberation Mono" if "mono" in low or "courier" in low else (
            "Liberation Serif" if any(t in low for t in ("times", "serif", "roman", "garamond", "georgia", "cambria"))
            else "Liberation Sans")
        add(self.find(generic, bold, italic), "fallback", "Generic substitute")
        add(self.for_script("latin", bold, italic), "fallback", "Generic substitute")
        return out


def _style_distance(f: FontFace, bold: bool, italic: bool) -> float:
    target_w = 700 if bold else 400
    return abs(f.weight - target_w) / 100.0 + (0 if f.italic == italic else 5)


font_index = FontIndex()


# ----------------------------------------------------------------------
# PDF font analysis
# ----------------------------------------------------------------------

def analyze_page_fonts(doc: fitz.Document, page: fitz.Page) -> list[dict]:
    """Classify fonts referenced by a page."""
    out = []
    seen = set()
    for xref, ext, ftype, basefont, refname, encoding, *_rest in page.get_fonts(full=True):
        if xref in seen:
            continue
        seen.add(xref)
        fam, bold, italic, subset = split_pdf_font_name(basefont)
        embedded = ext not in ("n/a", "")
        if ftype == "Type3":
            status = "unsupported"
        elif embedded and subset:
            status = "subset"
        elif embedded:
            status = "embedded"
        elif basefont in BASE14:
            status = "standard"
        else:
            status = "missing"
        local = font_index.find(fam, bold, italic)
        out.append({
            "xref": xref,
            "name": basefont,
            "family": fam,
            "type": ftype,
            "ext": ext,
            "encoding": encoding,
            "resource": refname,
            "bold": bold,
            "italic": italic,
            "embedded": embedded,
            "subset": subset,
            "status": status,
            "local_font": local.to_public() if local else None,
        })
    return out


def script_of_char(ch: str) -> str | None:
    cp = ord(ch)
    if 0x0E00 <= cp <= 0x0E7F:
        return "thai"
    if 0x0400 <= cp <= 0x04FF:
        return "cyrillic"
    if 0x0370 <= cp <= 0x03FF:
        return "greek"
    if 0x0600 <= cp <= 0x06FF:
        return "arabic"
    if 0x0590 <= cp <= 0x05FF:
        return "hebrew"
    if 0x0900 <= cp <= 0x097F:
        return "devanagari"
    if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF:
        return "cjk"
    if 0x3040 <= cp <= 0x30FF:
        return "kana"
    if 0xAC00 <= cp <= 0xD7AF:
        return "hangul"
    if ch.isalpha():
        return "latin"
    return None


def scripts_in_text(text: str) -> list[str]:
    s = []
    for ch in text:
        sc = script_of_char(ch)
        if sc and sc not in s:
            s.append(sc)
    return s
