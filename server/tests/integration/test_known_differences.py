"""The evidence of the known-difference register's entries.

``test_tgov1_torque`` is the check the ``tgov1-torque`` entry names: Kundur
with GENROU and TGOV1 only, both engines through the API. Sienna hands the
machine a torque of P_m / omega where ANDES hands it P_m, which is equivalent
to the machine's damping D raised by its P_m0 on the machine base. The test
reads each machine's P_m0 from the ANDES operating point after the power flow,
applies the raise through the edit route, and holds the electromechanical
modes of the two engines' eigenvalue answers to four significant digits. The
unadjusted ANDES run must NOT match to four digits: the difference the entry
documents is real.

Markers: ``sienna`` and ``integration``; skipped where the Sienna engine is
not available, as ``test_engines_agree.py`` is.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

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
