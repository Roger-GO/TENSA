"""Integration tests for the CPF endpoints (Unit 12 of the v2.0 plan).

Drives the FastAPI app end-to-end against ANDES's bundled IEEE 14
case. Exercises:

- Happy path: full PV-curve sweep returns 200 with a strictly-positive
  lambda series and per-bus voltage rows for all 14 buses.
- 409 pre-condition: pre-PF call (substrate gates independently per
  Unit 1a spike, since ANDES's own ``CPF.init`` only logs a warning).
- Truncation: small ``max_iter`` returns 200 with ``truncated=True``
  and ``nose_idx=-1``.
- 422 path: ``/cpf/qv`` against a bus with no PQ device raises
  ``CpfDivergedError`` from the wrapper → 422 from the route.
- QV happy path: ``/cpf/qv`` for bus 5 (which has a PQ in IEEE 14)
  returns a single-bus trace.
- Session-lifecycle: unknown session id → 404.
- The settings of ``tensa.core.cpf_options`` over HTTP: the four
  directions, reactive limits (409 until the power flow is solved with
  them, then the generators and the limits they reach in the response),
  the full curve, and the same limits on the QV route.

Markers: ``integration`` — these tests load real case files and spawn
the worker subprocess. CPF runs add ~1-3 s on top of PF.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager


def _bundled_ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    for name in ["ieee14.raw"]:
        shutil.copy2(src / name, workspace / name)

    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _create_session_and_load(
    client: httpx.AsyncClient,
    primary: str = "ieee14.raw",
) -> str:
    resp = await client.post(
        "/api/sessions"
    )
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    return sid


# ---- happy path: full IEEE 14 PV-curve --------------------------------------


@pytest.mark.integration
async def test_cpf_happy_path_returns_lambda_and_bus_voltages(
    client: httpx.AsyncClient,
) -> None:
    """Per Unit 1a spike: ``CPF.run(load_scale=2.0)`` on IEEE 14 returns
    True with ~18 lambda steps, max_lam ≈ 3.258, V.shape=(14, 18).

    The integration test verifies the response shape:
    - ``lambdas`` is non-empty and strictly positive past the base case.
    - ``voltages_per_bus`` keys = the 14 bus idxes.
    - Each per-bus voltage list is index-aligned with ``lambdas``.
    - ``nose_idx > 0`` (the nose is past the base case).
    - ``truncated`` is False on the happy path.
    - ``mode`` is "pv".
    """
    sid = await _create_session_and_load(client)
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True

    resp = await client.post(
        f"/api/sessions/{sid}/cpf",
        json={"direction": "load"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["mode"] == "pv"
    assert body["truncated"] is False
    assert body["nose_idx"] > 0
    # The lambda series climbs (with possible final overshoot past the
    # nose where lambda decreases briefly). All values are non-negative.
    lambdas = body["lambdas"]
    assert len(lambdas) > 1
    assert lambdas[0] == pytest.approx(0.0, abs=1e-6)
    assert max(lambdas) > 1.0  # the nose for IEEE 14 is well past lambda=1
    # nose_idx points at the maximum lambda value.
    assert lambdas[body["nose_idx"]] == pytest.approx(max(lambdas))
    assert body["max_lam"] == pytest.approx(max(lambdas), rel=1e-6)

    # voltages_per_bus has all 14 bus idxes from the IEEE 14 case.
    assert len(body["voltages_per_bus"]) == 14
    assert len(body["bus_idxes"]) == 14
    for bus_key, voltages in body["voltages_per_bus"].items():
        assert len(voltages) == len(lambdas), (
            f"bus {bus_key} voltage trace length {len(voltages)} "
            f"!= lambda length {len(lambdas)}"
        )

    assert isinstance(body["done_msg"], str)
    assert "lambda" in body["done_msg"].lower() or "nose" in body["done_msg"].lower()


# ---- edge: pre-PF call → 409 (substrate-side gate) -------------------------


@pytest.mark.integration
async def test_cpf_without_pflow_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Per Unit 1a spike: ``CPF.init`` only logs a warning when PF
    hasn't converged before falling through. The substrate gates
    ``ss.PFlow.converged is True`` independently and raises
    ``CpfPrerequisiteError`` → 409 with an actionable "Run PFlow first"
    message."""
    sid = await _create_session_and_load(client)

    resp = await client.post(
        f"/api/sessions/{sid}/cpf",
        json={"direction": "load"},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    detail = body.get("detail") or ""
    assert "PFlow" in detail or "pflow" in detail.lower()


# ---- edge: truncated run (max_iter too small) ------------------------------


@pytest.mark.integration
async def test_cpf_truncated_run_returns_truncated_true(
    client: httpx.AsyncClient,
) -> None:
    """A small ``max_iter`` (mapped to ANDES's ``max_steps``) forces
    the run to terminate before reaching the nose point. The endpoint
    still returns 200 (not an error) with ``truncated=True`` and
    ``nose_idx=-1`` so the UI can surface the "did not reach nose"
    note inline rather than as an error banner."""
    sid = await _create_session_and_load(client)
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )

    resp = await client.post(
        f"/api/sessions/{sid}/cpf",
        json={"direction": "load", "max_iter": 3},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["truncated"] is True
    assert body["nose_idx"] == -1
    # done_msg surfaces ANDES's reason — typically "Reached max steps".
    assert body["done_msg"], "expected non-empty done_msg on truncation"


# ---- QV happy path --------------------------------------------------------


@pytest.mark.integration
async def test_cpf_qv_returns_single_bus_trace(
    client: httpx.AsyncClient,
) -> None:
    """QV-curve for bus 5 (which has PQ_4 attached in IEEE 14).

    Verifies:
    - 200 response with ``mode="qv"``.
    - ``voltages_per_bus`` carries exactly one bus key (the requested
      bus_idx).
    - ``bus_idxes`` matches.
    - ``lambdas`` (here = qv_q) is non-empty.
    """
    sid = await _create_session_and_load(client)
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )

    resp = await client.post(
        f"/api/sessions/{sid}/cpf/qv",
        json={"bus_idx": "5"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "qv"
    assert body["bus_idxes"] == ["5"]
    assert list(body["voltages_per_bus"].keys()) == ["5"]
    assert len(body["lambdas"]) > 1
    assert len(body["voltages_per_bus"]["5"]) == len(body["lambdas"])


# ---- QV without PFlow → 409 -----------------------------------------------


@pytest.mark.integration
async def test_cpf_qv_without_pflow_returns_409(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client)
    resp = await client.post(
        f"/api/sessions/{sid}/cpf/qv",
        json={"bus_idx": "5"},
    )
    assert resp.status_code == 409, resp.text


# ---- QV against a bus with no PQ → 422 -----------------------------------


@pytest.mark.integration
async def test_cpf_qv_against_bus_without_pq_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Bus 1 in IEEE 14 hosts a generator (PV/Slack) but no PQ load.
    ``CPF.run_qv(1)`` raises a ValueError inside ANDES; the wrapper
    forwards as ``CpfDivergedError`` → 422 with the ANDES detail."""
    sid = await _create_session_and_load(client)
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )

    resp = await client.post(
        f"/api/sessions/{sid}/cpf/qv",
        json={"bus_idx": "1"},
    )
    assert resp.status_code == 422, resp.text


# ---- request-validation: invalid direction → 422 --------------------------


@pytest.mark.integration
async def test_cpf_invalid_direction_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """The route's ``direction`` field is constrained to the four
    directions via Pydantic; any other value rejected at the
    request-validation layer."""
    sid = await _create_session_and_load(client)
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/cpf",
        json={"direction": "neither"},
    )
    assert resp.status_code == 422, resp.text


# ---- session lifecycle ----------------------------------------------------


@pytest.mark.integration
async def test_cpf_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions/does-not-exist/cpf",
        json={"direction": "load"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_cpf_qv_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions/does-not-exist/cpf/qv",
        json={"bus_idx": "5"},
    )
    assert resp.status_code == 404, resp.text


# ---- the settings of a run ---------------------------------------------------


async def _solved_session(
    client: httpx.AsyncClient, *, enforce_q_limits: bool = False
) -> str:
    sid = await _create_session_and_load(client)
    body = {"enforce_q_limits": True} if enforce_q_limits else {}
    pf = await client.post(f"/api/sessions/{sid}/pflow", json=body)
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True
    return sid


@pytest.mark.integration
async def test_cpf_response_says_what_was_run_and_carries_the_generators(
    client: httpx.AsyncClient,
) -> None:
    sid = await _solved_session(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["direction"] == "load"
    assert body["stop_at"] == "nose"
    assert body["complete"] is True
    assert body["q_limits_enforced"] is False
    assert body["limit_events"] == []
    assert [(g["model"], g["idx"]) for g in body["generators"]] == [
        ("PV", "2"),
        ("PV", "3"),
        ("PV", "4"),
        ("PV", "5"),
        ("Slack", "1"),
    ]
    for generator in body["generators"]:
        assert len(generator["q"]) == len(body["lambdas"])
        assert generator["q_max"] > generator["q_min"]


@pytest.mark.integration
@pytest.mark.parametrize("direction", ["gen", "load-only"])
async def test_cpf_generation_and_loads_only_directions_return_a_curve(
    client: httpx.AsyncClient, direction: str
) -> None:
    """``gen`` answered 422 for every request before: the routine was handed
    a number where it takes a target per generator."""
    sid = await _solved_session(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf", json={"direction": direction})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["direction"] == direction
    assert body["truncated"] is False and body["nose_idx"] > 0


@pytest.mark.integration
async def test_cpf_custom_direction_runs_and_its_job_keeps_counts_not_lists(
    client: httpx.AsyncClient,
) -> None:
    sid = await _solved_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/cpf",
        json={
            "direction": "custom",
            "load_increase": [
                {"idx": "PQ_11", "p": 10.0, "q": 3.0},
                {"idx": "PQ_10", "p": 5.0},
            ],
            "generator_increase": [{"idx": 2, "p": 15.0}],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["direction"] == "custom" and body["truncated"] is False

    job = await client.get(f"/api/sessions/{sid}/jobs/{body['job_id']}")
    assert job.status_code == 200, job.text
    summary = job.json()["request_summary"]
    assert summary["direction"] == "custom"
    assert summary["load_increase"] == 2 and summary["generator_increase"] == 1


@pytest.mark.integration
@pytest.mark.parametrize(
    "body",
    [
        {"direction": "custom"},
        {"direction": "load", "load_increase": [{"idx": "PQ_1", "p": 1.0}]},
        {"direction": "custom", "load_increase": [{"idx": "PQ_1", "p": 1.0, "dq": 2.0}]},
        {"stop_at": "lower"},
    ],
)
async def test_cpf_request_that_does_not_hold_together_returns_422(
    client: httpx.AsyncClient, body: dict[str, object]
) -> None:
    sid = await _solved_session(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf", json=body)
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
@pytest.mark.parametrize(
    ("body", "said"),
    [
        ({"load_increase": [{"idx": "PQ_99", "p": 1.0}]}, "not a PQ load"),
        ({"generator_increase": [{"idx": 1, "p": 1.0}]}, "slack generator"),
        ({"load_increase": [{"idx": "PQ_1"}]}, "nothing to increase"),
    ],
)
async def test_cpf_custom_direction_the_case_cannot_take_returns_422_without_a_recovery(
    client: httpx.AsyncClient, body: dict[str, object], said: str
) -> None:
    """The caller's to fix: no reload and no power flow makes the request right."""
    sid = await _solved_session(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf", json={"direction": "custom", **body})
    assert resp.status_code == 422, resp.text
    problem = resp.json()
    assert said in problem["detail"]
    assert problem.get("recovery") is None
    # The session is still good for a run.
    assert (await client.post(f"/api/sessions/{sid}/cpf", json={})).status_code == 200


@pytest.mark.integration
async def test_cpf_with_limits_needs_the_power_flow_solved_with_them(
    client: httpx.AsyncClient,
) -> None:
    sid = await _solved_session(client)
    refused = await client.post(f"/api/sessions/{sid}/cpf", json={"enforce_q_limits": True})
    assert refused.status_code == 409, refused.text
    problem = refused.json()
    assert "PV 2 past qmax" in problem["detail"]
    assert "reactive limits enforced first" in problem["detail"]
    assert problem["recovery"]["kind"] == "run-pflow"

    pf = await client.post(f"/api/sessions/{sid}/pflow", json={"enforce_q_limits": True})
    assert pf.status_code == 200, pf.text
    resp = await client.post(f"/api/sessions/{sid}/cpf", json={"enforce_q_limits": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["q_limits_enforced"] is True
    assert body["truncated"] is False
    # Half again the base load, where the slack runs out, not the threefold
    # of a run that lets every generator go past its limit.
    assert body["max_lam"] == pytest.approx(0.517, abs=0.003)
    for generator in body["generators"]:
        assert max(generator["q"]) <= generator["q_max"] + 0.05
    held_from_the_start = [e for e in body["limit_events"] if e["step"] == 0]
    assert [e["idx"] for e in held_from_the_start] == ["2", "3", "4", "5"]
    last = body["limit_events"][-1]
    assert (last["model"], last["idx"], last["limit"]) == ("Slack", "1", "qmax")
    assert last["at_nose"] is True
    assert last["lam"] == pytest.approx(body["lambdas"][last["step"]])
    assert all(e["would_release_step"] is None for e in body["limit_events"])

    # The worker is the same one, and the limits were for that run.
    plain = await client.post(f"/api/sessions/{sid}/cpf", json={})
    assert plain.status_code == 200, plain.text
    assert plain.json()["q_limits_enforced"] is False


@pytest.mark.integration
async def test_cpf_full_curve_returns_to_the_base_load(
    client: httpx.AsyncClient,
) -> None:
    sid = await _solved_session(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf", json={"stop_at": "full"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stop_at"] == "full" and body["complete"] is True
    lambdas = body["lambdas"]
    assert 0 < body["nose_idx"] < len(lambdas) - 1
    assert lambdas[body["nose_idx"]] == pytest.approx(max(lambdas))
    assert lambdas[-1] == pytest.approx(0.0, abs=1e-9)
    assert body["voltages_per_bus"]["14"][-1] < body["voltages_per_bus"]["14"][0]


@pytest.mark.integration
async def test_cpf_qv_takes_the_limits_too(
    client: httpx.AsyncClient,
) -> None:
    sid = await _solved_session(client)
    refused = await client.post(
        f"/api/sessions/{sid}/cpf/qv", json={"bus_idx": "5", "enforce_q_limits": True}
    )
    assert refused.status_code == 409, refused.text

    await client.post(f"/api/sessions/{sid}/pflow", json={"enforce_q_limits": True})
    resp = await client.post(
        f"/api/sessions/{sid}/cpf/qv", json={"bus_idx": "5", "enforce_q_limits": True}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "qv" and body["direction"] is None
    assert body["q_limits_enforced"] is True
    assert len(body["generators"]) == 5
    for generator in body["generators"]:
        assert len(generator["q"]) == len(body["lambdas"])
        assert max(generator["q"]) <= generator["q_max"] + 0.05
