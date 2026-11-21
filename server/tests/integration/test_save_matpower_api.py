"""Integration: ``POST /sessions/{id}/save`` with ``format: "m"``.

The saved ``.m`` must parse with ANDES's own MATPOWER reader and load back,
in another session, as a case with the same content and the same power
flow. The extension and name rules of the save route apply to the new
format, and what the file leaves out is said in the Messages log.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from andes.io.matpower import m2mpc

from tensa.api.app import make_app
from tensa.core.session import SessionManager


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    import andes

    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    source = Path(andes.get_case("ieee14/ieee14_full.xlsx"))
    (workspace / "ieee14_full.xlsx").write_bytes(source.read_bytes())
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
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


async def _session_with(client: httpx.AsyncClient, case: str) -> tuple[str, dict[str, object]]:
    created = await client.post("/api/sessions")
    assert created.status_code == 201, created.text
    session_id = str(created.json()["session_id"])
    loaded = await client.post(
        f"/api/sessions/{session_id}/case", json={"primary_path": case}
    )
    assert loaded.status_code == 200, loaded.text
    return session_id, loaded.json()


async def _pflow(client: httpx.AsyncClient, session_id: str) -> dict[str, object]:
    resp = await client.post(f"/api/sessions/{session_id}/pflow", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["converged"] is True
    return dict(body)


@pytest.mark.integration
async def test_save_as_m_writes_a_file_that_loads_back_with_the_same_power_flow(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    session_id, topology = await _session_with(client, "ieee14_full.xlsx")
    workspace = tmp_path / "ws"

    saved = await client.post(
        f"/api/sessions/{session_id}/save",
        json={"filename": "roundtrip.m", "format": "m"},
    )
    assert saved.status_code == 201, saved.text
    on_disk = workspace / "roundtrip.m"
    assert saved.json()["bytes_written"] == on_disk.stat().st_size
    assert len(m2mpc(str(on_disk))["bus"]) == len(topology["buses"])  # type: ignore[arg-type]

    # What the file leaves out is in the session's Messages log.
    messages = (await client.get(f"/api/sessions/{session_id}/messages")).json()
    texts = [m["text"] for m in messages["messages"]]
    assert any("roundtrip.m" in t and "GENROU (5)" in t for t in texts), texts

    # The effect through the API: a second session loads the .m and shows the
    # same network, and its power flow lands on the same voltages.
    second_id, back = await _session_with(client, "roundtrip.m")
    for kind in ("buses", "lines", "loads"):
        assert len(back[kind]) == len(topology[kind]), kind  # type: ignore[arg-type]
    # The static generators come back; the machines on them do not (a ``.m``
    # holds no dynamic data, which the Messages log said).
    static = {"PV", "Slack"}
    kinds_before = sorted(g["kind"] for g in topology["generators"] if g["kind"] in static)  # type: ignore[attr-defined]
    kinds_after = sorted(g["kind"] for g in back["generators"])  # type: ignore[attr-defined]
    assert kinds_after == kinds_before

    first = await _pflow(client, session_id)
    again = await _pflow(client, second_id)
    for key in ("bus_voltages", "bus_angles"):
        a = first[key]
        b = again[key]
        assert isinstance(a, dict) and isinstance(b, dict)
        assert a.keys() == b.keys()
        for bus, value in a.items():
            assert b[bus] == pytest.approx(value, abs=1e-6), (key, bus)


@pytest.mark.integration
async def test_format_m_with_an_xlsx_filename_is_a_422(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    session_id, _ = await _session_with(client, "ieee14_full.xlsx")
    saved = await client.post(
        f"/api/sessions/{session_id}/save",
        json={"filename": "mismatch.xlsx", "format": "m"},
    )
    assert saved.status_code == 422
    assert ".m" in saved.json()["detail"]
    assert not (tmp_path / "ws" / "mismatch.xlsx").exists()


@pytest.mark.integration
async def test_an_unknown_format_is_a_422_and_writes_nothing(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    session_id, _ = await _session_with(client, "ieee14_full.xlsx")
    saved = await client.post(
        f"/api/sessions/{session_id}/save",
        json={"filename": "nope.m", "format": "matpower"},
    )
    assert saved.status_code == 422
    assert not (tmp_path / "ws" / "nope.m").exists()


@pytest.mark.integration
@pytest.mark.parametrize(
    "filename", ["../escape.m", "CON.m", "sub/missing/dir.m"], ids=["traversal", "device", "no-dir"]
)
async def test_an_unsafe_m_filename_is_refused_and_writes_nothing(
    client: httpx.AsyncClient, tmp_path: Path, filename: str
) -> None:
    session_id, _ = await _session_with(client, "ieee14_full.xlsx")
    saved = await client.post(
        f"/api/sessions/{session_id}/save",
        json={"filename": filename, "format": "m"},
    )
    assert saved.status_code == 422, saved.text
    assert not (tmp_path / "escape.m").exists()
    assert sorted(p.name for p in (tmp_path / "ws").iterdir()) == ["ieee14_full.xlsx"]


async def _put_layout(client: httpx.AsyncClient, case: str, layout: dict[str, Any]) -> None:
    resp = await client.put("/api/workspace/layout", params={"case_path": case}, json=layout)
    assert resp.status_code == 204, resp.text


async def _get_layout(client: httpx.AsyncClient, case: str) -> dict[str, Any] | None:
    resp = await client.get("/api/workspace/layout", params={"case_path": case})
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] | None = resp.json()
    return body


def _layout(buses: list[str]) -> dict[str, Any]:
    return {
        "schema_version": "2",
        "andes_version": "2.0.0",
        "coordinates": {bus: {"x": 100.0 * i, "y": 0.0} for i, bus in enumerate(buses)},
        "controller_coordinates": {"TGOV1": {"1": {"x": 160.0, "y": -60.0}}},
        "last_modified": "2026-10-06T08:00:00+00:00",
    }


@pytest.mark.integration
async def test_a_case_saved_as_m_keeps_the_placement_that_survives_renumbering(
    client: httpx.AsyncClient,
) -> None:
    """A ``.m`` keeps the bus numbers and no device idx, so the copy gets the
    layout cut down as for a ``.raw``: the buses stay, what is keyed by a
    device idx alone goes."""
    session_id, _ = await _session_with(client, "ieee14_full.xlsx")
    placed = _layout([str(i) for i in range(1, 15)])
    await _put_layout(client, "ieee14_full.xlsx", placed)

    saved = await client.post(
        f"/api/sessions/{session_id}/save", json={"filename": "copy.m", "format": "m"}
    )
    assert saved.status_code == 201, saved.text
    carried = await _get_layout(client, "copy.m")
    assert carried is not None
    assert carried["coordinates"] == placed["coordinates"]
    assert carried["controller_coordinates"] == {}


@pytest.mark.integration
async def test_a_case_whose_buses_are_numbered_afresh_gets_no_layout(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """Text bus idxes become 1 to n in a ``.m``: no position of the layout
    could be matched to its bus any more, so the copy gets none."""
    import andes
    from andes.io import xlsx as andes_xlsx

    ss = andes.System(no_output=True, default_config=True)
    ss.add("Bus", idx="alpha", name="Alpha", Vn=110.0)
    ss.add("Bus", idx="beta", name="Beta", Vn=110.0)
    ss.add("Slack", idx="G1", bus="alpha", Vn=110.0, p0=0.5)
    ss.add("PQ", idx="L1", bus="beta", Vn=110.0, p0=0.5, q0=0.1)
    ss.add("Line", idx="Ln1", bus1="alpha", bus2="beta", Vn1=110.0, Vn2=110.0, x=0.1)
    andes_xlsx.write(ss, str(tmp_path / "ws" / "text.xlsx"), overwrite=True)

    session_id, _ = await _session_with(client, "text.xlsx")
    await _put_layout(client, "text.xlsx", _layout(["alpha", "beta"]))
    saved = await client.post(
        f"/api/sessions/{session_id}/save", json={"filename": "text.m", "format": "m"}
    )
    assert saved.status_code == 201, saved.text
    assert await _get_layout(client, "text.m") is None
    assert [int(row[0]) for row in m2mpc(str(tmp_path / "ws" / "text.m"))["bus"]] == [1, 2]

    # The case it was saved from keeps its own.
    assert await _get_layout(client, "text.xlsx") is not None


@pytest.mark.integration
async def test_an_existing_m_file_is_kept_unless_overwrite_is_set(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    session_id, _ = await _session_with(client, "ieee14_full.xlsx")
    target = tmp_path / "ws" / "taken.m"
    target.write_text("function mpc = taken\n", encoding="utf-8")

    refused = await client.post(
        f"/api/sessions/{session_id}/save",
        json={"filename": "taken.m", "format": "m"},
    )
    assert refused.status_code == 409, refused.text
    assert target.read_text(encoding="utf-8") == "function mpc = taken\n"

    replaced = await client.post(
        f"/api/sessions/{session_id}/save",
        json={"filename": "taken.m", "format": "m", "overwrite": True},
    )
    assert replaced.status_code == 201, replaced.text
    assert len(m2mpc(str(target))["bus"]) == 14
