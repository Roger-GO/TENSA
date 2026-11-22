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
    # would make the Starlette floor unsatisfiable on a fresh install. The bundle
    # import's use_bundle_case and accept_version_mismatch default to true.
    "fastapi": ("0.162", "0.147 to 0.161 read a boolean form field left out as false"),
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


def test_mcp_extra_takes_both_majors_of_the_sdk_past_their_advisories() -> None:
    """``tensa mcp`` runs on ``mcp`` 2.x, where the server class is ``MCPServer``, and on
    1.x, where it is ``FastMCP``, which upstream still patches, so an environment that
    holds 1.x for another tool keeps it. Every release below 1.30.0, and 2.0 and 2.1,
    has a published advisory, and 3.x is a major nothing has been checked against.
    """
    requirement = _requirements("mcp")["mcp"]
    assert _floor(requirement) >= Version("1.30.0")
    for advised in ("2.0.1", "2.1.1"):
        assert not requirement.specifier.contains(advised), advised
    assert not requirement.specifier.contains("3.0.0")
    # Both majors, whatever their floors become.
    assert requirement.specifier.contains("1.999") and requirement.specifier.contains("2.999")


def test_dev_extra_installs_mcp_in_the_range_of_the_mcp_extra() -> None:
    """The MCP tests skip when ``mcp`` is missing, and ``[dev]`` did not bring it, so a checkout
    set up the way the contributor pages say, and CI, ran those tests as skips and never failed."""
    dev = _requirements("dev")
    assert "mcp" in dev
    assert dev["mcp"].specifier == _requirements("mcp")["mcp"].specifier


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


def test_sienna_extra_is_the_juliacall_of_the_pythoncall_the_manifest_holds() -> None:
    """Each juliacall release asks for the PythonCall of its own version exactly, and a
    Sienna worker starts juliacall offline on the PythonCall the shipped Manifest pins,
    so the extra admits that one juliacall and nothing else."""
    from tensa.engines.sienna.setup import packaged_project

    manifest = (packaged_project() / "Manifest.toml").read_text(encoding="utf-8")
    entry = re.search(r'^\[\[deps\.PythonCall\]\]\n(?:.+\n)*?version = "([^"]+)"', manifest, re.M)
    assert entry is not None, "the shipped Manifest holds no PythonCall"
    requirement = _requirements("sienna")["juliacall"]
    assert set(_requirements("sienna")) == {"juliacall"}
    assert [(s.operator, s.version) for s in requirement.specifier] == [("==", entry.group(1))]


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


def test_pnpm_build_permissions_are_declared_once_and_only_for_installed_packages() -> None:
    """pnpm 11 reads ``allowBuilds`` from ``pnpm-workspace.yaml`` only.

    A ``pnpm.onlyBuiltDependencies`` list in ``package.json`` is ignored there, so
    keeping both leaves a copy that looks authoritative and does nothing; a
    dependency whose install script is not allowed stops ``pnpm install`` with
    ``ERR_PNPM_IGNORED_BUILDS``. A permission for a package the lockfile does not
    install outlives it the same way: esbuild's stayed after Vite 8 dropped it.
    """
    yaml = pytest.importorskip("yaml")
    assert "pnpm" not in _package_json()
    workspace = WEB_DIR / "pnpm-workspace.yaml"
    lockfile = WEB_DIR / "pnpm-lock.yaml"
    assert workspace.is_file(), "web/pnpm-workspace.yaml is missing"
    assert lockfile.is_file(), "web/pnpm-lock.yaml is missing"
    settings = yaml.safe_load(workspace.read_text(encoding="utf-8"))
    # A file of comments only loads as None, and Dependabot's pnpm parser fails on it.
    assert isinstance(settings, dict), "web/pnpm-workspace.yaml must hold a mapping, even if empty"
    packages = yaml.safe_load(lockfile.read_text(encoding="utf-8"))["packages"]
    installed = {key.rsplit("@", 1)[0] for key in packages}
    for name in settings.get("allowBuilds") or {}:
        assert name in installed, f"allowBuilds names {name}, which the lockfile does not install"
