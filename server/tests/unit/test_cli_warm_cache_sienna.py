"""``tensa warm-cache --engine sienna``: the Sienna setup from the command line.

``setup_sienna`` is monkeypatched, so no Julia runs; the tests hold the command
to the options it passes, to the error it prints, and to leaving the ANDES path
exactly as it was.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tensa import cli
from tensa.engines.sienna import setup
from tests._cli import cli_runner

pytestmark = pytest.mark.unit

runner = cli_runner()


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    made: list[dict[str, Any]] = []

    def fake_setup_sienna(**kwargs: Any) -> Path:
        made.append(kwargs)
        return Path("/fake/project")

    monkeypatch.setattr("tensa.engines.sienna.setup.setup_sienna", fake_setup_sienna)
    return made


def test_engine_sienna_calls_setup_with_the_options(calls: list[dict[str, Any]]) -> None:
    result = runner.invoke(
        cli.app,
        [
            "warm-cache",
            "--engine",
            "sienna",
            "--julia",
            "/opt/julia/bin/julia",
            "--project",
            "/tmp/dyn",
            "--allow-julia-mismatch",
        ],
    )
    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    assert calls[0]["julia"] == Path("/opt/julia/bin/julia")
    assert calls[0]["project"] == Path("/tmp/dyn")
    assert calls[0]["allow_julia_mismatch"] is True
    assert callable(calls[0]["echo"])


def test_engine_sienna_defaults(calls: list[dict[str, Any]]) -> None:
    result = runner.invoke(cli.app, ["warm-cache", "--engine", "sienna"])
    assert result.exit_code == 0, result.output
    assert calls[0]["julia"] is None
    assert calls[0]["project"] is None
    assert calls[0]["allow_julia_mismatch"] is False


def test_a_setup_error_is_printed_and_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing(**kwargs: Any) -> Path:
        raise setup.SetupError("Julia was not found. Install it.")

    monkeypatch.setattr("tensa.engines.sienna.setup.setup_sienna", failing)
    result = runner.invoke(cli.app, ["warm-cache", "--engine", "sienna"])
    assert result.exit_code == 1
    assert result.stderr == "error: Julia was not found. Install it.\n"


def test_the_setup_s_lines_reach_standard_output_as_they_are(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def echoing(**kwargs: Any) -> Path:
        kwargs["echo"]("Copying Project.toml and Manifest.toml into /tmp/dyn")
        kwargs["echo"]("  PowerSystems 5.12.5")
        return Path("/tmp/dyn")

    monkeypatch.setattr("tensa.engines.sienna.setup.setup_sienna", echoing)
    result = runner.invoke(cli.app, ["warm-cache", "--engine", "sienna"])
    assert result.exit_code == 0
    assert result.stdout == (
        "Copying Project.toml and Manifest.toml into /tmp/dyn\n  PowerSystems 5.12.5\n"
    )
    assert result.stderr == ""


def test_engine_andes_and_no_engine_never_call_setup(
    calls: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    andes_runs: list[dict[str, Any]] = []

    class _Andes:
        __version__ = "2.0.0"

        @staticmethod
        def prepare(**kwargs: Any) -> None:
            andes_runs.append(kwargs)

    monkeypatch.setitem(__import__("sys").modules, "andes", _Andes)
    for args in (["warm-cache"], ["warm-cache", "--engine", "andes"]):
        result = runner.invoke(cli.app, args)
        assert result.exit_code == 0, result.output
    assert len(andes_runs) == 2
    assert calls == []


@pytest.mark.parametrize("option", ["--quick", "--incremental"])
def test_andes_options_with_engine_sienna_are_usage_errors(
    option: str, calls: list[dict[str, Any]]
) -> None:
    result = runner.invoke(cli.app, ["warm-cache", "--engine", "sienna", option])
    assert result.exit_code == 2
    assert f"{option} is an ANDES option; it cannot be used with --engine sienna" in result.output
    assert "\x1b" not in result.output
    assert calls == []


@pytest.mark.parametrize(
    "args",
    [
        ["--julia", "/opt/julia/bin/julia"],
        ["--project", "/tmp/dyn"],
        ["--allow-julia-mismatch"],
    ],
)
def test_sienna_options_without_engine_sienna_are_usage_errors(
    args: list[str], calls: list[dict[str, Any]]
) -> None:
    result = runner.invoke(cli.app, ["warm-cache", *args])
    assert result.exit_code == 2
    assert f"{args[0]} is a Sienna option; it needs --engine sienna" in result.output
    assert "\x1b" not in result.output
    assert calls == []


def test_help_names_both_engines() -> None:
    result = runner.invoke(cli.app, ["warm-cache", "--help"])
    assert result.exit_code == 0, result.output
    assert "andes" in result.output
    assert "sienna" in result.output
    assert "--engine" in result.output
    assert "--allow-julia-mismatch" in result.output
    # Rich markup would eat the brackets of the extra.
    assert 'pip install "tensa[sienna]"' in result.output
