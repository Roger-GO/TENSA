"""``scripts/check_dist.py`` refuses a release that is missing something.

The script runs in the publish workflow against the sdist and wheel that
``python -m build`` made. These tests feed it small archives laid out like the
real ones, then break one thing at a time. They skip when the tests run away
from a checkout.
"""

from __future__ import annotations

import io
import tarfile
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

from tests._repo import SCRIPTS_DIR, load_module

pytestmark = pytest.mark.unit


def _script() -> ModuleType:
    return load_module("check_dist", SCRIPTS_DIR / "check_dist.py")


def _metadata(version: str, name: str = "tensa") -> str:
    return f"Metadata-Version: 2.4\nName: {name}\nVersion: {version}\n\nA long description.\n"


_WHEEL_FILES = {
    "tensa/__init__.py": "",
    "tensa/static/index.html": "<html></html>",
    "tensa/static/assets/index-abc.js": "//",
    "tensa-{v}.dist-info/licenses/LICENSE": "license",
}
_SDIST_FILES = {
    "src/tensa/__init__.py": "",
    "src/tensa/static/index.html": "<html></html>",
    "src/tensa/static/assets/index-abc.js": "//",
    "LICENSE": "license",
    "hatch_build.py": "",
    "pyproject.toml": "",
}


def _wheel(
    out: Path,
    version: str = "0.5.0",
    *,
    drop: tuple[str, ...] = (),
    extra: dict[str, str] | None = None,
    name: str = "tensa",
) -> Path:
    files = {k.format(v=version): v_ for k, v_ in _WHEEL_FILES.items()}
    files[f"tensa-{version}.dist-info/METADATA"] = _metadata(version, name)
    files.update(extra or {})
    path = out / f"tensa-{version}-py3-none-any.whl"
    with zipfile.ZipFile(path, "w") as wheel:
        for member, text in files.items():
            if member not in drop:
                wheel.writestr(member, text)
    return path


def _sdist(
    out: Path,
    version: str = "0.5.0",
    *,
    drop: tuple[str, ...] = (),
    extra: dict[str, str] | None = None,
) -> Path:
    files = dict(_SDIST_FILES)
    files["PKG-INFO"] = _metadata(version)
    files.update(extra or {})
    path = out / f"tensa-{version}.tar.gz"
    with tarfile.open(path, "w:gz") as sdist:
        for member, text in files.items():
            if member in drop:
                continue
            data = text.encode("utf-8")
            info = tarfile.TarInfo(f"tensa-{version}/{member}")
            info.size = len(data)
            sdist.addfile(info, io.BytesIO(data))
    return path


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out)
    _sdist(out)
    return out


def test_a_complete_release_passes(dist: Path) -> None:
    assert _script().check(dist) == []
    assert _script().check(dist, "v0.5.0") == []
    assert _script().check(dist, "0.5.0") == []


def test_main_reports_success_and_failure(dist: Path, capsys: pytest.CaptureFixture[str]) -> None:
    script = _script()
    assert script.main([str(dist), "--tag", "v0.5.0"]) == 0
    assert "ok:" in capsys.readouterr().out
    assert script.main([str(dist), "--tag", "v0.6.0"]) == 1
    assert "v0.6.0" in capsys.readouterr().err


def test_a_tag_for_another_version_is_refused(dist: Path) -> None:
    problems = _script().check(dist, "v0.6.0")
    assert len(problems) == 1
    assert "v0.6.0" in problems[0]
    assert "0.5.0" in problems[0]


def test_a_tag_is_compared_as_a_version_not_as_text(tmp_path: Path) -> None:
    """``v0.5.0-rc.1`` and ``0.5.0rc1`` are the same release."""
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out, "0.5.0rc1")
    _sdist(out, "0.5.0rc1")
    assert _script().check(out, "v0.5.0-rc.1") == []
    assert _script().check(out, "v0.5.0") != []


def test_a_tag_that_is_not_a_version_is_refused(dist: Path) -> None:
    (problem,) = _script().check(dist, "release-final")
    assert "release-final" in problem


def test_a_wheel_and_sdist_of_different_versions_are_refused(tmp_path: Path) -> None:
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out, "0.5.0")
    _sdist(out, "0.4.0")
    assert any("0.5.0" in p and "0.4.0" in p for p in _script().check(out))


def test_missing_or_extra_archives_are_refused(tmp_path: Path, dist: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert len(_script().check(empty)) == 2

    _wheel(dist, "0.5.1")  # a second wheel
    assert any("expected one wheel" in p for p in _script().check(dist))


@pytest.mark.parametrize("missing", ["tensa/static/index.html", "tensa/static/assets/index-abc.js"])
def test_a_wheel_without_the_ui_is_refused(tmp_path: Path, missing: str) -> None:
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out, drop=(missing,))
    _sdist(out)
    (problem,) = _script().check(out)
    assert ".whl" in problem
    assert "tensa/static" in problem


@pytest.mark.parametrize(
    "missing", ["src/tensa/static/index.html", "LICENSE", "hatch_build.py", "pyproject.toml"]
)
def test_an_sdist_that_cannot_be_rebuilt_is_refused(tmp_path: Path, missing: str) -> None:
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out)
    _sdist(out, drop=(missing,))
    (problem,) = _script().check(out)
    assert missing in problem


def test_source_maps_in_either_archive_are_refused(tmp_path: Path) -> None:
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out, extra={"tensa/static/assets/index-abc.js.map": "{}"})
    _sdist(out, extra={"src/tensa/static/assets/index-abc.js.map": "{}"})
    problems = _script().check(out)
    assert len(problems) == 2
    assert all("source maps" in p and "index-abc.js.map" in p for p in problems)


def test_a_wheel_without_the_license_is_refused(tmp_path: Path) -> None:
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out, drop=("tensa-0.5.0.dist-info/licenses/LICENSE",))
    _sdist(out)
    (problem,) = _script().check(out)
    assert "license" in problem


def test_another_distribution_is_refused(tmp_path: Path) -> None:
    out = tmp_path / "dist"
    out.mkdir()
    _wheel(out, name="not-tensa")
    _sdist(out)
    (problem,) = _script().check(out)
    assert "not the tensa distribution" in problem
