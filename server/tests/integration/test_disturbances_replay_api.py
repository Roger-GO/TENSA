"""Integration tests for the disturbance-replay infrastructure (Unit 6.5).

Two layers covered:

1. Wrapper-level (in-process, no FastAPI / no subprocess) — confirms
   ``add_disturbance`` populates ``_disturbance_log`` atomically,
   ``reload_case`` clears it, ``replay_disturbances`` re-applies it,
   and the post-setup / invalid-spec edge cases behave per spec.

2. HTTP-level — drives the FastAPI app over an httpx ASGITransport with
   the real SessionManager + worker subprocesses + IEEE 14 case files.
   Verifies ``GET /sessions/{id}/disturbances`` mirrors the wrapper's
   log across the reload boundary.

Both layers run under ``pytest -m integration`` because they touch ANDES.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.disturbance import AlterSpec, FaultSpec
from tensa.core.errors import DisturbanceValidationError
from tensa.core.session import SessionManager
from tensa.core.wrapper import Wrapper


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    raw = cases / "ieee14.raw"
    dyr = cases / "ieee14.dyr"
    if not raw.exists() or not dyr.exists():  # pragma: no cover
        pytest.skip(f"IEEE 14 fixtures not bundled: {cases}")
    return raw, dyr


# ---- Wrapper-level integration tests --------------------------------------


@pytest.mark.integration
def test_add_disturbance_appends_to_log() -> None:
    """Happy path: each successful ``add_disturbance`` appends to the log
    in call order. ``list_disturbances`` returns the recorded specs."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    spec1 = FaultSpec(bus_idx=4, tf=1.0, tc=1.1)
    spec2 = FaultSpec(bus_idx=5, tf=2.0, tc=2.1)
    w.add_disturbance(spec1)
    w.add_disturbance(spec2)

    log = w.list_disturbances()
    assert len(log) == 2
    assert log[0] == spec1
    assert log[1] == spec2


@pytest.mark.integration
def test_load_case_clears_disturbance_log() -> None:
    """``load_case`` (and therefore ``reload_case``) wipes the log: the
    new System has no Fault devices, so the log must agree."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    w.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1))
    assert len(w.list_disturbances()) == 1

    # Reload via load_case — log clears.
    w.load_case(raw, addfiles=[dyr])
    assert w.list_disturbances() == []


@pytest.mark.integration
def test_reload_case_clears_then_replay_restores() -> None:
    """The intended workflow: snapshot the specs pre-reload, reload (which
    clears the log AND brings the System back to pre-setup), restore the
    log, replay. The replayed devices land back on the System."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    spec1 = FaultSpec(bus_idx=4, tf=1.0, tc=1.1)
    spec2 = FaultSpec(bus_idx=5, tf=2.0, tc=2.1)
    w.add_disturbance(spec1)
    w.add_disturbance(spec2)

    # Caller captures the specs BEFORE reload — that's the contract.
    captured = w.list_disturbances()
    w.run_pflow()  # commit setup
    assert w._ss is not None and w._ss.is_setup  # noqa: SLF001

    w.reload_case()
    assert w.list_disturbances() == []
    # Reload returned to pre-setup; replay must succeed.
    assert w._ss is not None and not w._ss.is_setup  # noqa: SLF001

    # Restore the captured log and replay.
    for spec in captured:
        w.add_disturbance(spec)

    log = w.list_disturbances()
    assert len(log) == 2
    assert log[0] == spec1
    assert log[1] == spec2


@pytest.mark.integration
def test_replay_disturbances_returns_count_and_re_adds_devices() -> None:
    """``replay_disturbances`` is the convenience that snapshots + clears +
    re-adds in one call. Returns the count replayed."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    w.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1))
    w.add_disturbance(FaultSpec(bus_idx=5, tf=2.0, tc=2.1))
    captured = w.list_disturbances()

    # We need to reload first because replay re-adds onto the SAME System.
    # On a system that already has those Fault devices, ANDES would either
    # accept duplicate idx (auto-prefix) or reject. The intended workflow
    # is reload → caller-captured-list-restore → replay; we exercise that
    # by directly seeding the log post-reload.
    w.reload_case()
    assert w.list_disturbances() == []
    w._disturbance_log = list(captured)  # noqa: SLF001 — simulating snapshot restore
    count = w.replay_disturbances()
    assert count == 2
    # After replay, the log is restored (replay re-uses add_disturbance
    # which re-appends each spec).
    log = w.list_disturbances()
    assert len(log) == 2
    assert log[0] == captured[0]
    assert log[1] == captured[1]


@pytest.mark.integration
def test_replay_disturbances_post_setup_no_op_with_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Edge: calling ``replay_disturbances`` post-setup is a no-op and logs
    a warning (calling ``ss.add`` then would crash with a non-actionable
    ANDES error). Returns 0."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    w.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1))
    w.run_pflow()  # commits setup

    with caplog.at_level(logging.WARNING, logger="tensa.wrapper.disturbance-replay"):
        n = w.replay_disturbances()
    assert n == 0
    assert any("post-setup" in rec.message for rec in caplog.records)


@pytest.mark.integration
def test_add_disturbance_invalid_spec_does_not_pollute_log() -> None:
    """Edge: when ``ss.add`` rejects, the log must NOT grow — atomic from
    the caller's perspective.

    ANDES is lenient at pre-setup ``add()`` time — it defers invariant checks
    (bus existence, valid src, etc.) to ``setup()`` — so no Pydantic-valid spec
    reliably raises at add() anymore. We therefore force ``ss.add`` to raise and
    assert the "append only on success" invariant holds independent of which
    specs ANDES happens to reject. (Previously this test exploited the
    now-fixed bug where every Alter raised "Mandatory parameter method missing".)
    """
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    # Add a valid spec first so the log has a baseline length.
    w.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1))
    baseline = list(w.list_disturbances())

    with (
        patch.object(w._ss, "add", side_effect=ValueError("ANDES boom")),
        pytest.raises(DisturbanceValidationError),
    ):
        w.add_disturbance(
            AlterSpec(
                model="PQ", dev_idx="PQ_0", src="Ppf", t=1.0, method="*", amount=1.2
            )
        )

    # Log is unchanged — no rollback needed because we only append on success.
    assert w.list_disturbances() == baseline


def test_alter_disturbance_method_amount_round_trips() -> None:
    """Regression: a valid Alter (method + amount) is accepted and recorded.

    Pins the fix for the bug where the wrapper passed a non-existent ``value``
    kwarg to ANDES's ``Alter`` and every load-increase / parameter-alter failed
    with "Mandatory parameter method missing". Also covers the legacy
    ``{value: X}`` back-compat shim mapping to ``method='=', amount=X``.
    """
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    pq_idx = w._ss.PQ.idx.v[0]

    # method/amount Alter is accepted and appears in the log.
    w.add_disturbance(
        AlterSpec(model="PQ", dev_idx=pq_idx, src="Ppf", t=1.0, method="*", amount=1.2)
    )
    log = w.list_disturbances()
    assert len(log) == 1
    assert log[0].method == "*" and log[0].amount == 1.2

    # Legacy ``value`` deserializes to an absolute set.
    legacy = AlterSpec.model_validate(
        {"kind": "alter", "model": "PQ", "dev_idx": pq_idx, "src": "Ppf", "t": 2.0, "value": 0.5}
    )
    assert legacy.method == "=" and legacy.amount == 0.5


@pytest.mark.integration
def test_clear_disturbances_only_clears_log_does_not_revert_setup() -> None:
    """``clear_disturbances`` is log-only: the loaded System is untouched
    (no setup revert, no device removal)."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    w.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1))
    pre_setup_state = w.topology_snapshot().state
    assert pre_setup_state == "pre-setup"

    w.clear_disturbances()
    assert w.list_disturbances() == []
    # System still loaded, still pre-setup — caller can immediately add
    # different disturbances.
    assert w.topology_snapshot().state == "pre-setup"


# ---- HTTP-level integration tests -----------------------------------------


def _bundled_ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    for name in ["ieee14.raw", "ieee14.dyr"]:
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
    client: httpx.AsyncClient, primary: str = "ieee14.raw", addfile: str | None = None
) -> str:
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    if addfile:
        body["addfiles"] = [addfile]
    await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    return sid


@pytest.mark.integration
async def test_get_disturbances_empty_on_fresh_session(
    client: httpx.AsyncClient,
) -> None:
    """A fresh session with a loaded case but no disturbances returns
    an empty list."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.get(
        f"/api/sessions/{sid}/disturbances",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"disturbances": []}


@pytest.mark.integration
async def test_post_then_get_returns_added_disturbances(
    client: httpx.AsyncClient,
) -> None:
    """POST a fault → GET reflects it. The response contract mirrors the
    POST request body's ``disturbances`` field."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    post_body = {
        "disturbances": [
            {"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1},
            {"kind": "fault", "bus_idx": 5, "tf": 2.0, "tc": 2.1},
        ]
    }
    post = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json=post_body,
    )
    assert post.status_code == 200, post.text

    get = await client.get(
        f"/api/sessions/{sid}/disturbances",
    )
    assert get.status_code == 200, get.text
    payload = get.json()
    assert "disturbances" in payload
    assert len(payload["disturbances"]) == 2
    # Discriminator + key fields preserved.
    assert payload["disturbances"][0]["kind"] == "fault"
    assert payload["disturbances"][0]["bus_idx"] == 4
    assert payload["disturbances"][1]["bus_idx"] == 5


@pytest.mark.integration
async def test_get_returns_empty_after_reload(client: httpx.AsyncClient) -> None:
    """Workflow: POST → GET (1 entry) → reload → GET (empty) →
    re-POST → GET (1 entry again). This is the loop the snapshot UI
    will run after restoring a snapshot."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    one = {"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}]}
    await client.post(
        f"/api/sessions/{sid}/disturbances",
        json=one,
    )
    g1 = await client.get(
        f"/api/sessions/{sid}/disturbances",
    )
    assert len(g1.json()["disturbances"]) == 1

    # Reload.
    rl = await client.post(
        f"/api/sessions/{sid}/reload",
    )
    assert rl.status_code == 200

    g2 = await client.get(
        f"/api/sessions/{sid}/disturbances",
    )
    assert g2.status_code == 200
    assert g2.json()["disturbances"] == []

    # Re-POST the same spec — substrate accepts it and GET reflects.
    await client.post(
        f"/api/sessions/{sid}/disturbances",
        json=one,
    )
    g3 = await client.get(
        f"/api/sessions/{sid}/disturbances",
    )
    assert len(g3.json()["disturbances"]) == 1
    assert g3.json()["disturbances"][0]["bus_idx"] == 4


@pytest.mark.integration
async def test_get_disturbances_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get(
        "/api/sessions/does-not-exist/disturbances",
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_post_invalid_spec_does_not_show_in_get(
    client: httpx.AsyncClient,
) -> None:
    """Atomic: a 422-rejected POST must NOT show in the subsequent GET.

    ANDES is lenient at pre-setup ``add()`` time, so we trigger the 422 at the
    request-validation layer instead: an Alter with a ``method`` outside the
    allowed ``+ - * / =`` set fails Pydantic discriminated-union validation
    BEFORE reaching the worker, so nothing is added to the log."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    bad = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {
                    "kind": "alter",
                    "model": "PQ",
                    "dev_idx": "PQ_0",
                    "src": "Ppf",
                    "t": 1.0,
                    "method": "@",
                    "amount": 1.0,
                }
            ]
        },
    )
    assert bad.status_code == 422, bad.text

    g = await client.get(
        f"/api/sessions/{sid}/disturbances",
    )
    assert g.status_code == 200
    # Nothing was accepted — log is empty.
    assert g.json()["disturbances"] == []
