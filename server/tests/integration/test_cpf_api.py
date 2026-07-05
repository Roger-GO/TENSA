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
    """The route's ``direction`` field is constrained to
    ``'load'|'gen'`` via Pydantic; any other value rejected at the
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
