"""What a real worker's ANDES says reaches ``GET /sessions/{id}/messages``.

Drives the app over an httpx ASGITransport with a real ``SessionManager`` and
worker subprocesses on IEEE 14. The unit tests (``tests/unit/test_messages.py``,
``tests/unit/test_session_messages.py``) cover the capture and the log with fakes;
these check that the two meet: that ANDES's own log lines, from the real library
in a real subprocess, come out of the route with their level, their command and
their text.
"""

from __future__ import annotations

import asyncio
import shutil
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration


def _bundled_ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[tuple[httpx.AsyncClient, SessionManager]]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for name in ("ieee14.raw", "ieee14.dyr"):
        shutil.copy2(_bundled_ieee14_dir() / name, workspace / name)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac, mgr
    finally:
        await mgr.shutdown()


async def _loaded_session(ac: httpx.AsyncClient) -> str:
    resp = await ac.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    sid = str(resp.json()["session_id"])
    loaded = await ac.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert loaded.status_code == 200, loaded.text
    return sid


async def _messages(ac: httpx.AsyncClient, sid: str, **query: Any) -> list[dict[str, Any]]:
    resp = await ac.get(f"/api/sessions/{sid}/messages", params=query)
    assert resp.status_code == 200, resp.text
    messages: list[dict[str, Any]] = resp.json()["messages"]
    return messages


def _by(messages: list[dict[str, Any]], source: str) -> list[str]:
    return [m["text"] for m in messages if m["source"] == source]


async def test_loading_a_case_and_solving_it_log_what_andes_said(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _loaded_session(ac)
    solved = await ac.post(f"/api/sessions/{sid}/pflow", json={})
    assert solved.status_code == 200, solved.text
    iterations = solved.json()["iterations"]

    messages = await _messages(ac, sid)

    parsed = _by(messages, "load_case")
    assert any("Parsing input file" in text and "ieee14.raw" in text for text in parsed)
    solver = [m for m in messages if m["logger"] == "andes.routines.pflow"]
    assert {m["source"] for m in solver} == {"run_pflow"}
    assert any(m["text"].startswith(f"Converged in {iterations + 1} iterations") for m in solver)
    # A clean run says nothing worse than information.
    assert {m["level"] for m in messages} == {"info"}
    # Numbered from 1 in the order they happened: the load before the solve.
    seqs = [m["seq"] for m in messages]
    assert seqs == list(range(1, len(seqs) + 1))
    assert messages[0]["source"] == "load_case"
    assert messages[-1]["source"] == "run_pflow"
    assert all(m["time"] > 1e9 for m in messages)


async def test_a_power_flow_that_does_not_converge_leaves_an_error(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _loaded_session(ac)
    solved = await ac.post(f"/api/sessions/{sid}/pflow", json={"max_iterations": 1})
    assert solved.status_code == 200, solved.text
    assert solved.json()["converged"] is False

    errors = await _messages(ac, sid, level="error")

    assert len(errors) == 1
    assert errors[0]["level"] == "error"
    assert errors[0]["source"] == "run_pflow"
    assert errors[0]["logger"] == "andes.routines.pflow"
    assert errors[0]["text"].startswith("Power flow failed after")
    # The same message is in the full list, among the information around it.
    everything = await _messages(ac, sid)
    assert errors[0]["seq"] in {m["seq"] for m in everything}
    assert len(everything) > 1


async def test_a_generator_held_at_a_reactive_limit_is_a_warning(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _loaded_session(ac)
    solved = await ac.post(f"/api/sessions/{sid}/pflow", json={"enforce_q_limits": True})
    assert solved.status_code == 200, solved.text
    assert solved.json()["converged"] is True

    warnings = await _messages(ac, sid, level="warning")

    (notice,) = warnings
    assert notice["level"] == "warning"
    assert notice["source"] == "run_pflow"
    assert notice["logger"] == "tensa.notice"
    assert "switched from PV to PQ" in notice["text"]
    # Without enforcement the same case says nothing of the kind.
    plain = await _loaded_session(ac)
    await ac.post(f"/api/sessions/{plain}/pflow", json={})
    assert await _messages(ac, plain, level="warning") == []


async def test_the_events_of_a_time_domain_run_are_logged(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _loaded_session(ac)
    added = await ac.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 0.5, "tc": 0.6}]},
    )
    assert added.status_code == 200, added.text
    run = await ac.post(f"/api/sessions/{sid}/tds", json={"tf": 1.0})
    assert run.status_code == 200, run.text

    tds = _by(await _messages(ac, sid), "run_tds")

    assert any("Applying fault on Bus (idx=4) at t=0.5" in text for text in tds)
    assert any("Clearing fault on Bus (idx=4) at t=0.6" in text for text in tds)
    assert any(text.startswith("Simulation to t=1.00 sec completed") for text in tds)


async def test_a_streamed_run_logs_while_it_goes_and_a_read_never_waits_for_it(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, mgr = client
    sid = await _loaded_session(ac)
    added = await ac.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 0.5, "tc": 0.6}]},
    )
    assert added.status_code == 200, added.text

    run_id = await mgr.start_streaming_run(
        sid,
        "run_tds",
        {
            "tf": 4.0,
            "h": None,
            "stream": True,
            "decimation": "none",
            "max_rate_hz": None,
            "vars": ["bus_v"],
            "integrator": "trapezoidal",
        },
    )
    run = mgr._runs[run_id]

    statuses: list[int] = []
    deadline = time.monotonic() + 60
    while run.state not in ("completed", "error"):
        assert time.monotonic() < deadline, "the streamed run did not finish"
        statuses.append((await ac.get(f"/api/sessions/{sid}/messages")).status_code)
        await asyncio.sleep(0.02)

    # The session is busy for the whole run, which makes a command 409 (a worker
    # round trip). Reading the log is not one: every read answered.
    assert run.state == "completed", run.error
    assert statuses and set(statuses) == {200}
    tds = _by(await _messages(ac, sid), "run_tds")
    assert any("Applying fault on Bus (idx=4) at t=0.5" in text for text in tds)
    assert any(text.startswith("Simulation to t=4.00 sec completed") for text in tds)


async def test_reading_on_from_a_number_and_clearing_work_against_a_real_session(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _loaded_session(ac)
    first = (await ac.get(f"/api/sessions/{sid}/messages")).json()
    assert first["messages"] and first["next_after"] == first["last_seq"]

    await ac.post(f"/api/sessions/{sid}/pflow", json={})
    later = (await ac.get(f"/api/sessions/{sid}/messages", params={"after": first["next_after"]})).json()
    assert {m["source"] for m in later["messages"]} == {"run_pflow"}
    assert later["messages"][0]["seq"] == first["last_seq"] + 1

    cleared = await ac.delete(f"/api/sessions/{sid}/messages")
    assert cleared.status_code == 204
    assert await _messages(ac, sid) == []

    # What happens next is numbered on from before, so a client that kept its
    # place reads exactly the new messages.
    await ac.post(f"/api/sessions/{sid}/reload")
    after_reload = (
        await ac.get(f"/api/sessions/{sid}/messages", params={"after": later["next_after"]})
    ).json()
    assert after_reload["messages"]
    assert after_reload["messages"][0]["seq"] == later["last_seq"] + 1
    assert {m["source"] for m in after_reload["messages"]} == {"reload_case"}


async def test_each_session_has_its_own_messages(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    first = await _loaded_session(ac)
    second = str((await ac.post("/api/sessions")).json()["session_id"])
    await ac.post(f"/api/sessions/{first}/pflow", json={"max_iterations": 1})

    assert await _messages(ac, second) == []
    assert await _messages(ac, first, level="error")
