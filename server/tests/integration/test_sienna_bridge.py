"""Integration tests for the Sienna bridge against the real Julia runtime.

Starting Julia takes over a minute, so one module-scoped bridge serves every
test. Skipped when the environment check finds a reason Julia cannot start.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from tensa.core.errors import SiennaError
from tensa.core.examples import _andes_cases_dir
from tensa.core.messages import PathScrubber
from tensa.engines.sienna import environment
from tensa.engines.sienna.bridge import JuliaBridge

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(
        environment.sienna_unavailable_reason() is not None,
        reason="Sienna's Julia runtime is not available",
    ),
]


@pytest.fixture(scope="module")
def bridge() -> JuliaBridge:
    started = JuliaBridge(scrub=PathScrubber(_andes_cases_dir()))
    started.start()
    return started


@pytest.fixture(scope="module")
def kundur_raw() -> Path:
    return _andes_cases_dir() / "kundur" / "kundur.raw"


@pytest.fixture(scope="module")
def session(
    bridge: JuliaBridge, kundur_raw: Path, tmp_path_factory: pytest.TempPathFactory
) -> object:
    scratch = tmp_path_factory.mktemp("sienna-scratch")
    return bridge.load_case(kundur_raw, None, scratch, None, None)


def test_versions_names_julia_and_the_sienna_packages(bridge: JuliaBridge) -> None:
    versions = bridge.versions()
    for name in (
        "julia",
        "PowerSystems",
        "PowerFlows",
        "PowerNetworkMatrices",
        "PowerSimulationsDynamics",
    ):
        assert versions[name], name


def test_report_topology_and_pflow_parse(bridge: JuliaBridge, session: object) -> None:
    report = bridge.report(session)
    assert report["buses"] == 10
    topology = bridge.topology(session)
    assert len(topology["buses"]) == 10
    assert len(topology["branches"]) == 15
    pflow = bridge.pflow(session)
    assert pflow["converged"] is True
    assert len(pflow["buses"]) == 10


def test_pflow_with_tolerance_and_limit_reports_them(bridge: JuliaBridge, session: object) -> None:
    pflow = bridge.pflow(session, tolerance=1e-10, max_iterations=20)
    assert pflow["converged"] is True
    assert pflow["tolerance"] == 1e-10
    assert pflow["max_iterations"] == 20


def test_missing_file_raises_sienna_error_naming_the_file(
    bridge: JuliaBridge, tmp_path: Path
) -> None:
    with pytest.raises(SiennaError) as caught:
        bridge.load_case(tmp_path / "nope.raw", None, tmp_path, None, None)
    message = str(caught.value)
    assert message == "case file not found: nope.raw"


def test_a_file_that_is_no_case_raises_sienna_error_naming_it(
    bridge: JuliaBridge, tmp_path: Path
) -> None:
    junk = tmp_path / "junk.raw"
    junk.write_text("this is not a case\n1 2 3\n")
    with pytest.raises(SiennaError) as caught:
        bridge.load_case(junk, None, tmp_path, None, None)
    message = str(caught.value)
    assert message.startswith("PowerSystems could not read junk.raw")
    assert "/" not in message
    assert "\\" not in message


def test_a_dyr_with_a_matpower_case_raises_sienna_error(
    bridge: JuliaBridge, kundur_raw: Path, tmp_path: Path
) -> None:
    case = tmp_path / "case.m"
    case.write_text("function mpc = case\n")
    with pytest.raises(SiennaError) as caught:
        bridge.load_case(case, kundur_raw.with_name("kundur_full.dyr"), tmp_path, None, None)
    assert str(caught.value) == "a .dyr file goes with a PSS/E .raw case, not with case.m"


def test_no_session_is_a_type_error_with_no_path(bridge: JuliaBridge) -> None:
    with pytest.raises(TypeError) as caught:
        bridge.report(None)
    assert not isinstance(caught.value, SiennaError)
    assert str(caught.value).startswith("report_json: MethodError: no method matching")
    assert "\\" not in str(caught.value)
    assert "/" not in str(caught.value)


def test_a_second_bridge_shares_the_module(
    bridge: JuliaBridge, session: object, kundur_raw: Path, tmp_path: Path
) -> None:
    second = JuliaBridge()
    second.start()
    # A session the first bridge made is a session of the module the second uses.
    assert second.report(session)["buses"] == 10
    other = second.load_case(kundur_raw, None, tmp_path, None, None)
    assert bridge.pflow(other)["converged"] is True


def test_worker_streams_stay_clean(kundur_raw: Path, tmp_path: Path) -> None:
    script = (
        "from pathlib import Path;"
        "from tensa.engines.sienna.bridge import JuliaBridge;"
        "b = JuliaBridge();"
        "b.start();"
        f"s = b.load_case(Path({str(kundur_raw)!r}), None, Path({str(tmp_path)!r}), None, None);"
        "b.pflow(s);"
        "print('done')"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
    )
    assert out.stdout == "done\n"
    assert out.stderr == ""
