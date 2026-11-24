"""Runtime configuration for the local processing backend.

All paths are local. The backend never contacts external network services.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

APP_VERSION = "1.0.0"


def _default_assets_dir() -> Path:
    # backend/ lives next to assets/ in development; in the packaged app the
    # Electron main process passes --assets explicitly.
    return Path(__file__).resolve().parents[2] / "assets"


@dataclass
class Settings:
    sessions_root: Path
    assets_dir: Path
    token: str = ""
    max_revisions: int = 60
    # disk budget for one document's undo history (working copies)
    max_revision_bytes: int = 2 * 1024**3
    tesseract_cmd: str | None = None
    tessdata_dir: Path | None = None
    extra_font_dirs: list[Path] = field(default_factory=list)
    cache_dir: Path | None = None

    @property
    def fonts_dir(self) -> Path:
        return self.assets_dir / "fonts"

    def resolve_tesseract(self) -> tuple[str | None, Path | None]:
        """Locate a bundled (preferred) or locally installed Tesseract binary.

        Only local binaries are used; OCR never leaves the machine.
        """
        cmd = self.tesseract_cmd
        tessdata = self.tessdata_dir
        ocr_dir = self.assets_dir / "ocr"
        if not cmd:
            exe = "tesseract.exe" if sys.platform == "win32" else "tesseract"
            bundled = ocr_dir / "tesseract" / exe
            if bundled.exists():
                cmd = str(bundled)
            else:
                from shutil import which

                cmd = which("tesseract")
        if tessdata is None:
            bundled_data = ocr_dir / "tessdata"
            if (bundled_data / "eng.traineddata").exists():
                tessdata = bundled_data
        return cmd, tessdata


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        root = Path(os.environ.get("PDFED_SESSIONS_ROOT", Path.home() / ".offline-pdf-editor" / "sessions"))
        _settings = Settings(
            sessions_root=root,
            assets_dir=Path(os.environ.get("PDFED_ASSETS_DIR", _default_assets_dir())),
            token=os.environ.get("PDFED_TOKEN", ""),
        )
        _settings.sessions_root.mkdir(parents=True, exist_ok=True)
    return _settings


def set_settings(settings: Settings) -> None:
    global _settings
    settings.sessions_root.mkdir(parents=True, exist_ok=True)
    if settings.cache_dir:
        settings.cache_dir.mkdir(parents=True, exist_ok=True)
    _settings = settings
