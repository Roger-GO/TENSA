"""The example cases a fresh workspace is seeded with pass their verification.

Runs ``scripts/verify_example_cases.py`` on the default cases as a user would: it starts a real
``tensa serve`` on a free port with a temporary workspace, adds each case from the catalog,
opens it and runs the power flow, the undisturbed run, the eigenvalue analysis, the ring-down
and the case's disturbance through the HTTP API, and compares the outputs with the case's
reference file. The exit status and both reports are what is held here, and that the server
the script started is gone when it returns (the script stops its own server, by its pid).

The suite skips away from a checkout, and without ANDES.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import pytest

from tensa.core import examples
from tensa.core.example_catalog import load_catalog
from tests._repo import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "verify_example_cases.py"


def _run(args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    """The script's run, which is ended with ``terminate`` (so that it stops its server) when
    it takes too long; ``subprocess.run`` would kill it and leave the server running."""
    proc = subprocess.Popen(
        [sys.executable, str(SCRIPT), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.terminate()
        out, err = proc.communicate(timeout=60)
        pytest.fail(f"the verification took over {timeout:g} s:\n{err[-2000:]}")
    return subprocess.CompletedProcess(proc.args, proc.returncode, out, err)


@pytest.mark.acceptance
def test_the_default_cases_pass_their_verification(tmp_path: Path) -> None:
    if not SCRIPT.is_file():
        pytest.skip("scripts/verify_example_cases.py is not next to the tests")
    if examples._andes_cases_dir() is None:  # noqa: SLF001
        pytest.skip("ANDES is not installed")
    report_json = tmp_path / "report.json"
    report_md = tmp_path / "report.md"
    done = _run(
        ["--defaults", "--json", str(report_json), "--markdown", str(report_md)], timeout=900
    )
    assert done.returncode == 0, done.stderr[-3000:] + _failed_checks(report_json)

    report = json.loads(report_json.read_text(encoding="utf-8"))
    defaults = [e.id for e in load_catalog().defaults()]
    assert [c["id"] for c in report["cases"]] == defaults
    assert report["passed"] is True and report["counts"]["checks_failed"] == 0
    for case in report["cases"]:
        assert case["error"] is None and case["reference_file"], case["id"]
        kinds = {c["kind"] for c in case["checks"]}
        assert "independent-solver" in kinds, case["id"]
        if "tds" in case["analyses"]:
            assert {"ring-down", "sanity"} <= kinds, case["id"]
            names = [c["name"] for c in case["checks"]]
            assert "Undisturbed run stays at its power flow solution" in names
            assert "Disturbance run completes" in names
    assert report["counts"]["against_a_reference"] > 0
    page = report_md.read_text(encoding="utf-8")
    assert page.startswith("# Example case verification") and "All checks passed" in page

    # The server the script started is gone: nothing answers on its port.
    assert report["server"]["started_by_the_script"] is True
    parts = urlparse(report["server"]["url"])
    with socket.socket() as probe:
        probe.settimeout(2)
        assert probe.connect_ex((parts.hostname or "127.0.0.1", parts.port or 0)) != 0


@pytest.mark.acceptance
def test_the_gallery_cases_pass_their_verification_too(tmp_path: Path) -> None:
    """The cases that are not seeded (the WECC 179-bus case and three small ones) are run the same way."""
    if not SCRIPT.is_file():
        pytest.skip("scripts/verify_example_cases.py is not next to the tests")
    if examples._andes_cases_dir() is None:  # noqa: SLF001
        pytest.skip("ANDES is not installed")
    gallery = [e.id for e in load_catalog().examples if e.has_file and not e.default]
    assert {"wecc", "kundur_pss", "ieee14_fault", "pjm5bus"} <= set(gallery)
    report_json = tmp_path / "report.json"
    done = _run([*gallery, "--json", str(report_json), "--markdown", str(tmp_path / "r.md")], 900)
    assert done.returncode == 0, done.stderr[-3000:] + _failed_checks(report_json)
    report = json.loads(report_json.read_text(encoding="utf-8"))
    assert [c["id"] for c in report["cases"]] == gallery
    wecc = next(c for c in report["cases"] if c["id"] == "wecc")
    kinds = {c["kind"] for c in wecc["checks"]}
    # The power flow is checked against a solver and against the state the file stores.
    assert {"independent-solver", "stored-solution", "ring-down"} <= kinds
    names = [c["name"] for c in wecc["checks"]]
    assert "Disturbance run ends where it began" in names
    assert "The small disturbance does not grow" in names

    # The stabiliser case is held to the case without the stabiliser, in the time domain.
    pss = next(c for c in report["cases"] if c["id"] == "kundur_pss")
    assert "Damping of the mode between 0.3 and 0.9 Hz against kundur" in [
        c["name"] for c in pss["checks"]
    ]
    # The classical case's dynamics are checked against an independent computation, and none of
    # its checks is TENSA's own earlier output.
    pjm = next(c for c in report["cases"] if c["id"] == "pjm5bus")
    pjm_kinds = {c["kind"] for c in pjm["checks"]}
    assert {"independent-solver", "ring-down"} <= pjm_kinds
    assert "regression-baseline" not in pjm_kinds
    assert any("swing equations" in c["reference"] for c in pjm["checks"])


@pytest.mark.acceptance
def test_a_case_the_catalog_does_not_have_is_refused_before_anything_starts() -> None:
    if not SCRIPT.is_file():
        pytest.skip("scripts/verify_example_cases.py is not next to the tests")
    done = _run(["no-such-case"], timeout=60)
    assert done.returncode not in (0, 1)
    assert "no example case 'no-such-case'" in done.stderr


def _failed_checks(report_json: Path) -> str:
    if not report_json.is_file():
        return ""
    report = json.loads(report_json.read_text(encoding="utf-8"))
    lines = []
    for case in report["cases"]:
        if case["error"]:
            lines.append(f"{case['id']}: {case['error']}")
        lines += [
            f"{case['id']}: {c['name']}: {c['result']}" for c in case["checks"] if not c["passed"]
        ]
    return "\n" + "\n".join(lines)
