"""The packaging config: the build hook, the license copy, and the metadata.

``server/hatch_build.py`` decides where the built web UI comes from for each kind
of build (wheel from the repository, sdist from the repository, wheel from an
sdist, editable install). These tests drive it directly with a temporary tree;
``tests/integration/test_packaging.py`` runs the real build backend on the result.
They read the repository files directly, so they skip when the tests run away from
a checkout or without hatchling.
"""

from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tests._repo import REPO_ROOT, SERVER_DIR, load_module, pyproject

pytestmark = pytest.mark.unit


def _hook_module() -> ModuleType:
    pytest.importorskip("hatchling")
    return load_module("tensa_hatch_build", SERVER_DIR / "hatch_build.py")


def _write(path: Path, text: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _repo(tmp_path: Path, *, built_ui: bool, packaged_ui: bool) -> Path:
    """A ``<repo>/server`` project; returns the project root the hook sees."""
    server = tmp_path / "repo" / "server"
    server.mkdir(parents=True)
    if built_ui:
        dist = tmp_path / "repo" / "web" / "dist"
        _write(dist / "index.html", "<html></html>")
        _write(dist / "favicon.svg")
        _write(dist / "assets" / "index-abc.js")
        _write(dist / "assets" / "index-abc.js.map")
    if packaged_ui:
        _write(server / "src" / "tensa" / "static" / "index.html")
    return server


def _initialize(root: Path, target: str, version: str = "standard") -> dict[str, str]:
    hook = _hook_module().UiBundleHook(
        root=str(root),
        config={},
        build_config=None,
        metadata=None,
        directory=str(root / "dist"),
        target_name=target,
    )
    build_data: dict[str, Any] = {"force_include": {}}
    hook.initialize(version, build_data)
    forced: dict[str, str] = build_data["force_include"]
    return forced


def _targets(forced: dict[str, str]) -> set[str]:
    return set(forced.values())


def test_license_copy_matches_the_repository_license() -> None:
    """``server/LICENSE`` exists so the sdist is self-contained; it must not drift."""
    top = REPO_ROOT / "LICENSE"
    if not top.is_file():
        pytest.skip("LICENSE is not next to the tests")
    assert (SERVER_DIR / "LICENSE").read_bytes() == top.read_bytes()


def test_the_package_metadata_and_build_config_stay_inside_the_server_directory() -> None:
    """An sdist unpacks to a tree with nothing next to it, so no path may leave it."""
    config = pyproject()
    license_file = config["project"]["license"]["file"]
    assert not Path(license_file).is_absolute()
    assert ".." not in Path(license_file).parts
    assert (SERVER_DIR / license_file).is_file()

    targets = config["tool"]["hatch"]["build"]["targets"]
    for name, target in targets.items():
        for source in target.get("force-include", {}):
            assert ".." not in Path(source).parts, f"{name} force-includes {source}"
    assert "hatch_build.py" in targets["sdist"]["include"]
    assert "LICENSE" in targets["sdist"]["include"]


def test_the_ui_hook_is_enabled_and_exists() -> None:
    hooks = pyproject()["tool"]["hatch"]["build"]["hooks"]
    assert "custom" in hooks
    assert "path" not in hooks["custom"], "the default path (hatch_build.py) is what ships"
    assert (SERVER_DIR / "hatch_build.py").is_file()


def test_development_status_is_beta() -> None:
    assert "Development Status :: 4 - Beta" in pyproject()["project"]["classifiers"]


def test_ui_files_are_listed_one_by_one_without_source_maps(tmp_path: Path) -> None:
    root = _repo(tmp_path, built_ui=True, packaged_ui=False)
    dist = root.parent / "web" / "dist"
    files = _hook_module().bundled_ui_files(dist, "tensa/static")
    relative = {
        Path(source).relative_to(dist).as_posix(): target for source, target in files.items()
    }
    assert relative == {
        "index.html": "tensa/static/index.html",
        "favicon.svg": "tensa/static/favicon.svg",
        "assets/index-abc.js": "tensa/static/assets/index-abc.js",
    }


def test_wheel_from_the_repository_gets_the_built_ui(tmp_path: Path) -> None:
    forced = _initialize(_repo(tmp_path, built_ui=True, packaged_ui=False), "wheel")
    assert _targets(forced) == {
        "tensa/static/index.html",
        "tensa/static/favicon.svg",
        "tensa/static/assets/index-abc.js",
    }


def test_sdist_from_the_repository_carries_the_built_ui_inside_the_package(
    tmp_path: Path,
) -> None:
    forced = _initialize(_repo(tmp_path, built_ui=True, packaged_ui=False), "sdist")
    assert _targets(forced) == {
        "src/tensa/static/index.html",
        "src/tensa/static/favicon.svg",
        "src/tensa/static/assets/index-abc.js",
    }


def test_wheel_from_an_sdist_adds_nothing_because_the_ui_is_already_in_the_package(
    tmp_path: Path,
) -> None:
    """The unpacked sdist has no ``../web/dist``; ``src/tensa/static`` ships as a package file."""
    root = _repo(tmp_path, built_ui=False, packaged_ui=True)
    assert not (root.parent / "web").exists()
    assert _initialize(root, "wheel") == {}


def test_a_build_without_any_ui_fails_loudly(tmp_path: Path) -> None:
    root = _repo(tmp_path, built_ui=False, packaged_ui=False)
    for target in ("wheel", "sdist"):
        with pytest.raises(FileNotFoundError, match="pnpm build"):
            _initialize(root, target)


def test_an_unfinished_ui_build_counts_as_missing(tmp_path: Path) -> None:
    """A ``web/dist`` without ``index.html`` (an aborted build) is not a UI."""
    root = _repo(tmp_path, built_ui=False, packaged_ui=False)
    _write(root.parent / "web" / "dist" / "assets" / "index-abc.js")
    with pytest.raises(FileNotFoundError):
        _initialize(root, "wheel")


@pytest.mark.parametrize("built_ui", [True, False])
def test_an_editable_install_never_copies_the_ui_and_never_needs_it(
    tmp_path: Path, built_ui: bool
) -> None:
    """The app serves ``../web/dist`` from the checkout, so ``pip install -e`` works
    before the UI is built, and no copy goes stale in site-packages after."""
    root = _repo(tmp_path, built_ui=built_ui, packaged_ui=False)
    assert _initialize(root, "wheel", version="editable") == {}
