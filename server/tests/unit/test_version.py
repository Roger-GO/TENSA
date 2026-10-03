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
import tomllib
from pathlib import Path

import pytest
from packaging.version import Version

import tensa
from tensa.api.app import make_app

pytestmark = pytest.mark.unit

# server/tests/unit/test_version.py -> server/ and the repository root.
_SERVER_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _SERVER_DIR.parent


def _pyproject_version() -> str:
    pyproject = _SERVER_DIR / "pyproject.toml"
    if not pyproject.is_file():
        pytest.skip("server/pyproject.toml is not next to the tests")
    project = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]
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

    package_json = _REPO_ROOT / "web" / "package.json"
    if package_json.is_file():
        web = json.loads(package_json.read_text(encoding="utf-8"))["version"]
        assert web == declared, f"web/package.json is {web}, pyproject.toml is {declared}"

    citation = _REPO_ROOT / "CITATION.cff"
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
