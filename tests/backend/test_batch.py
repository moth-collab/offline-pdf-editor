"""Batch processing job: many files, one action, originals untouched."""
from __future__ import annotations

import hashlib
import shutil
import time

import pikepdf
import pypdf

from conftest import ok


def _digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _run(client, params, timeout=180):
    job = ok(client.post("/jobs", json={"kind": "batch", "params": params}))
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = ok(client.get(f"/jobs/{job['job_id']}"))
        if j["status"] in ("done", "error", "cancelled"):
            client.post(f"/jobs/{job['job_id']}/dispose")
            return j
        time.sleep(0.3)
    raise AssertionError("batch job timed out")


def _inputs(fixtures, tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    for f in ("small.pdf", "pages100.pdf", "thai.pdf", "encrypted.pdf", "not_a_pdf.pdf"):
        shutil.copy(fixtures / f, src / f)
    return src


def test_batch_bates_continues_across_files_and_skips_bad_files(client, fixtures, tmp_path):
    src = _inputs(fixtures, tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    before = {p.name: _digest(p) for p in src.iterdir()}
    files = [str(src / n) for n in ("small.pdf", "pages100.pdf", "encrypted.pdf", "not_a_pdf.pdf", "thai.pdf")]
    j = _run(client, {"mode": "header-footer", "files_paths": files, "output_dir": str(out),
                      "options": {"bottom-right": "{bates}", "bates": {"prefix": "DOC-", "start": 1, "digits": 5}}})
    assert j["status"] == "done", j
    res = j["result"]
    status = {r["file"]: r["status"] for r in res["results"]}
    assert status == {"small.pdf": "ok", "pages100.pdf": "ok", "encrypted.pdf": "error", "not_a_pdf.pdf": "error", "thai.pdf": "ok"}
    assert res["ok"] == 3 and res["failed"] == 2
    # numbering continues: small.pdf has 3 pages -> pages100 starts at 4, thai at 104
    assert "DOC-00001" in pypdf.PdfReader(out / "small_numbered.pdf").pages[0].extract_text()
    assert "DOC-00004" in pypdf.PdfReader(out / "pages100_numbered.pdf").pages[0].extract_text()
    assert "DOC-00104" in pypdf.PdfReader(out / "thai_numbered.pdf").pages[0].extract_text()
    # originals untouched, nothing written next to them
    assert {p.name: _digest(p) for p in src.iterdir()} == before
    # running again never overwrites earlier results
    j2 = _run(client, {"mode": "header-footer", "files_paths": [files[0]], "output_dir": str(out),
                       "options": {"top-left": "again"}})
    assert j2["result"]["results"][0]["output"] == "small_numbered (2).pdf"


def test_batch_compress_protect_and_flatten(client, fixtures, tmp_path):
    src = _inputs(fixtures, tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    files = [str(src / "small.pdf"), str(src / "thai.pdf")]
    j = _run(client, {"mode": "compress", "files_paths": files, "output_dir": str(out), "options": {"preset": "recommended"}})
    assert j["result"]["ok"] == 2
    assert (out / "small_compressed.pdf").stat().st_size <= (src / "small.pdf").stat().st_size
    j = _run(client, {"mode": "protect", "files_paths": files, "output_dir": str(out), "options": {"user_password": "batch-pw"}})
    assert j["result"]["ok"] == 2
    r = pypdf.PdfReader(out / "thai_protected.pdf")
    assert r.is_encrypted and r.decrypt("batch-pw")
    shutil.copy(fixtures / "form.pdf", src / "form.pdf")
    j = _run(client, {"mode": "flatten", "files_paths": [str(src / "form.pdf")], "output_dir": str(out), "options": {}})
    assert j["result"]["ok"] == 1
    with pikepdf.open(out / "form_flattened.pdf") as pdf:
        assert "/AcroForm" not in pdf.Root


def test_batch_validation(client, tmp_path):
    r = client.post("/jobs", json={"kind": "batch", "params": {"mode": "nope", "files_paths": ["x"], "output_dir": str(tmp_path)}})
    job = ok(r)
    t0 = time.time()
    while True:
        j = ok(client.get(f"/jobs/{job['job_id']}"))
        if j["status"] != "running" or time.time() - t0 > 30:
            break
        time.sleep(0.2)
    assert j["status"] == "error" and "Choose what to do" in j["error"]["message"]
