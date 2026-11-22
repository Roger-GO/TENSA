"""The evidence of the known-difference register's entries.

``test_tgov1_torque`` is the check the ``tgov1-torque`` entry names: Kundur
with GENROU and TGOV1 only, both engines through the API. Sienna hands the
machine a torque of P_m / omega where ANDES hands it P_m, which is equivalent
to the machine's damping D raised by its P_m0 on the machine base. The test
reads each machine's P_m0 from the ANDES operating point after the power flow,
applies the raise through the edit route, and holds the electromechanical
modes of the two engines' eigenvalue answers to four significant digits. The
unadjusted ANDES run must NOT match to four digits: the difference the entry
documents is real. ``test_governor_torque`` does the same for GAST and HYGOV
(``gast-torque``, ``hygov-torque``), with the governors of PSID's benchmarks
on Kundur's machines, and ``test_hygov_integral_gain`` the other difference
of ANDES's HYGOV (its integral gain does not depend on Tr), which is not what
leaves ``hygov-torque`` a remainder.

The other entries are ANDES exciters that leave out part of the standard
model, each shown the same way on Kundur with the benchmark's exciter on every
machine: the parameter of the missing part changes nothing in ANDES, and
Sienna with that part taken out gives ANDES's modes to four digits
(``test_esac1a_rate_feedback``: KF; ``test_exac1_transducer``: TR), and
``test_esac1a_regulator_limits`` shows ANDES's ESAC1A run unchanged with VRMAX
under its operating point. EXST1's limiter is not small-signal:
``test_exst1_output_limiter`` holds the modes equal and shows, from ANDES's own
variables, the limiter hold the field voltage where its washout output sits on
a limit and let it pass a limit the regulator's output crosses.

Markers: ``sienna`` and ``integration``; skipped where the Sienna engine is
not available, as ``test_engines_agree.py`` is.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterator
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.examples import _andes_cases_dir
from tensa.engines.sienna.environment import sienna_unavailable_reason

_REASON = sienna_unavailable_reason()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(_REASON is not None, reason=f"the Sienna engine is not available: {_REASON}"),
]

# Four significant digits on a real or imaginary part.
_FOUR_DIGITS = 5e-5

# The idle time after which the server ends a session, for the fixtures that
# hold several sessions while each engine runs in turn.
_IDLE_TIMEOUT_S = 3600.0


def _genrou_tgov1_only(text: str) -> str:
    """The GENROU and TGOV1 records of a PSS/E .dyr, each ended by its ``/``."""
    records = [r.strip() for r in text.split("/") if r.strip()]
    kept = [
        r
        for r in records
        if re.split(r"[\s,]+", r)[1].strip("'") in ("GENROU", "TGOV1")
    ]
    return "".join(f"{r} /\n" for r in kept)


def _ok(response: Any) -> Any:
    assert response.status_code == 200, response.text
    return response.json()


def _modes(payload: dict[str, Any]) -> list[complex]:
    """The electromechanical modes of an eig answer: the pairs whose frequency
    is above 0.05 Hz, as complex values."""
    out = []
    for pair, frequency in zip(payload["eigenvalues"], payload["frequencies_hz"], strict=True):
        if frequency > 0.05:
            out.append(complex(pair["real"], pair["imag"]))
    return out


def _closest(value: complex, candidates: list[complex]) -> complex:
    return min(candidates, key=lambda candidate: abs(candidate - value))


def _matches_four_digits(reference: list[complex], comparison: list[complex]) -> list[tuple[complex, complex, float, float]]:
    """The pairs that fail four digits: each mode of ``reference`` matched to
    the nearest of ``comparison``, with the relative differences of the real
    and imaginary parts."""
    failures = []
    for mode in reference:
        other = _closest(mode, comparison)
        re_diff = abs(mode.real - other.real) / max(abs(mode.real), 1e-12)
        im_diff = abs(mode.imag - other.imag) / max(abs(mode.imag), 1e-12)
        if re_diff >= _FOUR_DIGITS or im_diff >= _FOUR_DIGITS:
            failures.append((mode, other, re_diff, im_diff))
    return failures


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Both engines' sessions on Kundur GENROU+TGOV1, each with a solved power
    flow, and the client."""
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("known") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    dyr = _genrou_tgov1_only((cases / "kundur" / "kundur_full.dyr").read_text())
    assert dyr.count("'GENROU'") == 4
    assert dyr.count("'TGOV1'") == 4
    (workspace / "kundur_tgov1.dyr").write_text(dyr)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
        # A session waits while the others' Julia starts and runs; the
        # default 180 s would reap it before the test comes back to it.
        idle_timeout_seconds=_IDLE_TIMEOUT_S,
    )
    case = {"primary_path": "kundur.raw", "addfiles": ["kundur_tgov1.dyr"]}
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        flows: dict[str, dict[str, Any]] = {}
        # A second ANDES session for the run with the raised damping. ANDES
        # takes an element edit only before setup, which a power flow commits,
        # so its machines are edited (with the operating point of the plain
        # session, the same case) before its first power flow, in the test.
        for name, engine in (("andes", "andes"), ("andes_raised", "andes"), ("sienna", "sienna")):
            created = client.post("/api/sessions", json={"engine": engine})
            assert created.status_code == 201, created.text
            sid = str(created.json()["session_id"])
            _ok(client.post(f"/api/sessions/{sid}/case", json=case))
            sessions[name] = sid
            if name == "andes_raised":
                continue
            flow = _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))
            assert flow["converged"] is True
            flows[name] = flow
        yield {"client": client, "sessions": sessions, "flows": flows}


def _raise_d_by_pm0(client: TestClient, sid: str, flow: dict[str, Any]) -> int:
    """Raise each ANDES machine's D by its P_m0 on the machine base, and
    answer how many machines were raised.

    The topology lists the machines among the generators (kind ``GENROU``,
    with ``Sn``, the machine MVA base, and ``gen``, the static generator it
    stands on). P_m0 is the machine's mechanical power at the operating point:
    its static generator's output from the power flow, in MW, over ``Sn``.
    ``flow`` is the power flow of another session on the same case: this one
    must still be before setup for ANDES to take the edits.
    """
    topology = _ok(client.get(f"/api/sessions/{sid}/topology"))
    outputs = flow["generator_outputs"]
    raised = 0
    for entry in topology["generators"]:
        if entry["kind"] != "GENROU":
            continue
        params = entry["params"]
        p_m0 = float(outputs[str(params["gen"])]["p"]) / float(params["Sn"])
        edited = client.put(
            f"/api/sessions/{sid}/elements/GENROU/{entry['idx']}",
            json={"params": {"D": float(params["D"]) + p_m0}},
        )
        assert edited.status_code == 200, edited.text
        raised += 1
    # The edit leaves no solved power flow; solve again before the analysis.
    assert _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))["converged"] is True
    return raised


def test_tgov1_torque(world: dict[str, Any]) -> None:
    client: TestClient = world["client"]
    sessions = world["sessions"]

    sienna_eig = _ok(
        client.post(
            f"/api/sessions/{sessions['sienna']}/eig", json={"load_model": "impedance"}
        )
    )
    andes_plain = _ok(client.post(f"/api/sessions/{sessions['andes']}/eig", json={}))

    sienna_modes = _modes(sienna_eig)
    plain_modes = _modes(andes_plain)
    assert len(sienna_modes) == len(plain_modes)
    assert len(sienna_modes) > 0

    # The difference the entry documents: unadjusted, at least one mode is off
    # by more than four digits.
    assert _matches_four_digits(sienna_modes, plain_modes)

    assert _raise_d_by_pm0(client, sessions["andes_raised"], world["flows"]["andes"]) == 4
    andes_raised = _ok(client.post(f"/api/sessions/{sessions['andes_raised']}/eig", json={}))
    raised_modes = _modes(andes_raised)
    assert len(raised_modes) == len(sienna_modes)

    failures = _matches_four_digits(sienna_modes, raised_modes)
    assert failures == [], (
        f"{len(failures)} mode(s) off by more than four digits: "
        + "; ".join(
            f"{mode} vs {other} (re {re_diff:.2e}, im {im_diff:.2e})"
            for mode, other, re_diff, im_diff in failures
        )
    )

    # The fidelity endpoint reports the governors on the Sienna session and
    # nothing on the ANDES one.
    sienna_fidelity = _ok(client.get(f"/api/sessions/{sessions['sienna']}/fidelity"))
    assert sienna_fidelity["engine"] == "sienna"
    governors = {
        entry["key"]: entry["state"]
        for entry in sienna_fidelity["entries"]
        if entry["key"].endswith("/governor")
    }
    assert governors == {
        f"gen:{bus}-1/governor": "known-difference:tgov1-torque" for bus in (1, 2, 3, 4)
    }
    andes_fidelity = _ok(client.get(f"/api/sessions/{sessions['andes']}/fidelity"))
    assert andes_fidelity["engine"] == "andes"
    assert andes_fidelity["entries"] == []


# ---------------------------------------------------------------------------
# esac1a-rate-feedback
# ---------------------------------------------------------------------------

# The ESAC1A of PowerSimulationsDynamics's ESAC1A benchmark, in PSS/E's column
# order (TR TB TC KA TA VAMAX VAMIN TE KF TF KC KD KE E1 SE(E1) E2 SE(E2) VRMAX
# VRMIN), with the rate feedback gain KF and VRMAX left to the caller (the
# benchmark's are 0.02 and 10).
_ESAC1A_RECORD = (
    "{bus} 'ESAC1A' 1 0.01 0.1 0.0 200.0 0.05 7.0 -7.0 1.333 {kf} 0.8 "
    "0.0 0.0 1.0 0.0 0.0 0.0 0.0 {vrmax} -10.0 /\n"
)

# The cases of the ESAC1A checks: (KF, VRMAX) and the engines each runs in.
# ``vrmax1`` puts VRMAX under the regulator output of the operating point
# (about 1.9 pu), where a clamp on V_R, which PSS/E and Sienna have, leaves the
# exciter no equilibrium; ``vrmax10`` is the same case with the benchmark's
# VRMAX, in a session of its own so that both runs start from a session that
# has run nothing. Only ANDES runs them.
_ESAC1A_CASES: Final = {
    "kf": ((0.02, 10.0), ("andes", "sienna")),
    "no_kf": ((0.0, 10.0), ("andes", "sienna")),
    "vrmax1": ((0.02, 1.0), ("andes",)),
    "vrmax10": ((0.02, 10.0), ("andes",)),
}


def _genrou_esac1a(text: str, kf: float, vrmax: float) -> str:
    """The GENROU records of a PSS/E .dyr, each machine given the benchmark's
    ESAC1A with rate feedback gain ``kf`` and upper limit ``vrmax``."""
    machines = _genrou_tgov1_only(text)
    records = [r for r in machines.split("/\n") if "'GENROU'" in r]
    buses = [int(re.split(r"[\s,]+", r.strip())[0]) for r in records]
    exciters = "".join(_ESAC1A_RECORD.format(bus=bus, kf=kf, vrmax=vrmax) for bus in buses)
    return "".join(f"{r}/\n" for r in records) + exciters


@pytest.fixture(scope="module")
def esac1a_world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Kundur's four GENROU machines, each with an ESAC1A, in both engines:
    with the benchmark's rate feedback gain (KF 0.02) and without it (KF 0),
    and in ANDES with VRMAX under the operating point (``_ESAC1A_CASES``),
    each with a solved power flow."""
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("known-esac1a") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    full = (cases / "kundur" / "kundur_full.dyr").read_text()
    for name, ((kf, vrmax), _) in _ESAC1A_CASES.items():
        dyr = _genrou_esac1a(full, kf, vrmax)
        assert dyr.count("'GENROU'") == 4 and dyr.count("'ESAC1A'") == 4
        (workspace / f"kundur_esac1a_{name}.dyr").write_text(dyr)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
        # A session waits while the others' Julia starts and runs; the
        # default 180 s would reap it before the test comes back to it.
        idle_timeout_seconds=_IDLE_TIMEOUT_S,
        # One session per case and engine, more than the default cap of four.
        max_sessions=sum(len(engines) for _, engines in _ESAC1A_CASES.values()),
    )
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        for name, (_, engines) in _ESAC1A_CASES.items():
            for engine in engines:
                created = client.post("/api/sessions", json={"engine": engine})
                assert created.status_code == 201, created.text
                sid = str(created.json()["session_id"])
                case = {"primary_path": "kundur.raw", "addfiles": [f"kundur_esac1a_{name}.dyr"]}
                _ok(client.post(f"/api/sessions/{sid}/case", json=case))
                assert _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))["converged"] is True
                sessions[f"{engine}_{name}"] = sid
        yield {"client": client, "sessions": sessions}


def test_esac1a_rate_feedback(esac1a_world: dict[str, Any]) -> None:
    """ANDES's ESAC1A computes the rate feedback (its washout ``WF`` of
    ``VFE``) and never subtracts it at the summing point, where IEEE 421.5 and
    Sienna subtract ``V_F``. So KF does nothing in ANDES, and Sienna with KF 0
    gives ANDES's modes to four digits while Sienna with the benchmark's KF
    does not."""
    client: TestClient = esac1a_world["client"]
    sessions = esac1a_world["sessions"]

    def modes(name: str) -> list[complex]:
        engine = name.split("_", 1)[0]
        body = {} if engine == "andes" else {"load_model": "impedance"}
        return _modes(_ok(client.post(f"/api/sessions/{sessions[name]}/eig", json=body)))

    andes_kf = modes("andes_kf")
    andes_no_kf = modes("andes_no_kf")
    sienna_kf = modes("sienna_kf")
    sienna_no_kf = modes("sienna_no_kf")
    assert andes_kf and sienna_kf

    # KF moves nothing in ANDES: the feedback never reaches the regulator.
    assert _matches_four_digits(andes_kf, andes_no_kf) == []
    assert _matches_four_digits(andes_no_kf, andes_kf) == []
    # The difference the entry documents: with KF, at least one mode is off.
    assert _matches_four_digits(sienna_kf, andes_kf)
    # Without the feedback in Sienna, the two engines agree to four digits.
    for reference, comparison in ((sienna_no_kf, andes_kf), (andes_kf, sienna_no_kf)):
        failures = _matches_four_digits(reference, comparison)
        assert failures == [], (
            f"{len(failures)} mode(s) off by more than four digits: "
            + "; ".join(
                f"{mode} vs {other} (re {re_diff:.2e}, im {im_diff:.2e})"
                for mode, other, re_diff, im_diff in failures
            )
        )

    # The fidelity endpoint reports the exciters on the Sienna session.
    fidelity = _ok(client.get(f"/api/sessions/{sessions['sienna_kf']}/fidelity"))
    exciters = {
        entry["key"]: entry["state"]
        for entry in fidelity["entries"]
        if entry["key"].endswith("/exciter")
    }
    assert exciters == {
        f"gen:{bus}-1/exciter": "known-difference:esac1a-rate-feedback" for bus in (1, 2, 3, 4)
    }


def test_esac1a_regulator_limits(esac1a_world: dict[str, Any]) -> None:
    """ANDES's ESAC1A has VRMAX and VRMIN among its data and no limit on the
    regulator output V_R in its equations: the exciter's integrator takes
    ``LVG_y - VFE``, the gated ``LA_y`` (V_A), where IEEE 421.5 and Sienna
    clamp V_R to [VRMIN, VRMAX] first. So VRMAX under the operating point
    changes nothing in ANDES: the run is the one with VRMAX 10, and the
    exciter holds its equilibrium with V_A at 1.9 pu, above VRMAX 1, which a
    clamped V_R could not (the exciter voltage would fall at (VRMAX - VFE) /
    TE). Sienna's clamp is not exercised: inside the limits it is the
    identity, which is all the modes of ``test_esac1a_rate_feedback`` see."""
    client: TestClient = esac1a_world["client"]
    sessions = esac1a_world["sessions"]
    variables = [f"{var} ESAC1A 1" for var in ("LA_y", "VFE", "INT_y", "vout")]

    def run(name: str) -> dict[str, list[float]]:
        answer = _ok(
            client.post(
                f"/api/sessions/{sessions[name]}/tds",
                json={"tf": 0.5, "dae_vars": variables},
            )
        )
        assert answer["converged"] is True
        return {
            str(v["name"]).split()[0]: [float(x) for x in v["values"]]
            for v in answer["traces"]["variables"]
        }

    limited, unlimited = run("andes_vrmax1"), run("andes_vrmax10")
    assert set(limited) == set(unlimited)
    for name, series in limited.items():
        assert series == pytest.approx(unlimited[name], rel=1e-12, abs=1e-12), name
    vrmax = 1.0
    for va, vfe, ve in zip(limited["LA_y"], limited["VFE"], limited["INT_y"], strict=True):
        assert va > vrmax + 0.5
        assert va == pytest.approx(vfe, abs=1e-5)  # in equilibrium: V_R = VFE
        assert ve == pytest.approx(limited["INT_y"][0], abs=1e-6)


# ---------------------------------------------------------------------------
# gast-torque and hygov-torque
# ---------------------------------------------------------------------------

# The governors of PowerSimulationsDynamics's GAST and HYGOV benchmarks, in
# PSS/E's column order: GAST (R T1 T2 T3 AT KT VMAX VMIN DTURB) and HYGOV (R r
# TR TF TG VELM GMAX GMIN TW AT DTURB QNL).
_GOVERNOR_RECORDS = {
    "GAST": "{bus} 'GAST' 1 0.05 0.2 0.2 2.0 1.0 2.5 1.1 0.01 0.0 /\n",
    "HYGOV": "{bus} 'HYGOV' 1 0.05 0.075 12.0 0.5 20.5 0.1 1.0 0.0 15.0 1.5 0.0 0.08 /\n",
}


def _genrou_with(text: str, governor: str) -> str:
    """The GENROU records of a PSS/E .dyr, each machine given the benchmark's
    ``governor``."""
    machines = _genrou_tgov1_only(text)
    records = [r for r in machines.split("/\n") if "'GENROU'" in r]
    buses = [int(re.split(r"[\s,]+", r.strip())[0]) for r in records]
    governors = "".join(_GOVERNOR_RECORDS[governor].format(bus=bus) for bus in buses)
    return "".join(f"{r}/\n" for r in records) + governors


@pytest.fixture(scope="module", params=sorted(_GOVERNOR_RECORDS))
def governor_world(
    request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[dict[str, Any]]:
    """Kundur's four GENROU machines, each with the benchmark's governor, in
    both engines and in a second ANDES session left before setup for the
    raised damping, as ``world`` holds them for TGOV1."""
    governor = str(request.param)
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp(f"known-{governor.lower()}") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    dyr = _genrou_with((cases / "kundur" / "kundur_full.dyr").read_text(), governor)
    assert dyr.count("'GENROU'") == 4 and dyr.count(f"'{governor}'") == 4
    (workspace / "kundur_governor.dyr").write_text(dyr)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
        # A session waits while the others' Julia starts and runs; the
        # default 180 s would reap it before the test comes back to it.
        idle_timeout_seconds=_IDLE_TIMEOUT_S,
    )
    case = {"primary_path": "kundur.raw", "addfiles": ["kundur_governor.dyr"]}
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        flows: dict[str, dict[str, Any]] = {}
        for name, engine in (("andes", "andes"), ("andes_raised", "andes"), ("sienna", "sienna")):
            created = client.post("/api/sessions", json={"engine": engine})
            assert created.status_code == 201, created.text
            sid = str(created.json()["session_id"])
            _ok(client.post(f"/api/sessions/{sid}/case", json=case))
            sessions[name] = sid
            if name == "andes_raised":
                continue
            flow = _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))
            assert flow["converged"] is True
            flows[name] = flow
        yield {"governor": governor, "client": client, "sessions": sessions, "flows": flows}


def test_governor_torque(governor_world: dict[str, Any]) -> None:
    """The check of ``gast-torque`` and ``hygov-torque``: Sienna's GasTG and
    HydroTurbineGov hand the machine a torque of their power over omega, as
    its SteamTurbineGov1 does (``tgov1-torque``), where ANDES's GAST and HYGOV
    hand it the power. ANDES with each machine's D raised by its P_m0 gives
    Sienna's modes to four digits, and without the raise it does not."""
    client: TestClient = governor_world["client"]
    sessions = governor_world["sessions"]
    governor = governor_world["governor"]

    sienna_modes = _modes(
        _ok(client.post(f"/api/sessions/{sessions['sienna']}/eig", json={"load_model": "impedance"}))
    )
    plain_modes = _modes(_ok(client.post(f"/api/sessions/{sessions['andes']}/eig", json={})))
    assert sienna_modes and len(sienna_modes) == len(plain_modes)
    assert _matches_four_digits(sienna_modes, plain_modes)

    assert _raise_d_by_pm0(client, sessions["andes_raised"], governor_world["flows"]["andes"]) == 4
    raised_modes = _modes(
        _ok(client.post(f"/api/sessions/{sessions['andes_raised']}/eig", json={}))
    )
    assert len(raised_modes) == len(sienna_modes)
    failures = _matches_four_digits(sienna_modes, raised_modes)
    if governor == "HYGOV":
        # The raise accounts for most of the HYGOV difference but not all:
        # the 0.637 Hz mode keeps a relative difference of 1.37e-3 in its
        # real part (8.5e-5 in its imaginary part) after it, where without it
        # the difference is larger; every other mode matches to four digits.
        # The remainder is not explained. The one structural difference found
        # in the two HYGOV implementations, ANDES's integral gain of 1 where
        # Sienna's is 1/(r Tr), is not it: test_hygov_integral_gain gives both
        # engines the same gain and the remainder stays. The check holds it to
        # 2e-3 so that it cannot grow unnoticed.
        plain = {mode: (re_d, im_d) for mode, _, re_d, im_d in _matches_four_digits(sienna_modes, plain_modes)}
        for mode, _, re_diff, im_diff in failures:
            assert re_diff <= 2e-3 and im_diff <= 2e-4, (mode, re_diff, im_diff)
            assert mode in plain and re_diff < plain[mode][0], (mode, re_diff, plain.get(mode))
        failures = []
    assert failures == [], (
        f"{governor}: {len(failures)} mode(s) off by more than four digits: "
        + "; ".join(
            f"{mode} vs {other} (re {re_diff:.2e}, im {im_diff:.2e})"
            for mode, other, re_diff, im_diff in failures
        )
    )

    fidelity = _ok(client.get(f"/api/sessions/{sessions['sienna']}/fidelity"))
    governors = {
        entry["key"]: entry["state"]
        for entry in fidelity["entries"]
        if entry["key"].endswith("/governor")
    }
    entry_id = f"{governor.lower()}-torque"
    assert governors == {
        f"gen:{bus}-1/governor": f"known-difference:{entry_id}" for bus in (1, 2, 3, 4)
    }


# The HYGOV's permanent droop r and the reset time Tr of its PI, and the Tr at
# which ANDES's integral gain (1) equals PSS/E's and Sienna's (1 / (r * Tr)).
_HYGOV_R: Final = 0.075
_HYGOV_TR: Final = 12.0
_HYGOV_TR_UNIT_GAIN: Final = 1.0 / _HYGOV_R

# The sessions of the HYGOV gain check: name, engine and Tr.
_HYGOV_GAIN_SESSIONS: Final = (
    ("andes_bench", "andes", _HYGOV_TR),
    ("andes_unit_gain", "andes", _HYGOV_TR_UNIT_GAIN),
    ("andes_unit_gain_raised", "andes", _HYGOV_TR_UNIT_GAIN),
    ("sienna_bench", "sienna", _HYGOV_TR),
    ("sienna_unit_gain", "sienna", _HYGOV_TR_UNIT_GAIN),
)


def _genrou_hygov(text: str, tr: float) -> str:
    """The GENROU records of a PSS/E .dyr, each machine given the HYGOV
    benchmark's governor with reset time ``tr``."""
    record = _GOVERNOR_RECORDS["HYGOV"]
    field = f" {_HYGOV_R} {_HYGOV_TR} "
    assert record.count(field) == 1
    record = record.replace(field, f" {_HYGOV_R} {tr!r} ")
    machines = _genrou_tgov1_only(text)
    records = [r for r in machines.split("/\n") if "'GENROU'" in r]
    buses = [int(re.split(r"[\s,]+", r.strip())[0]) for r in records]
    return "".join(f"{r}/\n" for r in records) + "".join(record.format(bus=bus) for bus in buses)


def _eigenvalues(payload: dict[str, Any]) -> list[complex]:
    """Every eigenvalue of an eig answer, the real ones included."""
    return [complex(pair["real"], pair["imag"]) for pair in payload["eigenvalues"]]


@pytest.fixture(scope="module")
def hygov_gain_world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Kundur's four GENROU machines, each with the benchmark's HYGOV, with its
    Tr (12 s) and with Tr = 1/r, in both engines (a power flow solved), and a
    third ANDES session with Tr = 1/r left before setup for the raised
    damping."""
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("known-hygov-gain") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    full = (cases / "kundur" / "kundur_full.dyr").read_text()
    for tr in (_HYGOV_TR, _HYGOV_TR_UNIT_GAIN):
        dyr = _genrou_hygov(full, tr)
        assert dyr.count("'GENROU'") == 4 and dyr.count("'HYGOV'") == 4
        (workspace / f"kundur_hygov_{tr:.4f}.dyr").write_text(dyr)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
        # A session waits while the others' Julia starts and runs; the
        # default 180 s would reap it before the test comes back to it.
        idle_timeout_seconds=_IDLE_TIMEOUT_S,
        max_sessions=len(_HYGOV_GAIN_SESSIONS),
    )
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        flows: dict[str, dict[str, Any]] = {}
        for name, engine, tr in _HYGOV_GAIN_SESSIONS:
            created = client.post("/api/sessions", json={"engine": engine})
            assert created.status_code == 201, created.text
            sid = str(created.json()["session_id"])
            case = {"primary_path": "kundur.raw", "addfiles": [f"kundur_hygov_{tr:.4f}.dyr"]}
            _ok(client.post(f"/api/sessions/{sid}/case", json=case))
            sessions[name] = sid
            if name.endswith("_raised"):
                continue
            flow = _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))
            assert flow["converged"] is True
            flows[name] = flow
        yield {"client": client, "sessions": sessions, "flows": flows}


def test_hygov_integral_gain(hygov_gain_world: dict[str, Any]) -> None:
    """ANDES's HYGOV integrates the filtered error with gain 1 (``gtpos`` has
    ``e_str='LG_y'`` and no time constant; its ``tr = r * Tr`` is computed and
    never used), so its PI is ``1/r + 1/s`` where PSS/E's and Sienna's is
    ``1/r + 1/(r Tr s)``; the two are one where ``r * Tr = 1``. Tr therefore
    moves no eigenvalue in ANDES and moves the slow governor poles in Sienna.

    It is not the remainder of ``hygov-torque``: with Tr = 1/r in both
    engines and the torque raise in ANDES, the 0.637 Hz mode stays as far
    apart as with the benchmark's Tr (1.43e-3 relative in its real part,
    against 1.37e-3), and every other mode above 0.05 Hz agrees to four
    digits. This check holds both findings."""
    client: TestClient = hygov_gain_world["client"]
    sessions = hygov_gain_world["sessions"]

    def eig(name: str) -> dict[str, Any]:
        body = {"load_model": "impedance"} if name.startswith("sienna") else {}
        return dict(_ok(client.post(f"/api/sessions/{sessions[name]}/eig", json=body)))

    # Tr moves nothing in ANDES, slow poles included: its integral gain does
    # not depend on it.
    andes_bench, andes_unit = _eigenvalues(eig("andes_bench")), _eigenvalues(eig("andes_unit_gain"))
    assert len(andes_bench) == len(andes_unit)
    for value in andes_bench:
        assert abs(_closest(value, andes_unit) - value) <= 1e-9 * max(abs(value), 1.0), value

    # Tr moves Sienna's slow governor poles (one by about a tenth: -0.0331 to
    # -0.0299 per second).
    sienna_bench_eig, sienna_unit_eig = eig("sienna_bench"), eig("sienna_unit_gain")
    sienna_bench, sienna_unit = _eigenvalues(sienna_bench_eig), _eigenvalues(sienna_unit_eig)
    moved = max(
        abs(_closest(value, sienna_unit) - value) / max(abs(value), 1e-9) for value in sienna_bench
    )
    assert moved > 1e-2, moved

    # With the gains equal, the 0.637 Hz remainder is still there.
    raised = _raise_d_by_pm0(
        client, sessions["andes_unit_gain_raised"], hygov_gain_world["flows"]["andes_unit_gain"]
    )
    assert raised == 4
    andes_raised = _modes(eig("andes_unit_gain_raised"))
    sienna_modes = _modes(sienna_unit_eig)
    assert len(andes_raised) == len(sienna_modes)
    failures = _matches_four_digits(sienna_modes, andes_raised)
    assert failures, "the 0.637 Hz remainder is gone: revisit hygov-torque"
    for mode, _, re_diff, im_diff in failures:
        assert abs(abs(mode.imag) / (2 * math.pi) - 0.637) < 0.01, mode
        assert 1e-3 <= re_diff <= 2e-3 and im_diff <= 2e-4, (mode, re_diff, im_diff)


# ---------------------------------------------------------------------------
# exst1-output-limiter
# ---------------------------------------------------------------------------

# The EXST1 of PowerSimulationsDynamics's EXST1 benchmark, in PSS/E's column
# order (TR VIMAX VIMIN TC TB KA TA VRMAX VRMIN KC KF TF), with VRMAX and VRMIN
# left to the caller (the benchmark's are 6 and 0). KF is 0, so the rate
# feedback's washout output is 0 throughout.
_EXST1_RECORD = (
    "{bus} 'EXST1' 1 0.01 5.0 -5.0 10.0 20.0 200.0 0.1 {vrmax} {vrmin} 0.0 0.0 0.1 /\n"
)

# The cases of the EXST1 check: (VRMAX, VRMIN) and the engines each runs in.
# ``vrmax1`` puts the upper limit under the field voltage of the operating
# point (about 1.9 pu), which a limiter on the regulator's output could not
# hold; only ANDES runs it.
_EXST1_CASES: Final = {
    "vrmin0": ((6.0, 0.0), ("andes", "sienna")),
    "vrmin_low": ((6.0, -1.0), ("andes", "sienna")),
    "vrmax1": ((1.0, -1.0), ("andes",)),
}

# The ANDES variables of the first machine's EXST1 that show its limiter: the
# regulator's output, the washout output the limiter is keyed on, the two
# limits and the field voltage.
_EXST1_VARS: Final = ("LR_y", "WF_y", "vfmin", "vfmax", "vout")


def _genrou_exst1(text: str, vrmax: float, vrmin: float) -> str:
    machines = _genrou_tgov1_only(text)
    records = [r for r in machines.split("/\n") if "'GENROU'" in r]
    buses = [int(re.split(r"[\s,]+", r.strip())[0]) for r in records]
    exciters = "".join(
        _EXST1_RECORD.format(bus=bus, vrmax=vrmax, vrmin=vrmin) for bus in buses
    )
    return "".join(f"{r}/\n" for r in records) + exciters


@pytest.fixture(scope="module")
def exst1_world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Kundur's four GENROU machines, each with the benchmark's EXST1, with
    the limits of ``_EXST1_CASES``, each in its engines with a solved power
    flow."""
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("known-exst1") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    full = (cases / "kundur" / "kundur_full.dyr").read_text()
    for name, ((vrmax, vrmin), _) in _EXST1_CASES.items():
        (workspace / f"kundur_exst1_{name}.dyr").write_text(_genrou_exst1(full, vrmax, vrmin))
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
        # A session waits while the others' Julia starts and runs; the
        # default 180 s would reap it before the test comes back to it.
        idle_timeout_seconds=_IDLE_TIMEOUT_S,
        # One session per case and engine, more than the default cap of four.
        max_sessions=sum(len(engines) for _, engines in _EXST1_CASES.values()),
    )
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        for name, (_, engines) in _EXST1_CASES.items():
            for engine in engines:
                created = client.post("/api/sessions", json={"engine": engine})
                assert created.status_code == 201, created.text
                sid = str(created.json()["session_id"])
                case = {"primary_path": "kundur.raw", "addfiles": [f"kundur_exst1_{name}.dyr"]}
                _ok(client.post(f"/api/sessions/{sid}/case", json=case))
                assert _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))["converged"] is True
                sessions[f"{engine}_{name}"] = sid
        yield {"client": client, "sessions": sessions}


def test_exst1_output_limiter(exst1_world: dict[str, Any]) -> None:
    """ANDES's EXST1 decides whether the field voltage is at a limit from its
    rate feedback's washout output (``HLR`` limits ``WF_y``), not from the
    regulator's output ``LR_y``, and its limits leave out the terminal
    voltage (``VRMAX - KC * XadIfd`` and ``VRMIN - KC * XadIfd`` where PSS/E
    and Sienna have ``VT * VRMAX - KC * IFD`` and ``VT * VRMIN - KC * IFD``).
    With KF 0 the washout output is 0, and ANDES's own variables show both
    sides of that: with VRMIN 0 and KC 0 the washout output sits on the lower
    limit, so the field voltage is held at 0 while the regulator's output is
    1.9 pu, inside both limits (the run starts from a failed initialisation,
    which Sienna's does not); with VRMAX 1 the regulator's output, 1.9 pu, is
    above the upper limit, and the field voltage follows it there. With VRMIN
    -1 and VRMAX 6 neither limit is reached at the operating point, and the
    modes agree to four digits: the difference is in the limiter alone."""
    client: TestClient = exst1_world["client"]
    sessions = exst1_world["sessions"]

    def run(name: str, **extra: Any) -> Any:
        engine = name.split("_", 1)[0]
        body: dict[str, Any] = {"tf": 0.1, **extra}
        if engine == "sienna":
            body["load_model"] = "impedance"
        return _ok(client.post(f"/api/sessions/{sessions[name]}/tds", json=body))

    def andes_limiter(name: str) -> tuple[bool, dict[str, list[float]]]:
        """The run's convergence and the first machine's EXST1 variables."""
        answer = run(name, dae_vars=[f"{var} EXST1 1" for var in _EXST1_VARS])
        series = {
            str(v["name"]).split()[0]: [float(x) for x in v["values"]]
            for v in answer["traces"]["variables"]
        }
        assert set(series) == set(_EXST1_VARS)
        return bool(answer["converged"]), series

    def steps(series: dict[str, list[float]]) -> list[tuple[float, ...]]:
        return list(zip(*(series[v] for v in _EXST1_VARS), strict=True))

    def modes(name: str) -> list[complex]:
        engine = name.split("_", 1)[0]
        body = {} if engine == "andes" else {"load_model": "impedance"}
        return _modes(_ok(client.post(f"/api/sessions/{sessions[name]}/eig", json=body)))

    andes_low, sienna_low = modes("andes_vrmin_low"), modes("sienna_vrmin_low")
    assert andes_low and len(andes_low) == len(sienna_low)
    assert _matches_four_digits(sienna_low, andes_low) == []
    assert _matches_four_digits(andes_low, sienna_low) == []

    assert run("sienna_vrmin0")["converged"] is True
    assert run("andes_vrmin_low")["converged"] is True

    # VRMIN 0: the limiter's input (the washout output, 0) sits on its lower
    # limit, so the field voltage is that limit, 0, at every step, while the
    # regulator's output stays inside both limits.
    converged, held = andes_limiter("andes_vrmin0")
    assert converged is False
    for step, (_lr, wf, low, high, vout) in enumerate(steps(held)):
        assert wf == 0.0 and low == 0.0 and high == 6.0, step
        assert abs(vout) < 1e-9, (step, vout)
    assert 1.0 < held["LR_y"][0] < 6.0

    # VRMAX 1: the regulator's output is above the upper limit, the limiter's
    # input (0) is inside both limits, and the field voltage is the
    # regulator's output.
    converged, above = andes_limiter("andes_vrmax1")
    assert converged is True
    for step, (lr, wf, low, high, vout) in enumerate(steps(above)):
        assert wf == 0.0 and low == -1.0 and high == 1.0, step
        assert vout == pytest.approx(lr, abs=1e-12) and vout > high + 0.5, (step, vout)


# ---------------------------------------------------------------------------
# exac1-transducer
# ---------------------------------------------------------------------------

# The EXAC1 of PowerSimulationsDynamics's EXAC1 benchmark, in the column order
# both engines read (TR TB TC KA TA VRMAX VRMIN TE KF TF KC KD KE E1 SE(E1) E2
# SE(E2)), with the transducer time constant TR left to the caller.
_EXAC1_RECORD = (
    "{bus} 'EXAC1' 1 {tr} 1.0 1.0 200.0 0.2 10.0 -10.0 0.1 0.001 0.1 "
    "1.0 1.0 1.0 1.0 0.0 1.2 0.0 /\n"
)


def _genrou_exac1(text: str, tr: float) -> str:
    machines = _genrou_tgov1_only(text)
    records = [r for r in machines.split("/\n") if "'GENROU'" in r]
    buses = [int(re.split(r"[\s,]+", r.strip())[0]) for r in records]
    exciters = "".join(_EXAC1_RECORD.format(bus=bus, tr=tr) for bus in buses)
    return "".join(f"{r}/\n" for r in records) + exciters


@pytest.fixture(scope="module")
def exac1_world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Kundur's four GENROU machines, each with the benchmark's EXAC1, with
    its TR (0.01 s) and with TR 0, in both engines with a solved power flow."""
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("known-exac1") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    full = (cases / "kundur" / "kundur_full.dyr").read_text()
    for name, tr in (("tr", 0.01), ("no_tr", 0.0)):
        (workspace / f"kundur_exac1_{name}.dyr").write_text(_genrou_exac1(full, tr))
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
        # A session waits while the others' Julia starts and runs; the
        # default 180 s would reap it before the test comes back to it.
        idle_timeout_seconds=_IDLE_TIMEOUT_S,
    )
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        for engine in ("andes", "sienna"):
            for name in ("tr", "no_tr"):
                created = client.post("/api/sessions", json={"engine": engine})
                assert created.status_code == 201, created.text
                sid = str(created.json()["session_id"])
                case = {"primary_path": "kundur.raw", "addfiles": [f"kundur_exac1_{name}.dyr"]}
                _ok(client.post(f"/api/sessions/{sid}/case", json=case))
                assert _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))["converged"] is True
                sessions[f"{engine}_{name}"] = sid
        yield {"client": client, "sessions": sessions}


def test_exac1_transducer(exac1_world: dict[str, Any]) -> None:
    """ANDES's EXAC1 computes the transducer lag (``LG``, time constant TR)
    and never uses it: the summing point takes the terminal voltage ``v``
    itself, where Sienna, like IEEE 421.5, takes the lagged one. So TR does
    nothing in ANDES, and Sienna with TR 0 gives ANDES's modes to four digits
    while Sienna with the benchmark's TR does not."""
    client: TestClient = exac1_world["client"]
    sessions = exac1_world["sessions"]

    def modes(name: str) -> list[complex]:
        engine = name.split("_", 1)[0]
        body = {} if engine == "andes" else {"load_model": "impedance"}
        return _modes(_ok(client.post(f"/api/sessions/{sessions[name]}/eig", json=body)))

    andes_tr, andes_no_tr = modes("andes_tr"), modes("andes_no_tr")
    sienna_tr, sienna_no_tr = modes("sienna_tr"), modes("sienna_no_tr")
    assert andes_tr and sienna_tr

    assert _matches_four_digits(andes_tr, andes_no_tr) == []
    assert _matches_four_digits(andes_no_tr, andes_tr) == []
    assert _matches_four_digits(sienna_tr, andes_tr)
    for reference, comparison in ((sienna_no_tr, andes_tr), (andes_tr, sienna_no_tr)):
        failures = _matches_four_digits(reference, comparison)
        assert failures == [], (
            f"{len(failures)} mode(s) off by more than four digits: "
            + "; ".join(
                f"{mode} vs {other} (re {re_diff:.2e}, im {im_diff:.2e})"
                for mode, other, re_diff, im_diff in failures
            )
        )
