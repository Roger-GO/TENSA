"""``tensa.__version__`` comes from the installed package metadata.

``server/pyproject.toml`` is the single source of the version. The package
reports it through ``importlib.metadata`` (with a safe fallback when tensa is
not installed), and it feeds the OpenAPI ``info.version`` and the
``tensa_version`` stamp on bundle manifests and snapshot sidecars.
"""

from __future__ import annotations

import importlib.metadata
import json
import re
from pathlib import Path

import httpx
import pytest
from packaging.version import Version

import tensa
from tensa.api.app import make_app
from tests._repo import REPO_ROOT, pyproject

pytestmark = pytest.mark.unit


def _pyproject_version() -> str:
    project = pyproject()["project"]
    assert project["name"] == "tensa"
    return str(project["version"])


def test_version_is_a_valid_pep_440_string() -> None:
    assert Version(tensa.__version__)


def test_version_is_read_from_package_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    """A different installed version changes the reported one, so nothing is
    hard-coded in the package."""
    asked: list[str] = []

    def _fake(name: str) -> str:
        asked.append(name)
        return "9.8.7"

    monkeypatch.setattr(importlib.metadata, "version", _fake)
    assert tensa._resolve_version() == "9.8.7"
    assert asked == ["tensa"]


def test_version_falls_back_when_tensa_is_not_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _missing(_name: str) -> str:
        raise importlib.metadata.PackageNotFoundError

    monkeypatch.setattr(importlib.metadata, "version", _missing)
    resolved = tensa._resolve_version()
    assert resolved == tensa._FALLBACK_VERSION
    assert Version(resolved)  # still a well-formed version string


@pytest.mark.parametrize("empty", ["", None])
def test_version_falls_back_when_metadata_has_no_version(
    monkeypatch: pytest.MonkeyPatch, empty: str | None
) -> None:
    """Broken metadata can yield an empty or missing Version field."""
    monkeypatch.setattr(importlib.metadata, "version", lambda _name: empty)
    assert tensa._resolve_version() == tensa._FALLBACK_VERSION


def test_fallback_is_a_clear_unknown_marker() -> None:
    assert tensa._FALLBACK_VERSION == "0+unknown"
    # Sorts below every real release, so it can never pass for one.
    assert Version(tensa._FALLBACK_VERSION) < Version("0.0.1")


def test_openapi_reports_the_package_version(tmp_path: Path) -> None:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    assert app.openapi()["info"]["version"] == tensa.__version__


def test_andes_version_is_read_from_package_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ANDES version comes from metadata and never imports ANDES (seconds of import time)."""
    asked: list[str] = []

    def _fake(name: str) -> str:
        asked.append(name)
        return "7.6.5"

    monkeypatch.setattr(importlib.metadata, "version", _fake)
    assert tensa.andes_version() == "7.6.5"
    assert asked == ["andes"]


def test_andes_version_is_unknown_when_andes_is_not_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _missing(_name: str) -> str:
        raise importlib.metadata.PackageNotFoundError

    monkeypatch.setattr(importlib.metadata, "version", _missing)
    assert tensa.andes_version() == "unknown"


async def _get_version(tmp_path: Path) -> httpx.Response:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        return await client.get("/api/version")


async def test_version_route_reports_the_tensa_and_andes_versions(tmp_path: Path) -> None:
    """The About dialog reads both versions here, with no session open."""
    response = await _get_version(tmp_path)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "tensa": tensa.__version__,
        "andes": importlib.metadata.version("andes"),
    }


async def test_version_route_says_unknown_when_andes_metadata_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = importlib.metadata.version

    def _no_andes(name: str) -> str:
        if name == "andes":
            raise importlib.metadata.PackageNotFoundError(name)
        return real(name)

    monkeypatch.setattr(importlib.metadata, "version", _no_andes)
    response = await _get_version(tmp_path)
    assert response.status_code == 200, response.text
    assert response.json() == {"tensa": tensa.__version__, "andes": "unknown"}


def test_version_route_is_tagged_for_the_gui_parity_ledger(tmp_path: Path) -> None:
    operation = make_app(workspace=tmp_path, static_override=tmp_path).openapi()["paths"][
        "/api/version"
    ]["get"]
    assert operation["x-tensa-gui-location"] == "about-dialog"
    assert operation["operationId"] == "getVersion"


def test_version_matches_pyproject() -> None:
    """The reported version is the one pyproject declares.

    Fails after a version bump until the package is reinstalled, because an
    editable install keeps the metadata it was installed with.
    """
    declared = _pyproject_version()
    try:
        installed = importlib.metadata.version("tensa")
    except importlib.metadata.PackageNotFoundError:
        pytest.skip("tensa is not installed")
    assert installed == declared, (
        f"installed metadata says {installed} but pyproject.toml says {declared}; "
        "re-run `pip install -e ./server`"
    )
    assert tensa.__version__ == declared


def test_web_package_and_citation_versions_match_pyproject() -> None:
    """The copies of the version outside Python stay in step with pyproject."""
    declared = _pyproject_version()

    package_json = REPO_ROOT / "web" / "package.json"
    if package_json.is_file():
        web = json.loads(package_json.read_text(encoding="utf-8"))["version"]
        assert web == declared, f"web/package.json is {web}, pyproject.toml is {declared}"

    citation = REPO_ROOT / "CITATION.cff"
    if citation.is_file():
        match = re.search(
            r'^version:\s*"?([^"\s]+)"?\s*$',
            citation.read_text(encoding="utf-8"),
            re.MULTILINE,
        )
        assert match is not None, "CITATION.cff has no version field"
        assert match.group(1) == declared, (
            f"CITATION.cff is {match.group(1)}, pyproject.toml is {declared}"
        )
