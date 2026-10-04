"""Replaying a session's edits into a fresh session rebuilds the same system.

The web UI keeps a journal of the edits it has sent and, when the substrate loses a
session, replays them in order into the replacement (``web/src/store/editJournal.ts``).
That is only sound if the substrate answers a replayed edit the way it did the first
time, and the journal drops the entries a reload would undo, which is only sound if
the reload really does undo them. These tests pin both against a real worker:
the same requests, sent to a second session, leave it with the same topology
(and the same clone-on-write state) as the first.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration

# One recorded request: HTTP method, path under ``/api/sessions/{sid}``, JSON body.
Step = tuple[str, str, dict[str, Any] | None]


def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    cases = _bundled_cases_dir()
    shutil.copy2(cases / "ieee14" / "ieee14.raw", workspace / "ieee14.raw")
    shutil.copy2(cases / "kundur" / "kundur_full.xlsx", workspace / "kundur_full.xlsx")

    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=3,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=3, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _new_session(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


async def _send(client: httpx.AsyncClient, sid: str, steps: list[Step]) -> list[Any]:
    """Send ``steps`` in order, requiring each to succeed; return the JSON bodies."""
    bodies: list[Any] = []
    for method, path, body in steps:
        resp = await client.request(method, f"/api/sessions/{sid}{path}", json=body)
        assert resp.status_code < 400, f"{method} {path}: {resp.status_code} {resp.text}"
        bodies.append(resp.json() if resp.content else None)
    return bodies


async def _topology(client: httpx.AsyncClient, sid: str) -> dict[str, Any]:
    resp = await client.get(f"/api/sessions/{sid}/topology")
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


async def _bus_idxes(client: httpx.AsyncClient, sid: str) -> list[str]:
    return [str(b["idx"]) for b in (await _topology(client, sid))["buses"]]


def _bus(idx: str, vn: float = 100.0) -> Step:
    return ("POST", "/elements", {"model": "Bus", "params": {"idx": idx, "name": f"BUS{idx}", "Vn": vn}})


def _load(path: str) -> Step:
    return ("POST", "/case", {"primary_path": path})


async def _replays_to_the_same_topology(
    client: httpx.AsyncClient, steps: list[Step], replayed: list[Step] | None = None
) -> dict[str, Any]:
    """Send ``steps`` to one session and ``replayed`` (default: the same) to a fresh
    one, and require the two topologies to match. Returns the topology."""
    original = await _new_session(client)
    await _send(client, original, steps)
    fresh = await _new_session(client)
    await _send(client, fresh, steps if replayed is None else replayed)
    topology = await _topology(client, original)
    assert await _topology(client, fresh) == topology
    return topology


async def test_a_blank_build_replays_to_the_same_topology(client: httpx.AsyncClient) -> None:
    line: Step = (
        "POST",
        "/elements",
        {"model": "Line", "params": {"idx": "L12", "bus1": "1", "bus2": "2", "r": 0.01, "x": 0.05}},
    )
    steps: list[Step] = [
        ("POST", "/blank", None),
        _bus("1"),
        _bus("2"),
        _bus("3"),
        line,
        ("PUT", "/elements/Bus/1", {"params": {"Vn": 230.0}}),
        ("DELETE", "/elements/Bus/3", None),
        ("POST", "/undo-last-edit", None),
        _bus("4"),
        ("POST", "/reload", None),
        _bus("5"),
    ]

    topology = await _replays_to_the_same_topology(client, steps)

    # Delete dropped bus 3 and the undo then dropped the line, so the build ended
    # with buses 1, 2, 4 (the reload keeps a blank system's adds) and 5.
    assert sorted(str(b["idx"]) for b in topology["buses"]) == ["1", "2", "4", "5"]
    assert topology["lines"] == []


async def test_edits_to_a_loaded_case_replay_to_the_same_topology(
    client: httpx.AsyncClient,
) -> None:
    steps: list[Step] = [
        _load("ieee14.raw"),
        _bus("100", 69.0),
        _bus("101", 69.0),
        ("PUT", "/elements/Bus/100", {"params": {"Vn": 138.0}}),
        (
            "POST",
            "/elements",
            {
                "model": "Line",
                "params": {"idx": "L100", "bus1": "100", "bus2": "101", "r": 0.01, "x": 0.05},
            },
        ),
        ("DELETE", "/elements/Line/L100", None),
        _bus("102", 69.0),
    ]

    topology = await _replays_to_the_same_topology(client, steps)

    assert {"100", "101", "102"} <= {str(b["idx"]) for b in topology["buses"]}
    assert len(topology["buses"]) == 17


async def test_a_reload_on_a_loaded_case_undoes_everything_before_it(
    client: httpx.AsyncClient,
) -> None:
    """Why the journal may drop the entries before a file-backed reload."""
    with_reload: list[Step] = [
        _load("ieee14.raw"),
        _bus("100", 69.0),
        ("PUT", "/elements/Bus/100", {"params": {"Vn": 138.0}}),
        ("POST", "/undo-last-edit", None),
        ("POST", "/reload", None),
        _bus("101", 69.0),
    ]
    compacted: list[Step] = [_load("ieee14.raw"), _bus("101", 69.0)]

    topology = await _replays_to_the_same_topology(client, with_reload, compacted)

    assert "100" not in {str(b["idx"]) for b in topology["buses"]}
    assert "101" in {str(b["idx"]) for b in topology["buses"]}


async def test_clone_edits_replay_to_the_same_clone_state(client: httpx.AsyncClient) -> None:
    def edit(value: float) -> Step:
        return ("PUT", "/case/clone/params/TGOV1/1/T1", {"value": value})

    steps: list[Step] = [
        _load("kundur_full.xlsx"),
        ("POST", "/case/clone", {}),
        edit(0.6),
        edit(0.7),
        ("POST", "/case/clone/undo", {}),
    ]
    original = await _new_session(client)
    original_bodies = await _send(client, original, steps)
    fresh = await _new_session(client)
    fresh_bodies = await _send(client, fresh, steps)

    for key in ("new_value", "undo_depth", "redo_depth"):
        assert fresh_bodies[-1][key] == original_bodies[-1][key]
    assert (fresh_bodies[-1]["undo_depth"], fresh_bodies[-1]["redo_depth"]) == (1, 1)

    diff = "/case/clone/diff/TGOV1/1"
    got = (await client.get(f"/api/sessions/{fresh}{diff}")).json()
    want = (await client.get(f"/api/sessions/{original}{diff}")).json()
    assert got == want
    assert await _topology(client, fresh) == await _topology(client, original)


async def test_a_clone_reset_on_a_loaded_case_undoes_everything_before_it(
    client: httpx.AsyncClient,
) -> None:
    """Why the journal may drop the entries before a clone reset."""
    with_reset: list[Step] = [
        _load("kundur_full.xlsx"),
        _bus("100", 230.0),
        ("POST", "/case/clone", {}),
        ("PUT", "/case/clone/params/TGOV1/1/T1", {"value": 0.6}),
        ("POST", "/case/clone/reset", {}),
    ]
    pristine: list[Step] = [_load("kundur_full.xlsx")]

    topology = await _replays_to_the_same_topology(client, with_reset, pristine)

    assert "100" not in {str(b["idx"]) for b in topology["buses"]}


def _save_over(path: str) -> Step:
    fmt = path.rsplit(".", 1)[1]
    return ("POST", "/save", {"filename": path, "format": fmt, "overwrite": True})


async def test_a_save_over_the_open_case_undoes_nothing_before_it(
    client: httpx.AsyncClient,
) -> None:
    """Why the journal may drop the entries before a save over the open case file:
    the file then holds them, and a session that loads it starts from there. (The
    writer spells some numbers differently, so the two are compared by their buses.)"""
    original = await _new_session(client)
    await _send(
        client,
        original,
        [
            _load("kundur_full.xlsx"),
            _bus("100", 230.0),
            _bus("101", 230.0),
            _save_over("kundur_full.xlsx"),
            _bus("102", 230.0),
        ],
    )
    fresh = await _new_session(client)
    await _send(client, fresh, [_load("kundur_full.xlsx"), _bus("102", 230.0)])

    got = await _bus_idxes(client, fresh)
    assert got == await _bus_idxes(client, original)
    assert {"100", "101", "102"} <= set(got)
    assert len(got) == len(set(got))


async def test_undo_after_a_save_over_the_open_case_drops_only_what_came_after(
    client: httpx.AsyncClient,
) -> None:
    """The saved elements are part of the file now: an undo reloads it and must not
    add them a second time, and must not take the last of them away either."""
    sid = await _new_session(client)
    await _send(
        client,
        sid,
        [
            _load("kundur_full.xlsx"),
            _bus("100", 230.0),
            _bus("101", 230.0),
            _save_over("kundur_full.xlsx"),
        ],
    )
    saved = await _bus_idxes(client, sid)
    assert saved.count("100") == 1 and saved.count("101") == 1

    nothing = await client.post(f"/api/sessions/{sid}/undo-last-edit")
    assert nothing.status_code == 422, nothing.text
    assert await _bus_idxes(client, sid) == saved

    await _send(client, sid, [_bus("102", 230.0)])
    assert await _bus_idxes(client, sid) == [*saved, "102"]
    await _send(client, sid, [("POST", "/undo-last-edit", None)])
    assert await _bus_idxes(client, sid) == saved


async def test_a_saved_element_is_the_cases_to_delete_like_any_other(
    client: httpx.AsyncClient,
) -> None:
    sid = await _new_session(client)
    await _send(
        client, sid, [_load("kundur_full.xlsx"), _bus("100", 230.0), _save_over("kundur_full.xlsx")]
    )
    resp = await client.delete(f"/api/sessions/{sid}/elements/Bus/100")
    assert resp.status_code == 422, resp.text
    assert "loaded case file" in resp.json()["detail"]


async def test_a_save_under_another_name_keeps_the_edits_to_undo(
    client: httpx.AsyncClient,
) -> None:
    sid = await _new_session(client)
    await _send(
        client,
        sid,
        [
            _load("kundur_full.xlsx"),
            _bus("100", 230.0),
            ("POST", "/save", {"filename": "backup.xlsx", "format": "xlsx"}),
            ("POST", "/undo-last-edit", None),
        ],
    )
    assert "100" not in await _bus_idxes(client, sid)


async def test_a_save_over_the_open_case_is_refused_while_disturbances_are_committed(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A committed fault is a device of the system. Written over the case file it
    would come back as one of the case's own events the next time it is opened."""
    case = tmp_path / "ws" / "kundur_full.xlsx"
    before = case.read_bytes()
    sid = await _new_session(client)
    fault = {"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}
    await _send(
        client,
        sid,
        [_load("kundur_full.xlsx"), ("POST", "/disturbances", {"disturbances": [fault]})],
    )

    refused = await client.post(f"/api/sessions/{sid}/save", json=_save_over("kundur_full.xlsx")[2])
    assert refused.status_code == 422, refused.text
    assert "disturbances" in refused.json()["detail"]
    assert case.read_bytes() == before

    # Under another name it is written as before: the user named that file.
    elsewhere = await client.post(
        f"/api/sessions/{sid}/save", json={"filename": "with-fault.xlsx", "format": "xlsx"}
    )
    assert elsewhere.status_code == 201, elsewhere.text
