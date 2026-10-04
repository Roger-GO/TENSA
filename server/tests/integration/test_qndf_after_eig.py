"""QNDF after an eigenvalue analysis, and when it is refused.

ANDES builds its integrator, and QNDF's step history, in ``TDS.init()``, and
skips ``init()`` once it has run. ``EIG.run()`` calls ``init()`` and takes no
step, so a QNDF request that follows an eigenvalue analysis used to be refused
with a message about a previous time-domain run. The wrapper now builds the
history itself while nothing has stepped, and the refusal that remains names its
real cause: the System has already taken steps, in a run or in a snapshot taken
after one.

Markers: ``integration``. These run ANDES's bundled IEEE 14 case for real.
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
from tensa.core.errors import SetupFailedError
from tensa.core.session import SessionManager
from tensa.core.wrapper import Wrapper

OVERRIDES = {"rtol": 1e-4, "atol": 1e-7, "max_step": 0.05}


def _ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


def _loaded(*, dyr: bool = True) -> Wrapper:
    w = Wrapper()
    cases = _ieee14_dir()
    w.load_case(cases / "ieee14.raw", addfiles=[cases / "ieee14.dyr"] if dyr else None)
    return w


def _after_eig(*, dyr: bool = True) -> Wrapper:
    w = _loaded(dyr=dyr)
    w.run_pflow()
    w.run_eig()
    ss = w._require_loaded()  # noqa: SLF001
    assert ss.TDS.initialized
    assert float(ss.dae.t) == 0.0
    assert int(ss.dae.kcount) == 0
    return w


def _final_states(w: Wrapper) -> np.ndarray:
    ss = w._require_loaded()  # noqa: SLF001
    return np.array(ss.dae.x[: ss.dae.n], dtype=float)


@pytest.mark.integration
def test_qndf_runs_after_an_eigenvalue_analysis() -> None:
    w = _after_eig()
    ss = w._require_loaded()  # noqa: SLF001
    assert type(ss.TDS.method).__name__ == "Trapezoid"

    result = w.run_tds(tf=1.0, integrator="qndf", tds_config_overrides=OVERRIDES)

    assert result.final_t == pytest.approx(1.0)
    assert type(ss.TDS.method).__name__ == "QNDF"
    assert ss.TDS.qndf_cache is not None
    assert int(ss.TDS.config.fixt) == 0


@pytest.mark.integration
def test_qndf_after_eig_reaches_the_state_a_fresh_qndf_run_does() -> None:
    """Rebuilding the history is not a different integrator: both routes end at
    the same operating point to well inside the solver tolerance."""
    fresh = _loaded()
    fresh.run_pflow()
    fresh.run_tds(tf=1.0, integrator="qndf", tds_config_overrides=OVERRIDES)

    after_eig = _after_eig()
    after_eig.run_tds(tf=1.0, integrator="qndf", tds_config_overrides=OVERRIDES)

    np.testing.assert_allclose(_final_states(after_eig), _final_states(fresh), atol=1e-6)


@pytest.mark.integration
def test_qndf_history_takes_the_overridden_tolerances() -> None:
    """The history copies ``abstol`` and ``reltol`` when it is built, as ANDES's
    own ``init()`` does after the overrides are in place."""
    w = _after_eig()
    w.run_tds(tf=0.3, integrator="qndf", tds_config_overrides={"rtol": 1e-5, "atol": 1e-8})
    cache = w._require_loaded().TDS.qndf_cache  # noqa: SLF001
    assert cache.reltol == pytest.approx(1e-5)
    assert cache.abstol == pytest.approx(1e-8)


@pytest.mark.integration
def test_qndf_after_eig_can_run_again_and_go_back_to_trapezoidal() -> None:
    w = _after_eig()
    w.run_tds(tf=0.5, integrator="qndf", tds_config_overrides=OVERRIDES)
    resumed = w.run_tds(tf=1.0, integrator="qndf")
    assert resumed.final_t == pytest.approx(1.0)

    w.run_tds(tf=1.5, h=0.01, integrator="trapezoidal")
    ss = w._require_loaded()  # noqa: SLF001
    assert type(ss.TDS.method).__name__ == "Trapezoid"
    assert int(ss.TDS.config.fixt) == 1


@pytest.mark.integration
def test_qndf_is_refused_once_the_system_has_stepped() -> None:
    """A trapezoidal run took steps: the integrator cannot be swapped any more,
    and the message names that cause, not an eigenvalue analysis."""
    w = _loaded()
    w.run_pflow()
    w.run_tds(tf=0.3, h=0.01)

    with pytest.raises(SetupFailedError) as refused:
        w.check_tds_request("qndf")
    message = str(refused.value)
    assert "taken time-domain steps" in message
    assert "snapshot" in message
    assert "eigenvalue" not in message


@pytest.mark.integration
def test_qndf_is_refused_after_a_trapezoidal_run_that_followed_eig() -> None:
    w = _after_eig()
    w.run_tds(tf=0.3, h=0.01)
    with pytest.raises(SetupFailedError, match="taken time-domain steps"):
        w.run_tds(tf=0.6, integrator="qndf")


@pytest.mark.integration
def test_qndf_after_eig_without_dynamic_data_is_refused_up_front() -> None:
    """With no differential equations ANDES's QNDF cannot run at all. The refusal
    comes from the check, before any configuration is written."""
    w = _after_eig(dyr=False)
    cfg = w._require_loaded().TDS.config  # noqa: SLF001
    before = (cfg.method, int(cfg.fixt), float(cfg.tstep), float(cfg.tf))

    with pytest.raises(SetupFailedError, match="at least one differential equation"):
        w.run_tds(tf=0.5, integrator="qndf")
    assert (cfg.method, int(cfg.fixt), float(cfg.tstep), float(cfg.tf)) == before
    assert type(w._require_loaded().TDS.method).__name__ == "Trapezoid"  # noqa: SLF001


@pytest.mark.integration
def test_streaming_qndf_after_eig_is_labelled_variable_step() -> None:
    """The streaming handler checks the request, then announces it: after an
    eigenvalue analysis it now starts a QNDF stream instead of refusing."""
    w = _after_eig()
    sent: list[dict[str, Any]] = []

    class _Pipe:
        def send(self, message: dict[str, Any]) -> None:
            sent.append(message)

    worker._handle_run_tds(
        w,
        {
            "tf": 0.3,
            "stream": True,
            "integrator": "qndf",
            "decimation": "mean",
            "max_rate_hz": 10.0,
        },
        threading.Event(),
        _Pipe(),  # type: ignore[arg-type]
        seq=1,
    )
    starts = [m for m in sent if m["type"] == "stream_start"]
    assert len(starts) == 1
    assert starts[0]["metadata"]["decimation"]["fixed_step"] is False
    assert any(m["type"] == "stream_frame" for m in sent)


# ---- over REST ---------------------------------------------------------------


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for name in ("ieee14.raw", "ieee14.dyr"):
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
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as ac:
            yield ac
    finally:
        await mgr.shutdown()


@pytest.mark.integration
async def test_rest_qndf_run_after_eig_succeeds(client: httpx.AsyncClient) -> None:
    created = await client.post("/api/sessions")
    sid = str(created.json()["session_id"])
    loaded = await client.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert loaded.status_code in (200, 201), loaded.text
    pflow = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pflow.status_code == 200, pflow.text
    eig = await client.post(f"/api/sessions/{sid}/eig", json={})
    assert eig.status_code == 200, eig.text

    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 1.0, "integrator": "qndf", "tds_config_overrides": OVERRIDES},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["final_t"] == pytest.approx(1.0)
