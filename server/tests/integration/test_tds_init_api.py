"""Initialising the time-domain run without running it: ``Wrapper.init_tds`` and
``POST /sessions/{id}/tds/init``.

Run on ANDES's bundled Kundur and IEEE 14 cases, through the wrapper in this
process and through the route with a real worker. A case is made to fail its
initialisation the way a user would: the lower limit of a governor is raised
above the mechanical power its machine has to give (TGOV1 ``VMIN`` = 0.99 pu on
Kundur, where the machine gives 0.81), which ANDES does not move, so the lag
starts clamped and its lead-lag keeps a residual.

What a run that follows an initialisation does is held to what the same run
does from scratch: the same steps and values, the record without its row at
0 s, the same verdict when the initialisation failed, and the same eigenvalues
from an analysis after it.

Markers: ``integration``.
"""

from __future__ import annotations

import shutil
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest

from tensa.api.app import make_app
from tensa.core import worker
from tensa.core.disturbance import FaultSpec
from tensa.core.errors import SetupFailedError
from tensa.core.session import SessionManager
from tensa.core.wrapper import Wrapper

pytestmark = [
    pytest.mark.integration,
    # The eigenvalue routine warns about the conditioning of the state matrix
    # when it runs in this process (a worker's warnings never reach pytest).
    pytest.mark.filterwarnings("ignore:An ill-conditioned matrix detected"),
]

RECORDED = ["omega GENROU 1", "v Bus 4", "delta GENROU 2"]


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _kundur(*, vmin: float | None = None) -> Wrapper:
    w = Wrapper()
    w.load_case(_cases() / "kundur" / "kundur_full.xlsx")
    if vmin is not None:
        w.edit_element("TGOV1", "1", {"VMIN": vmin})
    return w


def _ieee14(*, dyr: bool = True, fault: bool = True) -> Wrapper:
    cases = _cases() / "ieee14"
    w = Wrapper()
    w.load_case(cases / "ieee14.raw", addfiles=[cases / "ieee14.dyr"] if dyr else None)
    if fault:
        w.add_disturbance(FaultSpec(bus_idx=4, tf=0.2, tc=0.3))
    return w


def _batch(w: Wrapper, tf: float = 1.0) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    result = worker._handle_run_tds(  # noqa: SLF001
        w, {"tf": tf, "dae_vars": RECORDED}, threading.Event()
    )
    traces = result["traces"]
    values = np.column_stack([np.array(v["values"], dtype=float) for v in traces["variables"]])
    return result, np.array(traces["t"], dtype=float), values


# ---- the wrapper, in this process ------------------------------------------


def test_a_healthy_case_initialises_and_takes_no_step() -> None:
    w = _kundur()
    ss = w._require_loaded()  # noqa: SLF001
    assert not ss.is_setup
    result = w.init_tds()
    assert result.initialized is True
    assert result.test_ok is True
    assert result.test_init is True
    assert result.n_states == int(ss.dae.n) > 0
    assert result.clamped == []
    assert result.residuals == []
    assert result.max_residual < float(ss.TDS.config.tol)
    # Set up, power flow solved, initialised, and not a step taken.
    assert ss.is_setup
    assert ss.PFlow.converged
    assert ss.TDS.initialized
    assert float(ss.dae.t) == 0.0
    assert int(ss.dae.kcount) == 0
    assert len(ss.dae.ts.t) == 0


def test_a_run_after_init_solves_the_steps_a_run_from_scratch_does() -> None:
    fresh = _ieee14()
    fresh_result, fresh_t, fresh_values = _batch(fresh)

    after = _ieee14()
    after.init_tds()
    after_result, after_t, after_values = _batch(after)

    assert fresh_result["converged"] is True
    assert after_result["converged"] is True
    # The run from scratch stores the initial values at 0 s; the run that
    # carries on from the initialisation starts at its first step.
    assert fresh_t[0] == 0.0
    assert after_t.tolist() == fresh_t[1:].tolist()
    np.testing.assert_allclose(after_values, fresh_values[1:], rtol=0, atol=1e-9)
    # The fault is in both, at the same instants.
    assert np.ptp(after_values[:, 0]) > 1e-3


def test_a_case_with_no_dynamic_models_is_refused() -> None:
    w = _ieee14(dyr=False, fault=True)
    with pytest.raises(SetupFailedError, match="no dynamic models"):
        w.init_tds()
    assert not w._require_loaded().TDS.initialized  # noqa: SLF001


def test_a_second_init_is_refused_and_so_is_an_init_after_a_run() -> None:
    w = _kundur()
    w.init_tds()
    with pytest.raises(SetupFailedError, match="already initialised"):
        w.init_tds()
    ran = _kundur()
    ran.run_tds(tf=0.1)
    with pytest.raises(SetupFailedError, match="already initialised"):
        ran.init_tds()


def test_a_failed_initialisation_names_the_clamp_and_the_residual() -> None:
    w = _kundur(vmin=0.99)
    result = w.init_tds()
    ss = w._require_loaded()  # noqa: SLF001
    assert result.initialized is True
    assert result.test_ok is False
    assert result.max_residual > 1.0
    assert result.nan_residuals == 0
    assert [(c.model, c.idx, c.var, c.limit_name) for c in result.clamped] == [
        ("TGOV1", "1", "LAG_y", "VMIN")
    ]
    clamp = result.clamped[0]
    # On the system base: 0.99 pu of the machine's 900 MVA is 8.91 pu of 100 MVA,
    # above the 7.27 pu the machine has to give.
    assert clamp.limit_val == pytest.approx(8.91)
    assert clamp.unconstr == pytest.approx(7.268, abs=1e-3)
    assert [r.name for r in result.residuals] == ["LL_y TGOV1 1"]
    residual = result.residuals[0]
    assert residual.mismatch == pytest.approx(result.max_residual)
    assert "LAG_y" in residual.equation
    # The test that failed added to the code, as ANDES does.
    assert ss.exit_code == 1


def test_the_test_off_still_names_what_did_not_initialise() -> None:
    w = _kundur(vmin=0.99)
    ss = w._require_loaded()  # noqa: SLF001
    result = w.init_tds(test_init=False)
    assert result.test_init is False
    assert result.test_ok is None
    assert [r.name for r in result.residuals] == ["LL_y TGOV1 1"]
    assert [c.var for c in result.clamped] == ["LAG_y"]
    # The case's own setting is back.
    assert ss.TDS.config.test_init == 1


def test_a_run_after_a_failed_initialisation_is_not_converged_as_from_scratch() -> None:
    fresh = _kundur(vmin=0.99).run_tds(tf=0.5)
    w = _kundur(vmin=0.99)
    assert w.init_tds().test_ok is False
    after = w.run_tds(tf=0.5)
    assert fresh.converged is False
    assert after.converged is False
    assert after.final_t == fresh.final_t == 0.5
    # Only the run that starts from the failed initialisation carries it.
    assert w.run_tds(tf=0.7).converged is True


def test_an_eigenvalue_analysis_after_init_matches_one_without() -> None:
    def eigenvalues(w: Wrapper) -> np.ndarray:
        return np.array(sorted((z.real, z.imag) for z in w.run_eig().eigenvalues))

    alone = _kundur()
    alone.run_pflow()
    reference = eigenvalues(alone)
    for test_init in (True, False):
        w = _kundur()
        w.init_tds(test_init=test_init)
        np.testing.assert_allclose(eigenvalues(w), reference, rtol=0, atol=1e-9)


def test_qndf_after_init_reaches_the_state_a_fresh_qndf_run_does() -> None:
    overrides = {"rtol": 1e-4, "atol": 1e-7, "max_step": 0.05}
    fresh = _kundur()
    fresh.run_tds(tf=1.0, integrator="qndf", tds_config_overrides=overrides)
    after = _kundur()
    after.init_tds()
    result = after.run_tds(tf=1.0, integrator="qndf", tds_config_overrides=overrides)
    assert result.converged is True
    np.testing.assert_allclose(
        np.asarray(after._require_loaded().dae.x),  # noqa: SLF001
        np.asarray(fresh._require_loaded().dae.x),  # noqa: SLF001
        atol=1e-6,
    )


# ---- the route, with a real worker -----------------------------------------


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _cases()
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    shutil.copy2(cases / "kundur" / "kundur_full.xlsx", workspace / "kundur_full.xlsx")
    for name in ("ieee14.raw", "ieee14.dyr"):
        shutil.copy2(cases / "ieee14" / name, workspace / name)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _session(
    client: httpx.AsyncClient, path: str, addfiles: list[str] | None = None
) -> str:
    created = await client.post("/api/sessions")
    assert created.status_code == 201, created.text
    sid = str(created.json()["session_id"])
    body: dict[str, Any] = {"primary_path": path}
    if addfiles:
        body["addfiles"] = addfiles
    loaded = await client.post(f"/api/sessions/{sid}/case", json=body)
    assert loaded.status_code == 200, loaded.text
    return sid


async def _failing_kundur(client: httpx.AsyncClient) -> str:
    sid = await _session(client, "kundur_full.xlsx")
    edited = await client.put(
        f"/api/sessions/{sid}/elements/TGOV1/1", json={"params": {"VMIN": 0.99}}
    )
    assert edited.status_code == 200, edited.text
    return sid


async def test_route_on_a_healthy_case_and_the_state_it_leaves(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client, "kundur_full.xlsx")
    resp = await client.post(f"/api/sessions/{sid}/tds/init")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initialized"] is True
    assert body["test_ok"] is True
    assert body["test_init"] is True
    assert body["n_states"] > 0
    assert body["n_algeb"] > 0
    assert body["clamped"] == []
    assert body["residuals"] == []
    assert body["diagnostics_truncated"] is False

    # The case is set up: closed to disturbances and edits until a reload.
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert topology["state"] == "committed"
    added = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1}]},
    )
    assert added.status_code == 409, added.text

    # A run carries on from the initialisation.
    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2})
    assert run.status_code == 200, run.text
    assert run.json()["converged"] is True
    assert run.json()["final_t"] == pytest.approx(0.2)

    # After a reload the case can be initialised again.
    reloaded = await client.post(f"/api/sessions/{sid}/reload")
    assert reloaded.status_code == 200, reloaded.text
    again = await client.post(f"/api/sessions/{sid}/tds/init", json={"test_init": True})
    assert again.status_code == 200, again.text


async def test_route_a_run_after_init_records_the_steps_of_a_fresh_run(
    client: httpx.AsyncClient,
) -> None:
    fault = {"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 0.2, "tc": 0.3}]}
    traces = {}
    for name in ("fresh", "after"):
        sid = await _session(client, "ieee14.raw", ["ieee14.dyr"])
        added = await client.post(f"/api/sessions/{sid}/disturbances", json=fault)
        assert added.status_code in (200, 201), added.text
        if name == "after":
            init = await client.post(f"/api/sessions/{sid}/tds/init")
            assert init.status_code == 200, init.text
        run = await client.post(
            f"/api/sessions/{sid}/tds", json={"tf": 0.6, "dae_vars": RECORDED}
        )
        assert run.status_code == 200, run.text
        assert run.json()["converged"] is True
        traces[name] = run.json()["traces"]
    fresh_t, after_t = traces["fresh"]["t"], traces["after"]["t"]
    assert fresh_t[0] == 0.0
    assert after_t == fresh_t[1:]
    for fresh_var, after_var in zip(
        traces["fresh"]["variables"], traces["after"]["variables"], strict=True
    ):
        assert fresh_var["name"] == after_var["name"]
        np.testing.assert_allclose(after_var["values"], fresh_var["values"][1:], atol=1e-9)


async def test_route_a_failed_initialisation_is_reported_and_logged(
    client: httpx.AsyncClient,
) -> None:
    sid = await _failing_kundur(client)
    resp = await client.post(f"/api/sessions/{sid}/tds/init")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initialized"] is True
    assert body["test_ok"] is False
    assert body["max_residual"] > 1.0
    assert body["clamped"] == [
        {
            "model": "TGOV1",
            "idx": "1",
            "var": "LAG_y",
            "limit_name": "VMIN",
            "limit_val": pytest.approx(8.91),
            "unconstr": pytest.approx(7.268, abs=1e-3),
        }
    ]
    assert [r["name"] for r in body["residuals"]] == ["LL_y TGOV1 1"]
    assert body["residuals"][0]["mismatch"] == pytest.approx(body["max_residual"])

    # What ANDES logged reached the session's messages, under this command.
    messages = (await client.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    mine = [m for m in messages if m["source"] == "init_tds"]
    texts = "\n".join(m["text"] for m in mine)
    assert "Variables clamped at limits during initialization" in texts
    assert "Equations with nonzero residuals" in texts
    assert "Initialization FAILED" in texts
    assert any(m["level"] == "error" for m in mine)
    notices = [m["text"] for m in mine if m["logger"] == "tensa.notice"]
    assert notices == [
        f"tds init: initialised {body['n_states']} states, {body['n_algeb']} "
        "algebraic variables; initialisation test failed"
    ]
    # ANDES names the case file by its full path; the server's paths stay out.
    assert str(_cases()) not in texts

    # The run that follows reports what the same run from scratch does.
    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2})
    assert run.status_code == 200, run.text
    assert run.json()["converged"] is False
    fresh_sid = await _failing_kundur(client)
    fresh = await client.post(f"/api/sessions/{fresh_sid}/tds", json={"tf": 0.2})
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["converged"] is False


async def test_route_with_the_test_off(client: httpx.AsyncClient) -> None:
    sid = await _failing_kundur(client)
    resp = await client.post(f"/api/sessions/{sid}/tds/init", json={"test_init": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initialized"] is True
    assert body["test_ok"] is None
    assert body["test_init"] is False
    # Not a clean bill: what the residuals show is still listed.
    assert [r["name"] for r in body["residuals"]] == ["LL_y TGOV1 1"]
    messages = (await client.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    texts = [m["text"] for m in messages if m["source"] == "init_tds"]
    assert "Initialization results were not verified." in texts
    assert any(t.endswith("initialisation test not run") for t in texts)


async def test_route_a_second_init_is_422_and_names_the_reload(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client, "kundur_full.xlsx")
    first = await client.post(f"/api/sessions/{sid}/tds/init")
    assert first.status_code == 200, first.text
    second = await client.post(f"/api/sessions/{sid}/tds/init")
    assert second.status_code == 422, second.text
    problem = second.json()
    assert "already initialised" in problem["detail"]
    assert "/reload" in problem["detail"]


async def test_route_refuses_a_case_without_dynamic_models(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client, "ieee14.raw")
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert topology["has_dynamics"] is False
    resp = await client.post(f"/api/sessions/{sid}/tds/init")
    assert resp.status_code == 422, resp.text
    assert "no dynamic models" in resp.json()["detail"]


async def test_route_refuses_a_body_it_does_not_know(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "kundur_full.xlsx")
    for body in ({"test_init": "maybe"}, {"tf": 1.0}):
        resp = await client.post(f"/api/sessions/{sid}/tds/init", json=body)
        assert resp.status_code == 422, resp.text
    # Nothing was initialised by the refused requests.
    ok = await client.post(f"/api/sessions/{sid}/tds/init")
    assert ok.status_code == 200, ok.text


async def test_route_unknown_session_is_404_and_no_case_is_409(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post("/api/sessions/nope/tds/init")
    assert resp.status_code == 404, resp.text
    created = await client.post("/api/sessions")
    sid = created.json()["session_id"]
    resp = await client.post(f"/api/sessions/{sid}/tds/init")
    assert resp.status_code == 409, resp.text
