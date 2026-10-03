"""The real build backend turns the repository into an sdist and a wheel that work.

The failure this pins: ``pyproject.toml`` named ``../LICENSE`` and
force-included ``../web/dist``, neither of which an sdist carries, so the
sdist built fine and the wheel built *from* it did not. Publishing builds both,
in that order, so these tests do the same: sdist from a repository layout, then
the wheel from the unpacked sdist, which has nothing next to it.

The tree is a stand-in (a stub package and a small ``web/dist``) around the real
``pyproject.toml``, build hook, and license. Hatchling runs in a subprocess
through its PEP 517 entry points, as pip and ``python -m build`` call it, so
nothing is downloaded.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

import pytest

from tests._repo import REPO_ROOT, SCRIPTS_DIR, SERVER_DIR, load_module

pytest.importorskip("hatchling")

pytestmark = pytest.mark.integration

_UI = {
    "index.html": "<!doctype html><title>stub</title>",
    "favicon.svg": "<svg/>",
    "assets/index-abc.js": "console.log('stub');\n//# sourceMappingURL=index-abc.js.map\n",
    "assets/index-abc.js.map": '{"version":3}',
}


@dataclass(frozen=True)
class Built:
    sdist: Path
    wheel: Path
    out: Path


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _repository(root: Path, *, built_ui: bool = True) -> Path:
    """Lay out ``<root>/server`` (real packaging files, stub package) and ``<root>/web``."""
    server = root / "server"
    server.mkdir(parents=True)
    for name in ("pyproject.toml", "hatch_build.py", "LICENSE", "README.md", "ANDES_VERSIONS.md"):
        if not (SERVER_DIR / name).is_file():
            pytest.skip(f"server/{name} is not next to the tests")
        shutil.copy2(SERVER_DIR / name, server / name)
    _write(server / "src" / "tensa" / "__init__.py", '"""Stand-in package."""\n')
    _write(server / "src" / "tensa" / "py.typed", "")
    # Hatchling reads the repository's .gitignore, and the sdist carries it into
    # the wheel build, so use the real one.
    if (REPO_ROOT / ".gitignore").is_file():
        shutil.copy2(REPO_ROOT / ".gitignore", root / ".gitignore")
    # The repository's own LICENSE sits next to server/, as in a checkout. Nothing
    # may rely on it: the wheel is built from an unpacked sdist, which has none.
    shutil.copy2(SERVER_DIR / "LICENSE", root / "LICENSE")
    if built_ui:
        for name, text in _UI.items():
            _write(root / "web" / "dist" / name, text)
    return server


def _backend(kind: str, project: Path, out: Path) -> subprocess.CompletedProcess[str]:
    code = (
        "import sys, hatchling.build as b; print(getattr(b, 'build_' + sys.argv[1])(sys.argv[2]))"
    )
    return subprocess.run(
        [sys.executable, "-c", code, kind, str(out)],
        cwd=project,
        capture_output=True,
        text=True,
        check=False,
    )


def _build(kind: str, project: Path, out: Path) -> Path:
    done = _backend(kind, project, out)
    assert done.returncode == 0, done.stderr
    return out / done.stdout.strip().splitlines()[-1]


def _unpack(sdist: Path, into: Path) -> Path:
    with tarfile.open(sdist, "r:gz") as archive:
        archive.extractall(into, filter="data")
    (root,) = into.iterdir()
    return root


def _names(archive: Path) -> set[str]:
    if archive.suffix == ".whl":
        with zipfile.ZipFile(archive) as wheel:
            return set(wheel.namelist())
    with tarfile.open(archive, "r:gz") as sdist:
        return {n.split("/", 1)[1] for n in sdist.getnames() if "/" in n}


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Built:
    """What publishing does: an sdist, then the wheel built from that sdist."""
    base = tmp_path_factory.mktemp("packaging")
    server = _repository(base / "repo")
    out = base / "dist"
    sdist = _build("sdist", server, out)
    # The unpacked sdist sits in a directory of its own: no ../web, no ../LICENSE.
    unpacked = _unpack(sdist, base / "unpacked")
    assert not (unpacked.parent / "web").exists()
    wheel = _build("wheel", unpacked, out)
    return Built(sdist=sdist, wheel=wheel, out=out)


def test_the_wheel_built_from_the_sdist_serves_the_ui(built: Built) -> None:
    names = _names(built.wheel)
    assert "tensa/static/index.html" in names
    assert "tensa/static/favicon.svg" in names
    assert "tensa/static/assets/index-abc.js" in names
    assert "tensa/__init__.py" in names


def test_the_sdist_carries_the_ui_the_license_and_the_hook(built: Built) -> None:
    names = _names(built.sdist)
    assert {
        "src/tensa/static/index.html",
        "src/tensa/static/assets/index-abc.js",
        "LICENSE",
        "hatch_build.py",
        "pyproject.toml",
        "README.md",
    } <= names


def test_neither_archive_ships_source_maps(built: Built) -> None:
    for archive in (built.wheel, built.sdist):
        assert not [n for n in _names(archive) if n.endswith(".map")], archive.name


def test_the_wheel_records_the_license(built: Built) -> None:
    assert any(n.endswith(".dist-info/licenses/LICENSE") for n in _names(built.wheel))


def test_the_release_checks_pass_on_what_was_built(built: Built) -> None:
    check_dist = load_module("check_dist", SCRIPTS_DIR / "check_dist.py")
    assert check_dist.check(built.out) == []


def test_a_wheel_built_straight_from_the_repository_matches(tmp_path: Path) -> None:
    """The other publishing path: pip builds a wheel from a checkout, with no sdist."""
    server = _repository(tmp_path / "repo")
    wheel = _build("wheel", server, tmp_path / "dist")
    names = _names(wheel)
    assert "tensa/static/index.html" in names
    assert "tensa/static/assets/index-abc.js" in names
    assert not [n for n in names if n.endswith(".map")]


def test_a_stray_copy_of_the_ui_in_the_source_tree_is_not_packed_twice(
    tmp_path: Path,
) -> None:
    server = _repository(tmp_path / "repo")
    _write(server / "src" / "tensa" / "static" / "index.html", "<!doctype html>stale")
    _write(server / "src" / "tensa" / "static" / "assets" / "old.js.map", "{}")
    with zipfile.ZipFile(_build("wheel", server, tmp_path / "dist")) as wheel:
        listed = wheel.namelist()
        assert listed.count("tensa/static/index.html") == 1
        assert wheel.read("tensa/static/index.html") == _UI["index.html"].encode("utf-8")
    assert not [n for n in listed if n.endswith(".map")]


@pytest.mark.parametrize("kind", ["sdist", "wheel"])
def test_building_without_the_ui_fails_instead_of_shipping_a_blank_page(
    tmp_path: Path, kind: str
) -> None:
    server = _repository(tmp_path / "repo", built_ui=False)
    done = _backend(kind, server, tmp_path / "dist")
    assert done.returncode != 0
    assert "pnpm build" in done.stderr


def test_an_editable_install_builds_before_the_ui_exists(tmp_path: Path) -> None:
    """``pip install -e ./server`` is the first thing the README tells a contributor
    to run, so it must not need ``pnpm build`` first, and it must not copy the UI
    (the app serves ``../web/dist`` from the checkout, so a copy only goes stale)."""
    pytest.importorskip("editables")
    server = _repository(tmp_path / "repo", built_ui=False)
    wheel = _build("editable", server, tmp_path / "dist")
    assert not [n for n in _names(wheel) if "static" in n]
