"""Unit tests for the ``versions`` blocks of ``all_engine_capabilities``."""

from __future__ import annotations

import importlib.metadata

import pytest

from tensa.engines import all_engine_capabilities
from tensa.engines.sienna import environment


def _block(name: str) -> dict[str, object]:
    for block in all_engine_capabilities():
        if block["name"] == name:
            return block
    raise AssertionError(f"no block for {name}")


def test_andes_versions() -> None:
    assert _block("andes")["versions"] == {"andes": importlib.metadata.version("andes")}


def test_sienna_versions_when_available(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(environment, "sienna_unavailable_reason", lambda: None)
    manifest = tmp_path / "Manifest.toml"
    manifest.write_text(
        'julia_version = "1.13.4"\n\n[[deps.PowerSystems]]\nversion = "5.12.5"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(environment, "sienna_project", lambda: tmp_path)
    assert _block("sienna")["versions"] == {
        "julia": "1.13.4",
        "PowerSystems": "5.12.5",
    }


def test_sienna_versions_empty_when_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        environment, "sienna_unavailable_reason", lambda: "Julia was not found"
    )
    block = _block("sienna")
    assert block["available"] is False
    assert block["versions"] == {}
