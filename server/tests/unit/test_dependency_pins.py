"""The version ranges in ``server/pyproject.toml`` and ``web/package.json``.

Every assertion here is a decision that editing a range can undo without any
other test noticing. The Python floors are the oldest releases past the
published advisories that reach this app (Starlette: the ``FileResponse`` range
DoS, the Windows ``StaticFiles`` UNC path, Host header and request path
handling, urlencoded form limits; python-multipart: the multipart parser
denial-of-service fixes), so a fresh install resolves to releases that
``pip-audit`` accepts. The checks are floors and exclusions, never exact
ranges, so a routine bump of a cap or a floor does not need an edit here. The
tests read the repository files directly, so they skip when run away from a
checkout.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from packaging.requirements import Requirement
from packaging.version import Version

from tensa.desktop import PYWEBVIEW_REQUIREMENT
from tests._repo import WEB_DIR, pyproject

pytestmark = pytest.mark.unit


def _requirements(extra: str | None = None) -> dict[str, Requirement]:
    project = pyproject()["project"]
    lines = project["dependencies"] if extra is None else project["optional-dependencies"][extra]
    parsed = (Requirement(line) for line in lines)
    return {r.name.lower().replace("_", "-"): r for r in parsed}


def _floor(requirement: Requirement) -> Version:
    """The lowest version the requirement admits (its ``>=`` or ``==`` bound)."""
    bounds = [
        Version(s.version) for s in requirement.specifier if s.operator in {">=", "==", "~=", ">"}
    ]
    assert bounds, f"{requirement} has no lower bound"
    return max(bounds)


# name -> (lowest acceptable floor, why).
_RUNTIME_FLOORS = {
    "starlette": (
        "1.3.1",
        "serves the UI through StaticFiles; every release below 1.3.1 has an advisory",
    ),
    # FastAPI caps Starlette below 1.0 until 0.133.0, so a lower FastAPI floor
    # would make the Starlette floor unsatisfiable on a fresh install.
    "fastapi": ("0.133", "the first release that allows Starlette 1.x"),
    "python-multipart": ("0.0.31", "parses the bundle and profile upload bodies"),
}


@pytest.mark.parametrize("name", sorted(_RUNTIME_FLOORS))
def test_runtime_dependency_floors_exclude_the_advisories(name: str) -> None:
    floor, why = _RUNTIME_FLOORS[name]
    declared = _floor(_requirements()[name])
    assert declared >= Version(floor), f"{name}>={declared} admits releases below {floor}: {why}"


def test_starlette_stays_below_the_next_major() -> None:
    """Starlette is semver from 1.0, so the next major is the only break to expect."""
    assert not _requirements()["starlette"].specifier.contains("2.0.0")


def test_mcp_extra_excludes_the_incompatible_major_and_the_advisories() -> None:
    """``mcp`` 2.x renamed ``FastMCP`` to ``MCPServer``, and ``tensa mcp`` imports the old name.

    With ``mcp>=1.2`` a fresh ``pip install 'tensa[mcp]'`` resolved to 2.x, where
    ``tensa mcp`` exited claiming the extra was not installed. Releases before
    1.28.1 also carry advisories.
    """
    requirement = _requirements("mcp")["mcp"]
    assert not requirement.specifier.contains("2.0.0")
    assert _floor(requirement) >= Version("1.28.1")


def test_desktop_extra_is_pywebview_from_the_release_with_settings_below_the_next_major() -> None:
    """``tensa desktop`` sets ``webview.settings["ALLOW_DOWNLOADS"]``, which pywebview 5 added
    (4.x has no ``settings``), and the app's own window code is checked against 5 and 6 only."""
    requirement = _requirements("desktop")["pywebview"]
    assert _floor(requirement) >= Version("5")
    assert not requirement.specifier.contains("7.0.0")
    # Nothing but pywebview: the toolkit on Linux is the user's choice (GTK or Qt).
    assert set(_requirements("desktop")) == {"pywebview"}


def test_the_hint_for_an_install_without_the_desktop_extra_asks_for_the_same_pywebview() -> None:
    """``tensa desktop`` names pywebview itself when the installed tensa has no ``desktop``
    extra, and the range it names is the extra's."""
    named = Requirement(PYWEBVIEW_REQUIREMENT)
    assert named.name == "pywebview"
    assert named.specifier == _requirements("desktop")["pywebview"].specifier


def _package_json() -> dict[str, Any]:
    path = WEB_DIR / "package.json"
    if not path.is_file():
        pytest.skip("web/package.json is not next to the tests")
    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


@pytest.mark.parametrize("name", ["tailwindcss", "@tailwindcss/vite"])
def test_tailwind_is_not_pinned_to_a_prerelease(name: str) -> None:
    specifier = _package_json()["devDependencies"][name]
    match = re.fullmatch(r"\^(\d+)\.(\d+)\.(\d+)", specifier)
    assert match, f"{name} is {specifier!r}: expected a plain caret range on a stable release"
    # The CSS uses v4 features (``@theme`` tokens, ``@tailwindcss/vite``) that the betas
    # changed several times; 4.2 is what the lockfile and the UI were built against.
    assert tuple(int(part) for part in match.groups()) >= (4, 2, 0)


def test_pnpm_engine_matches_the_package_manager() -> None:
    package = _package_json()
    match = re.fullmatch(r"pnpm@(\d+)\.\d+\.\d+", package["packageManager"])
    assert match, package["packageManager"]
    assert package["engines"]["pnpm"] == f">={match.group(1)}"


def test_pnpm_build_permissions_are_declared_once() -> None:
    """pnpm 11 reads ``allowBuilds`` from ``pnpm-workspace.yaml`` only.

    A ``pnpm.onlyBuiltDependencies`` list in ``package.json`` is ignored there, so
    keeping both leaves a copy that looks authoritative and does nothing. With the
    workspace file alone, ``pnpm install --frozen-lockfile`` runs esbuild's
    install script; with ``package.json`` alone it stops with
    ``ERR_PNPM_IGNORED_BUILDS``.
    """
    yaml = pytest.importorskip("yaml")
    assert "pnpm" not in _package_json()
    workspace = WEB_DIR / "pnpm-workspace.yaml"
    assert workspace.is_file(), "web/pnpm-workspace.yaml is missing"
    settings = yaml.safe_load(workspace.read_text(encoding="utf-8"))
    assert settings["allowBuilds"]["esbuild"] is True
