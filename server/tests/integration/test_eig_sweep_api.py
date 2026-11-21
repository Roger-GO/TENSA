"""Integration tests for ``POST /sessions/{id}/eig/sweep`` (root loci data).

The case is ANDES's IEEE 14 with its dyr, as in ``test_eig_api.py``, driven
through the app and a real worker. What matters most is the first test: the
eigenvalues at each value equal those of a System read afresh with that value
set before ``setup()``. Changing the parameter on a set-up System and taking the
state matrix again (ANDES's ``EIG.sweep``) does not give that after the first
value, since ``TDS.init()`` does nothing on a System already initialised.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager


def _ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for name in ["ieee14.raw", "ieee14.dyr"]:
        shutil.copy2(_ieee14_dir() / name, workspace / name)
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
            transport=transport, base_url="http://127.0.0.1:8000", timeout=300.0
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _session(client: httpx.AsyncClient, *, pflow: bool = True) -> str:
    created = await client.post("/api/sessions")
    assert created.status_code == 201, created.text
    sid = str(created.json()["session_id"])
    loaded = await client.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert loaded.status_code == 200, loaded.text
    if pflow:
        await _pflow(client, sid)
    return sid


async def _pflow(client: httpx.AsyncClient, sid: str) -> None:
    resp = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["converged"] is True


async def _sweep(
    client: httpx.AsyncClient, sid: str, body: dict[str, Any]
) -> httpx.Response:
    return await client.post(f"/api/sessions/{sid}/eig/sweep", json=body)


def _fresh_eigenvalues(edits: dict[tuple[str, str, str], float]) -> list[complex]:
    """``EIG.mu`` of IEEE 14 read afresh, each ``(model, idx, param)`` of
    ``edits`` written before ``setup()``."""
    import andes

    case = _ieee14_dir()
    ss = andes.load(
        str(case / "ieee14.raw"),
        addfile=str(case / "ieee14.dyr"),
        setup=False,
        no_output=True,
        default_config=True,
    )
    for (model, idx, param), value in edits.items():
        position = list(ss.models[model].idx.v).index(idx)
        getattr(ss.models[model], param).v[position] = value
    assert ss.setup()
    ss.PFlow.run()
    assert ss.PFlow.converged
    ss.EIG.run()
    return [complex(z) for z in ss.EIG.mu]


def _spectrum(eigenvalues: Sequence[dict[str, float]]) -> list[complex]:
    return [complex(z["real"], z["imag"]) for z in eigenvalues]


def _assert_same_spectrum(got: list[complex], want: list[complex]) -> None:
    """The two lists hold the same eigenvalues, in whatever order, to within
    what the zero-eigenvalue cleaning moves one by (1e-6) and rounding."""
    assert len(got) == len(want)
    left = list(want)
    for z in got:
        nearest = min(range(len(left)), key=lambda i: abs(left[i] - z))
        assert abs(left[nearest] - z) <= 1e-6 + 1e-9 * abs(z), (z, left[nearest])
        left.pop(nearest)


def _distance(a: list[complex], b: list[complex]) -> float:
    """How far the nearest match of each eigenvalue of ``a`` in ``b`` is, at most."""
    return max(min(abs(z - w) for w in b) for z in a)


# ---- each point is the case read with the value -----------------------------


@pytest.mark.integration
async def test_each_point_equals_a_system_read_with_that_value(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client)
    values = [4.0, 8.0, 16.0]  # GENROU_1 holds M = 8

    resp = await _sweep(
        client, sid, {"model": "GENROU", "idx": "GENROU_1", "param": "M", "values": values}
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["model"], body["idx"], body["param"]) == ("GENROU", "GENROU_1", "M")
    assert body["job_id"]
    assert [p["value"] for p in body["points"]] == values
    spectra = []
    for point, value in zip(body["points"], values, strict=True):
        assert len(point["eigenvalues"]) == body["mode_count"]
        assert len(point["damping_ratios"]) == body["mode_count"]
        assert len(point["frequencies_hz"]) == body["mode_count"]
        spectrum = _spectrum(point["eigenvalues"])
        _assert_same_spectrum(spectrum, _fresh_eigenvalues({("GENROU", "GENROU_1", "M"): value}))
        spectra.append(spectrum)
    # The value reached the computation: a mode moved between every two points.
    assert _distance(spectra[0], spectra[1]) > 0.1
    assert _distance(spectra[1], spectra[2]) > 0.1


@pytest.mark.integration
async def test_a_point_carries_the_sessions_edits_and_its_value_is_on_the_devices_base(
    client: httpx.AsyncClient,
) -> None:
    """With the machine rated 200 MVA on the 100 MVA system, ``M`` on its own
    base is half of it on the system's: a point is the case read with the edit
    and the value, as an edit of ``M`` would write it."""
    sid = await _session(client, pflow=False)
    edited = await client.put(
        f"/api/sessions/{sid}/elements/GENROU/GENROU_2", json={"params": {"Sn": 200.0}}
    )
    assert edited.status_code == 200, edited.text
    await _pflow(client, sid)

    resp = await _sweep(
        client, sid, {"model": "GENROU", "idx": "GENROU_2", "param": "M", "values": [5.0]}
    )

    assert resp.status_code == 200, resp.text
    got = _spectrum(resp.json()["points"][0]["eigenvalues"])
    _assert_same_spectrum(
        got,
        _fresh_eigenvalues(
            {("GENROU", "GENROU_2", "Sn"): 200.0, ("GENROU", "GENROU_2", "M"): 5.0}
        ),
    )
    # Neither the case without the edit nor the value taken on the system base.
    assert _distance(got, _fresh_eigenvalues({("GENROU", "GENROU_2", "M"): 5.0})) > 0.1
    on_system_base = _fresh_eigenvalues(
        {("GENROU", "GENROU_2", "Sn"): 200.0, ("GENROU", "GENROU_2", "M"): 2.5}
    )
    assert _distance(got, on_system_base) > 0.1


# ---- the session is left as it was ------------------------------------------


@pytest.mark.integration
async def test_the_session_can_run_a_power_flow_and_an_eigenvalue_analysis_after_a_sweep(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client)

    swept = await _sweep(
        client, sid, {"model": "GENROU", "idx": "GENROU_1", "param": "M", "values": [2.0, 30.0]}
    )
    assert swept.status_code == 200, swept.text
    assert swept.json()["tds_initialized"] is False

    # The sweep did not initialise the session's dynamic state, so a power flow
    # still runs, and the analysis that follows is the case's own, with M = 8.
    await _pflow(client, sid)
    after = await client.post(f"/api/sessions/{sid}/eig", json={})
    assert after.status_code == 200, after.text
    _assert_same_spectrum(_spectrum(after.json()["eigenvalues"]), _fresh_eigenvalues({}))


@pytest.mark.integration
async def test_a_sweep_after_an_eigenvalue_analysis_leaves_its_result_alone(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client)
    before = await client.post(f"/api/sessions/{sid}/eig", json={})
    assert before.status_code == 200, before.text
    matrix_before = await client.get(f"/api/sessions/{sid}/eig/state-matrix.mat")
    assert matrix_before.status_code == 200

    swept = await _sweep(
        client, sid, {"model": "GENROU", "idx": "GENROU_1", "param": "M", "values": [2.0, 30.0]}
    )
    assert swept.status_code == 200, swept.text
    assert swept.json()["tds_initialized"] is True  # the analysis before did that

    matrix_after = await client.get(f"/api/sessions/{sid}/eig/state-matrix.mat")
    assert matrix_after.status_code == 200
    # The file's header carries the time it was written; the arrays are the test.
    from io import BytesIO

    import numpy as np
    from scipy.io import loadmat  # type: ignore[import-untyped]

    held_before = loadmat(BytesIO(matrix_before.content))
    held_after = loadmat(BytesIO(matrix_after.content))
    for name in ("As", "mu"):
        assert np.array_equal(held_before[name], held_after[name])
    after = await client.post(f"/api/sessions/{sid}/eig", json={})
    assert after.status_code == 200, after.text
    _assert_same_spectrum(
        _spectrum(after.json()["eigenvalues"]), _spectrum(before.json()["eigenvalues"])
    )


@pytest.mark.integration
async def test_a_point_that_fails_is_a_422_and_leaves_the_session_usable(
    client: httpx.AsyncClient,
) -> None:
    """A load of 2000 MW has no power-flow solution: the sweep stops there,
    names the value, and the session runs as before."""
    sid = await _session(client)

    resp = await _sweep(
        client, sid, {"model": "PQ", "idx": "PQ_1", "param": "p0", "values": [0.3, 20.0, 0.4]}
    )

    assert resp.status_code == 422, resp.text
    assert "20.0 (point 1)" in resp.json()["detail"]
    assert "did not converge" in resp.json()["detail"]
    await _pflow(client, sid)
    after = await client.post(f"/api/sessions/{sid}/eig", json={})
    assert after.status_code == 200, after.text
    _assert_same_spectrum(_spectrum(after.json()["eigenvalues"]), _fresh_eigenvalues({}))


# ---- refusals ---------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.parametrize(
    "target",
    [
        {"model": "NOPE", "idx": "GENROU_1", "param": "M"},
        {"model": "GENROU", "idx": "GENROU_99", "param": "M"},
        {"model": "GENROU", "idx": "GENROU_1", "param": "NOPE"},
        {"model": "GENROU", "idx": "GENROU_1", "param": "bus"},  # a reference, not a number
        {"model": "config", "idx": "GENROU_1", "param": "M"},  # a System attribute, not a model
    ],
)
async def test_an_unknown_target_is_a_404(
    client: httpx.AsyncClient, target: dict[str, str]
) -> None:
    sid = await _session(client)
    resp = await _sweep(client, sid, {**target, "values": [1.0]})
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
@pytest.mark.parametrize(
    "body",
    [
        # The device does not exist: a body the schema let through would reach
        # the worker and come back 404, so a 422 here is the schema's own.
        '{"model": "GENROU", "idx": "GENROU_99", "param": "M", "values": []}',
        '{"model": "GENROU", "idx": "GENROU_99", "param": "M", "values": ['
        + ", ".join(["1.0"] * 201)
        + "]}",
        '{"model": "GENROU", "idx": "GENROU_99", "param": "M", "values": [1.0, NaN]}',
        '{"model": "GENROU", "idx": "GENROU_99", "param": "M", "values": [Infinity]}',
        '{"model": "GENROU", "idx": "GENROU_99", "param": "M", "values": [1.0], "surprise": 1}',
        '{"model": "GENROU", "idx": "GENROU_99", "values": [1.0]}',
    ],
)
async def test_a_body_out_of_bounds_is_a_422(client: httpx.AsyncClient, body: str) -> None:
    sid = await _session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/eig/sweep",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_200_values_are_accepted_by_the_body(client: httpx.AsyncClient) -> None:
    """The cap is the body's 200, not fewer: a request at it reaches the
    worker, which refuses the device here so as not to run 200 points."""
    sid = await _session(client)
    resp = await _sweep(
        client,
        sid,
        {"model": "GENROU", "idx": "GENROU_99", "param": "M", "values": [1.0] * 200},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_without_a_power_flow_the_sweep_is_a_409(client: httpx.AsyncClient) -> None:
    sid = await _session(client, pflow=False)
    resp = await _sweep(
        client, sid, {"model": "GENROU", "idx": "GENROU_1", "param": "M", "values": [1.0]}
    )
    assert resp.status_code == 409, resp.text
    # Nothing was set up: the case still takes disturbances.
    fault = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}]},
    )
    assert fault.status_code in (200, 201), fault.text
