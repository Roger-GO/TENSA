"""``tensa --version`` prints the tensa and ANDES versions."""

from __future__ import annotations

import importlib.metadata

import pytest
from typer.testing import CliRunner

import tensa
from tensa import cli

pytestmark = pytest.mark.unit

runner = CliRunner()


def test_version_flag_prints_tensa_and_andes_versions() -> None:
    result = runner.invoke(cli.app, ["--version"])
    assert result.exit_code == 0, result.output
    lines = result.output.strip().splitlines()
    assert lines[0] == f"tensa {tensa.__version__}"
    assert lines[1] == f"andes {importlib.metadata.version('andes')}"


def test_version_reports_unknown_when_andes_metadata_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _missing(_name: str) -> str:
        raise importlib.metadata.PackageNotFoundError

    monkeypatch.setattr(importlib.metadata, "version", _missing)
    result = runner.invoke(cli.app, ["--version"])
    assert result.exit_code == 0
    assert "andes unknown" in result.output
