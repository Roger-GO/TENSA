"""Unit tests for ``tensa.engines.sienna.manifest``: the versions ``GET
/engines`` reports for Sienna, read from a Manifest without Julia."""

from __future__ import annotations

from pathlib import Path

import pytest

from tensa.engines.sienna import environment
from tensa.engines.sienna.manifest import sienna_versions

_MANIFEST = """\
julia_version = "1.13.4"
manifest_format = "2.0"

[[deps.PowerSystems]]
uuid = "bcd98974-b02a-5e2f-9ee0-a103f5c450dd"
version = "5.12.5"

[[deps.PowerFlows]]
uuid = "94fada2c-fd9a-4e89-82d9-ef05e19bae4a"
version = "0.16.4"
"""


def test_reads_versions_from_manifest(tmp_path: Path) -> None:
    (tmp_path / "Manifest.toml").write_text(_MANIFEST, encoding="utf-8")
    assert sienna_versions(tmp_path) == {
        "julia": "1.13.4",
        "PowerSystems": "5.12.5",
        "PowerFlows": "0.16.4",
    }


def test_missing_manifest_gives_empty(tmp_path: Path) -> None:
    assert sienna_versions(tmp_path) == {}


def test_corrupt_manifest_gives_empty(tmp_path: Path) -> None:
    (tmp_path / "Manifest.toml").write_text("not toml [[[", encoding="utf-8")
    assert sienna_versions(tmp_path) == {}


def test_absent_package_is_left_out(tmp_path: Path) -> None:
    (tmp_path / "Manifest.toml").write_text(_MANIFEST, encoding="utf-8")
    versions = sienna_versions(tmp_path)
    # A wrong implementation would write "" or "unknown" here.
    assert "PowerNetworkMatrices" not in versions
    assert "PowerSimulationsDynamics" not in versions
    assert "PowerSimulations" not in versions


def test_no_julia_version(tmp_path: Path) -> None:
    text = _MANIFEST.replace('julia_version = "1.13.4"\n', "")
    (tmp_path / "Manifest.toml").write_text(text, encoding="utf-8")
    versions = sienna_versions(tmp_path)
    assert "julia" not in versions
    assert versions["PowerSystems"] == "5.12.5"


def test_default_project_is_environments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "Manifest.toml").write_text(_MANIFEST, encoding="utf-8")
    monkeypatch.setattr(environment, "sienna_project", lambda: tmp_path)
    assert sienna_versions()["PowerFlows"] == "0.16.4"


def test_deps_entry_not_a_list(tmp_path: Path) -> None:
    text = _MANIFEST.replace("[[deps.PowerSystems]]", "[deps.PowerSystems]")
    (tmp_path / "Manifest.toml").write_text(text, encoding="utf-8")
    versions = sienna_versions(tmp_path)
    assert "PowerSystems" not in versions
    assert versions["PowerFlows"] == "0.16.4"
