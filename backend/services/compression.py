"""PDF compression / optimisation (local).

Presets:
  low          lossless: object deduplication, stream compression, object streams
  recommended  + images above 150 dpi resampled to 150 dpi (JPEG q≈75), font subsetting
  high         + images above 100 dpi resampled to 96 dpi (JPEG q≈55), metadata removed

The result is written to the job folder; the UI shows the exact new size and
the user then chooses to apply it to the document (new undoable revision) or
save it as a separate file. The original file is never modified here.
"""
from __future__ import annotations

from pathlib import Path

import pymupdf as fitz

from core.errors import AppError

PRESETS = {
    "low": {"images": False, "dpi_threshold": None, "dpi_target": None, "quality": None, "subset_fonts": False,
            "strip_metadata": False},
    "recommended": {"images": True, "dpi_threshold": 165, "dpi_target": 150, "quality": 75, "subset_fonts": True,
                    "strip_metadata": False},
    "high": {"images": True, "dpi_threshold": 110, "dpi_target": 96, "quality": 55, "subset_fonts": True,
             "strip_metadata": True},
}


def compress(src: str, dst: Path, preset: str, overrides: dict | None, report) -> dict:
    if preset not in PRESETS and preset != "custom":
        raise AppError("invalid_request", f"Unknown preset {preset}")
    opts = dict(PRESETS.get(preset, PRESETS["recommended"]))
    opts.update({k: v for k, v in (overrides or {}).items() if k in opts})
    doc = fitz.open(src)
    before = Path(src).stat().st_size
    report(0.1, "Optimising images…" if opts["images"] else "Optimising structure…")
    if opts["images"]:
        doc.rewrite_images(dpi_threshold=opts["dpi_threshold"], dpi_target=opts["dpi_target"],
                           quality=opts["quality"], lossy=True, lossless=True, bitonal=False, color=True, gray=True)
    if opts["subset_fonts"]:
        report(0.5, "Subsetting fonts…")
        try:
            doc.subset_fonts()
        except Exception:
            pass  # font subsetting is best effort
    if opts["strip_metadata"]:
        doc.set_metadata({})
        doc.del_xml_metadata()
    report(0.7, "Writing optimised file…")
    doc.save(str(dst), garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True, use_objstms=1)
    doc.close()
    after = dst.stat().st_size
    no_gain = False
    if after >= before and preset != "low":
        # try lossless structure optimisation only
        doc = fitz.open(src)
        doc.save(str(dst), garbage=4, deflate=True, use_objstms=1)
        doc.close()
        after = dst.stat().st_size
    if after >= before:
        # never hand back a bigger file: keep the original bytes
        import shutil

        shutil.copyfile(src, dst)
        after = before
        no_gain = True
    return {"original_size": before, "new_size": after, "saved_bytes": before - after,
            "ratio": round(after / before, 4) if before else 1, "preset": preset, "no_gain": no_gain}


def run_compress_job(params: dict, job_dir: Path, report, cancelled) -> dict:
    out = job_dir / "compressed.pdf"
    res = compress(params["source_path"], out, params.get("preset", "recommended"), params.get("options"), report)
    from services.document_manager import validate_pdf

    validate_pdf(out)
    report(1.0, "Done")
    res["candidate"] = "compressed.pdf"
    return res
