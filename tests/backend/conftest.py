from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FIXTURES = ROOT / "tests" / "fixtures" / "generated"
sys.path.insert(0, str(BACKEND))

TOKEN = "t" * 48


def pytest_sessionstart(session):
    if not (FIXTURES / "pages500.pdf").exists():
        subprocess.run([sys.executable, str(ROOT / "tests/fixtures/make_fixtures.py"), str(FIXTURES)], check=True)


@pytest.fixture(scope="session")
def fixtures() -> Path:
    return FIXTURES


@pytest.fixture(scope="session")
def app_settings(tmp_path_factory):
    from core.config import Settings, set_settings

    base = tmp_path_factory.mktemp("userdata")
    s = Settings(sessions_root=base / "sessions", assets_dir=ROOT / "assets", token=TOKEN,
                 cache_dir=base / "cache")
    set_settings(s)
    return s


@pytest.fixture(scope="session")
def client(app_settings):
    from fastapi.testclient import TestClient

    from api.app import create_app

    app = create_app(TOKEN)
    with TestClient(app, base_url="http://127.0.0.1") as c:
        c.headers.update({"X-PDFEd-Token": TOKEN})
        yield c


@pytest.fixture
def work(tmp_path, fixtures) -> Path:
    """A writable copy of the fixtures for tests that save files."""
    d = tmp_path / "work"
    d.mkdir()
    for f in fixtures.iterdir():
        if f.is_file() and f.stat().st_size < 5_000_000:
            shutil.copy(f, d / f.name)
    return d


def ok(resp):
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def open_doc(client):
    opened = []

    def _open(path, password=None):
        info = ok(client.post("/documents/open", json={"path": str(path), "password": password}))
        opened.append(info["doc_id"])
        return info

    yield _open
    for d in opened:
        client.post(f"/documents/{d}/close", json={"delete_session": True})
