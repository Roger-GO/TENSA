"""A time-domain run that is meant to end on ``tf`` does.

ANDES 2.0.0 ends some runs "not converged" on the very last step: IEEE 39 and
the WECC case, run to 5 s or 10 s with the default step, stop a few 1e-14 s short
of ``tf``. Three hundred steps of 1/30 s add up to 9.999999999999975 s, ANDES
clips a step only when it would pass ``tf``, so it asks for a last step of
2.5e-14 s, which the solver cannot take (it needs about 1e-7 s on these cases),
and shrinks that step to nothing: the step is clipped to the time left, which
does not change. A run to 2 s or to 20 s adds up exactly and is not affected.
``tensa.core.tds_steps.land_on_time`` has the step about to be solved end on
``tf`` instead, and every run the server makes goes through it.

These tests hold the runs the problem was seen on to it, through the wrapper,
through the REST route, through a streamed run and through a sweep, and hold a run
that really fails before ``tf`` to being reported as failed.

Markers: ``integration``.
"""

from __future__ import annotations

import ast
import contextlib
import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from threading import Event
from typing import Any

import numpy as np
import pytest
from starlette.testclient import TestClient

import tensa
from tensa.api.app import make_app
from tensa.core.disturbance import FaultSpec
from tensa.core.wrapper import Wrapper
from tests._ws import websocket_session

pytestmark = pytest.mark.integration

IEEE39 = "ieee39/ieee39_full.xlsx"
WECC = "wecc/wecc_full.xlsx"
# Runs that stop before ``tf`` for a reason that has nothing to do with it: IEEE 14
# with a generator trip leaves its stability criteria at about 3.53 s, and the SMIB
# case cannot solve its fault at 0.1 s.
GEN_TRIP = "ieee14/ieee14_gentrip.xlsx"
SMIB = "smib/SMIB.xlsx"

# The runs ANDES ends short of ``tf``, as (case, tf).
RUNS = [(IEEE39, 5.0), (IEEE39, 10.0), (WECC, 10.0)]


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _wrapper(case: str) -> Wrapper:
    w = Wrapper()
    w.load_case(_cases() / case)
    return w


# ---- the wrapper ---------------------------------------------------------------------


@pytest.mark.parametrize(("case", "tf"), RUNS)
def test_a_run_of_the_default_step_ends_on_tf(case: str, tf: float) -> None:
    w = _wrapper(case)
    seen: list[float] = []
    result = w.run_tds(tf=tf, on_step=lambda t, _system: seen.append(float(t)))

    assert result.converged is True
    assert result.final_t == tf
    assert result.callpert_count == round(tf * 30) + 1
    ss = w._require_loaded()  # noqa: SLF001
    assert ss.TDS.busted is False
    assert ss.exit_code == 0
    # ANDES stored the last step under ``tf`` itself, a default step after the
    # one before (and a few 1e-14 s more), not as a step of its own.
    stored = np.asarray(ss.dae.ts.t, dtype=float)
    assert stored[-1] == tf
    assert np.diff(stored).min() > 0.0333
    assert seen[-1] == tf


@pytest.mark.parametrize(("case", "tf"), RUNS)
def test_andes_itself_still_ends_these_runs_short_of_tf(case: str, tf: float) -> None:
    """The premise of the landing, checked on ANDES itself so the tests above
    are known to hold something: with nothing in the hook the run ends "not
    converged" a few 1e-14 s short. A release of ANDES that has mended this
    skips the test, and the landing is then no longer needed for these runs."""
    import andes

    ss = andes.load(str(_cases() / case), setup=True, no_output=True, default_config=True)
    ss.PFlow.run()
    ss.TDS.config.tf = tf
    ss.TDS.run()
    if not ss.TDS.busted:
        pytest.skip("this ANDES ends the run on tf without help")
    assert "Time step reduced to zero" in ss.TDS.err_msg
    assert 0.0 < tf - float(ss.dae.t) < 3e-14


def test_a_run_is_not_failed_by_the_exit_code_an_earlier_routine_left() -> None:
    """ANDES adds to ``exit_code`` when a continuation power flow or an eigenvalue pre-check
    fails and only a power flow sets it back, so a time-domain run that reached its end time
    cleanly in such a session was reported as not converged."""
    w = _wrapper(IEEE39)
    ss = w._require_loaded()  # noqa: SLF001
    w.run_pflow()
    ss.exit_code = 1  # what a failed CPF left behind
    result = w.run_tds(tf=1.0)

    assert result.converged is True and result.final_t == 1.0
    assert ss.exit_code == 0


def test_a_run_that_leaves_its_stability_criteria_is_still_reported_as_failed() -> None:
    w = _wrapper(GEN_TRIP)
    result = w.run_tds(tf=10.0)

    assert result.converged is False
    assert 3.4 < result.final_t < 3.7
    assert w._require_loaded().TDS.busted is True  # noqa: SLF001


def test_a_run_that_cannot_solve_its_fault_is_still_reported_as_failed() -> None:
    w = _wrapper(SMIB)
    result = w.run_tds(tf=5.0)

    assert result.converged is False
    assert result.final_t == pytest.approx(0.1)


def test_a_run_aborted_a_step_short_of_tf_is_still_reported_as_failed() -> None:
    """Stopping is not reaching: a run the abort flag ends one step before
    ``tf`` is not one the landing may report as complete."""
    w = _wrapper(IEEE39)
    abort = Event()

    def _stop_near_the_end(t: float, _system: Any) -> None:
        if float(t) > 9.9:
            abort.set()

    result = w.run_tds(tf=10.0, on_step=_stop_near_the_end, abort_flag=abort)

    assert result.converged is False
    # It stopped at the step the flag was set on (the one after 9.9 s), whether or not the
    # clock then sums to 10 exactly: what the run reports is that it did not complete.
    assert result.final_t <= 10.0 + 1e-9
    assert result.callpert_count < round(10.0 * 30) + 1


# ---- a sweep -------------------------------------------------------------------------


def test_every_iteration_of_a_sweep_ends_on_tf(tmp_path: Path) -> None:
    """The sweep reloads the case for each value and runs it with the default
    step. The fault is after the end of the run, as in the sweeps of the other
    tests, so each iteration is 15 steps of 1/30 s towards 0.5 s, which ANDES
    cannot finish."""
    cases = _cases() / "ieee14"
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    w = Wrapper(workspace=ws)
    w.load_case(cases / "ieee14.raw", addfiles=[cases / "ieee14.dyr"])
    w.add_disturbance(FaultSpec(bus_idx=5, tf=1.0, tc=1.1))
    w.run_pflow()
    w.save_snapshot("end-time")

    result = w.run_sweep(
        snapshot_name="end-time",
        parameter_kind="disturbance.fault.tc",
        parameter_target=0,
        values=[1.05, 1.1, 1.15],
        tf=0.5,
    )

    assert [it["error"] for it in result["iterations"]] == [None] * 3
    assert [it["converged"] for it in result["iterations"]] == [True] * 3
    assert [it["final_t"] for it in result["iterations"]] == [0.5] * 3


# ---- the API -------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    """A real app and worker over Starlette's ``TestClient``, on a workspace that
    holds the cases above."""
    workspace = tmp_path_factory.mktemp("end-time") / "ws"
    workspace.mkdir(mode=0o700)
    for case in (IEEE39, WECC, GEN_TRIP, SMIB):
        shutil.copy2(_cases() / case, workspace / Path(case).name)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as test_client:
        yield test_client


@contextlib.contextmanager
def _session(client: TestClient, case: str) -> Iterator[str]:
    """The id of a session with ``case`` loaded, closed afterwards."""
    created = client.post("/api/sessions")
    assert created.status_code == 201, created.text
    sid = str(created.json()["session_id"])
    try:
        loaded = client.post(
            f"/api/sessions/{sid}/case", json={"primary_path": Path(case).name}
        )
        assert loaded.status_code in (200, 201), loaded.text
        yield sid
    finally:
        client.delete(f"/api/sessions/{sid}")


def _streamed(client: TestClient, sid: str, start: dict[str, Any]) -> dict[str, Any]:
    """Run ``start_tds`` over the WebSocket and return its ``done`` frame."""
    frames = 0
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", **start}))
        while True:
            message = ws.receive()
            if message.get("bytes") is not None:
                frames += 1
                continue
            frame: dict[str, Any] = json.loads(message["text"])
            if frame["type"] in ("done", "error"):
                break
    assert frames > 0
    return frame


@pytest.mark.parametrize(("case", "tf"), RUNS)
def test_post_tds_of_the_default_step_ends_on_tf(
    client: TestClient, case: str, tf: float
) -> None:
    with _session(client, case) as sid:
        response = client.post(f"/api/sessions/{sid}/tds", json={"tf": tf})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["converged"] is True
    assert body["final_t"] == tf
    assert body["callpert_count"] == round(tf * 30) + 1


def test_a_streamed_run_to_10_s_with_the_default_step_ends_on_tf(client: TestClient) -> None:
    """What the UI starts: ``tf`` 10 s and no step."""
    with _session(client, IEEE39) as sid:
        done = _streamed(client, sid, {"tf": 10.0, "vars": ["bus_v"]})

    assert done["type"] == "done", done
    assert done["converged"] is True
    assert done["final_t"] == 10.0


def test_post_tds_reports_a_run_that_left_its_stability_criteria(client: TestClient) -> None:
    with _session(client, GEN_TRIP) as sid:
        response = client.post(f"/api/sessions/{sid}/tds", json={"tf": 10.0})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["converged"] is False
    assert 3.4 < body["final_t"] < 3.7


def test_a_streamed_run_reports_one_that_left_its_stability_criteria(
    client: TestClient,
) -> None:
    with _session(client, GEN_TRIP) as sid:
        done = _streamed(client, sid, {"tf": 10.0, "vars": ["bus_v"]})

    assert done["type"] == "done", done
    assert done["converged"] is False
    assert 3.4 < done["final_t"] < 3.7


def test_post_tds_reports_a_run_that_cannot_solve_its_fault(client: TestClient) -> None:
    with _session(client, SMIB) as sid:
        response = client.post(f"/api/sessions/{sid}/tds", json={"tf": 5.0})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["converged"] is False
    assert body["final_t"] == pytest.approx(0.1)


# ---- every run goes through the one hook ---------------------------------------------


def _is_tds_routine(node: ast.expr) -> bool:
    """``<x>.TDS`` or ``getattr(<x>, "TDS")``: the routine of a system."""
    if isinstance(node, ast.Attribute):
        return node.attr == "TDS"
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "getattr"
        and len(node.args) >= 2
        and isinstance(node.args[1], ast.Constant)
        and node.args[1].value == "TDS"
    )


def _runs_and_hooks(source: str) -> tuple[bool, bool]:
    """Whether a module runs the time-domain routine, and whether it sets a
    ``callpert`` hook, in any of the forms that do it: ``<x>.TDS.run()``, a name
    bound to the routine (``tds = ss.TDS; tds.run()``), ``getattr(ss, "TDS")``,
    ``andes.run(...)`` (which takes the routine by name), and a hook set by an
    assignment, an annotated or augmented one, or ``setattr``."""
    tree = ast.parse(source)
    aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and _is_tds_routine(node.value):
            aliases |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        if (
            isinstance(node, ast.AnnAssign)
            and node.value is not None
            and isinstance(node.target, ast.Name)
            and _is_tds_routine(node.value)
        ):
            aliases.add(node.target.id)
    runs = hooks = False
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "run"
        ):
            holder = node.func.value
            if (
                _is_tds_routine(holder)
                or (isinstance(holder, ast.Name) and holder.id in aliases)
                or (isinstance(holder, ast.Name) and holder.id == "andes")
            ):
                runs = True
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign | ast.AugAssign):
            targets = [node.target]
        if any(isinstance(t, ast.Attribute) and t.attr == "callpert" for t in targets):
            hooks = True
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "setattr"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value == "callpert"
        ):
            hooks = True
    return runs, hooks


@pytest.mark.parametrize(
    "source, runs, hooks",
    [
        ("ss.TDS.run()", True, False),
        ("tds = ss.TDS\ntds.run()", True, False),
        ("tds: Any = getattr(ss, 'TDS')\ntds.run()", True, False),
        ("getattr(ss, 'TDS').run()", True, False),
        ("andes.run('case.xlsx', routine='tds')", True, False),
        ("ss.TDS.callpert = f", False, True),
        ("ss.TDS.callpert: Any = f", False, True),
        ("setattr(ss.TDS, 'callpert', f)", False, True),
        ("h = ss.TDS.h\nss.EIG.run()", False, False),
    ],
)
def test_the_guard_below_sees_every_form_of_running_or_hooking_the_routine(
    source: str, runs: bool, hooks: bool
) -> None:
    assert _runs_and_hooks(source) == (runs, hooks)


def test_the_only_place_the_server_runs_a_system_is_the_wrapper() -> None:
    """The landing is installed by ``Wrapper.run_tds``. A second call of
    ``TDS.run`` or a second ``callpert`` of the server's own (a route, a worker
    handler, a sweep, the command line, the MCP server) would run without it and
    end on the sliver again; this is what has to be reasoned about, not left to
    a case that happens to hit it."""
    root = Path(tensa.__file__).parent
    runs: set[str] = set()
    hooks: set[str] = set()
    for path in root.rglob("*.py"):
        name = path.relative_to(root).as_posix()
        runs_here, hooks_here = _runs_and_hooks(path.read_text(encoding="utf-8"))
        if runs_here:
            runs.add(name)
        if hooks_here:
            hooks.add(name)

    assert runs == {"core/wrapper/tds.py"}
    assert hooks == {"core/wrapper/tds.py"}
