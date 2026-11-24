"""Smoke test of a packaged build's bundled runtime (used by CI on Windows).

    <resources>/python/python.exe scripts/smoke-test-runtime.py <resources-dir>

Starts the bundled backend exactly like the app does (random token, ready
line on stdout), then exercises the main pipelines through its HTTP API:
open, OCR with the bundled Tesseract (Thai + English), a form filled with
Thai text, page numbers, compression, and saving. Exits non-zero on failure.
Only uses the standard library plus the bundled packages; talks to 127.0.0.1.
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def main() -> None:
    res = Path(sys.argv[1]).resolve()
    work = Path(tempfile.mkdtemp(prefix="pdfed-smoke-"))
    token = secrets.token_hex(32)
    env = {**os.environ, "PDFED_TOKEN": token, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    env["TESSDATA_PREFIX"] = str(res / "assets" / "ocr" / "tessdata")
    py = Path(sys.executable)
    proc = subprocess.Popen(
        [str(py), str(res / "backend" / "main.py"), "--sessions-root", str(work / "sessions"), "--assets", str(res / "assets"),
         "--cache-dir", str(work / "cache"), "--parent-pid", str(os.getpid())],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, encoding="utf-8")
    try:
        port = None
        t0 = time.time()
        while time.time() - t0 < 120:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    raise SystemExit(f"backend exited early:\n{proc.stderr.read()}")
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("event") == "ready":
                port = msg["port"]
                break
        if not port:
            raise SystemExit("backend did not become ready")
        base = f"http://127.0.0.1:{port}"
        # never route local calls through a system/corporate proxy
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        startup = time.time() - t0

        def call(method: str, path: str, body: dict | None = None, timeout: float = 300):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(base + path, data=data, method=method,
                                         headers={"X-PDFEd-Token": token, "Content-Type": "application/json"})
            with opener.open(req, timeout=timeout) as r:
                out = json.loads(r.read().decode())
            return out.get("data", out)

        def job(kind: str, params: dict, doc_id: str | None = None) -> dict:
            j = call("POST", "/jobs", {"kind": kind, "params": params, **({"doc_id": doc_id} if doc_id else {})})
            while True:
                s = call("GET", f"/jobs/{j['job_id']}")
                if s["status"] in ("done", "error", "cancelled"):
                    if s["status"] != "done":
                        raise SystemExit(f"{kind} job failed: {s.get('error')}")
                    return s["result"]
                time.sleep(0.5)

        # like the app: the ready line comes first, then poll /health until it answers
        for _ in range(240):
            try:
                call("GET", "/health", timeout=5)
                break
            except OSError:
                time.sleep(0.25)
        else:
            raise SystemExit("backend health check failed")
        startup = time.time() - t0
        caps = call("GET", "/capabilities")
        print("capabilities:", json.dumps(caps))
        assert caps["ocr"]["available"] and caps["ocr"]["bundled"], "bundled Tesseract not found"
        assert {"tha", "eng"} <= set(caps["ocr"]["languages"]), caps

        # a scanned page with Thai and English text, rendered by the bundled engine
        import pymupdf as fitz

        src = fitz.open()
        page = src.new_page(width=595, height=842)
        font = str(res / "assets" / "fonts" / "Sarabun-Regular.ttf")
        page.insert_font(fontname="sar", fontfile=font)
        page.insert_text((60, 120), "Invoice 2026", fontname="sar", fontsize=28)
        page.insert_text((60, 180), "ใบแจ้งหนี้", fontname="sar", fontsize=28)
        pix = page.get_pixmap(dpi=200)
        scan = fitz.open()
        sp = scan.new_page(width=595, height=842)
        sp.insert_image(sp.rect, stream=pix.tobytes("png"))
        scan_path = work / "scan.pdf"
        scan.save(scan_path)

        info = call("POST", "/documents/open", {"path": str(scan_path)})
        doc = info["doc_id"]
        ocr = job("ocr", {"language": "tha+eng", "dpi": 300}, doc)
        text = " ".join(p["text"] for p in ocr["pages"])
        print("ocr:", text.replace("\n", " ")[:200])
        assert "Invoice" in text and "ใบแจ้ง" in text.replace(" ", ""), text

        # forms with Thai, page numbers, compression, save
        call("POST", f"/documents/{doc}/forms/create", {"page": 0, "type": "text", "rect": [60, 500, 400, 524], "name": "name"})
        call("POST", f"/documents/{doc}/forms/fill", {"values": {"name": "สมชาย ใจดี"}})
        call("POST", f"/documents/{doc}/header-footer", {"bottom-center": "หน้า {page} จาก {total}", "thai_digits": True})
        out = work / "result.pdf"
        call("POST", f"/documents/{doc}/save", {"target_path": str(out)})
        check = fitz.open(str(out))
        t = check[0].get_text()
        assert "สมชาย ใจดี" in t or "สมชาย" in t, t
        assert "หน้า ๑ จาก ๑" in t, t
        comp = job("compress", {"preset": "recommended"}, doc)
        print("compress:", {k: comp[k] for k in ("original_size", "new_size") if k in comp})
        print(f"OK – backend ready in {startup:.1f}s, all pipelines work")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
