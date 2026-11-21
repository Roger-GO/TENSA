"""Integration tests for the keys of a case: ``GET /keys``, ``key`` on the
topology and ``keys`` on a power-flow result.

Same fixtures and client as ``tests/integration/test_engines_api.py``: a real
FastAPI app over an ASGI transport, with real worker subprocesses. The cases are
the ANDES bundled ones the other integration tests load, copied into the
workspace the same way (``test_topology_controllers_api.py``).
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager


def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh app, with IEEE 14 and its
    dynamics addfile in the workspace."""
    cases = _bundled_cases_dir()
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for src in (cases / "ieee14" / "ieee14.raw", cases / "ieee14" / "ieee14.dyr"):
        shutil.copy2(src, workspace / src.name)

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


async def _session_with_case(
    client: httpx.AsyncClient,
    primary: str,
    addfiles: list[str] | None = None,
) -> str:
    resp = await client.post("/api/sessions")
    assert resp.status_code in (200, 201), resp.text
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    if addfiles:
        body["addfiles"] = addfiles
    resp = await client.post(f"/api/sessions/{sid}/case", json=body)
    assert resp.status_code == 200, resp.text
    return sid


def _entries(topology: dict[str, object]) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for bucket in ("buses", "lines", "transformers", "generators", "loads"):
        out.extend(topology[bucket])  # type: ignore[arg-type]
    return out


@pytest.mark.integration
async def test_topology_entries_carry_distinct_keys_and_has_dynamics(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session_with_case(client, "ieee14.raw", ["ieee14.dyr"])
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    entries = _entries(topology)
    assert entries, "expected bus, line, transformer, generator and load entries"
    keys = [entry["key"] for entry in entries]
    assert all(isinstance(key, str) and key for key in keys)
    assert len(set(keys)) == len(keys), "keys must be distinct"
    assert topology["has_dynamics"] is True


@pytest.mark.integration
async def test_topology_has_dynamics_false_without_dynamic_data(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session_with_case(client, "ieee14.raw")
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert topology["has_dynamics"] is False
    entries = _entries(topology)
    assert all(entry["key"] for entry in entries)


@pytest.mark.integration
async def test_list_keys_matches_topology(client: httpx.AsyncClient) -> None:
    sid = await _session_with_case(client, "ieee14.raw", ["ieee14.dyr"])
    resp = await client.get(f"/api/sessions/{sid}/keys")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body["problems"], list)
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    topology_keys = {entry["key"] for entry in _entries(topology)}
    listed = body["keys"]
    assert topology_keys <= {entry["key"] for entry in listed}
    for entry in listed:
        assert entry["key"]
        assert entry["bucket"]
        assert entry["model"]
        assert "idx" in entry
        assert entry["source"] in ("file", "engine", "ordinal")


@pytest.mark.integration
async def test_list_keys_without_case_is_empty(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    resp = await client.get(f"/api/sessions/{sid}/keys")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"keys": [], "problems": []}


@pytest.mark.integration
async def test_list_keys_unknown_session_is_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/sessions/nope/keys")
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_pflow_result_keys_match_topology(client: httpx.AsyncClient) -> None:
    sid = await _session_with_case(client, "ieee14.raw", ["ieee14.dyr"])
    # The body is required; an empty object asks for the case's own settings.
    resp = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert resp.status_code == 200, resp.text
    result = resp.json()
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    key_by_idx: dict[tuple[str, str], str] = {}
    for bucket, _kinds in (
        ("buses", ("Bus",)),
        ("lines", ("Line",)),
        ("transformers", ("Line",)),
        ("generators", ("PV", "Slack")),
        ("loads", ("PQ",)),
    ):
        for entry in topology[bucket]:
            key_by_idx[(entry["kind"], str(entry["idx"]))] = entry["key"]

    plans = (
        ("bus", result["bus_voltages"], ("Bus",)),
        ("line", result["line_flows"], ("Line",)),
        ("generator", result["generator_outputs"], ("PV", "Slack")),
        ("load", result["load_consumption"], ("PQ",)),
    )
    for name, values, models in plans:
        mapped = result["keys"][name]
        assert set(mapped) == {str(idx) for idx in values}, (
            f"keys.{name} must have an entry for every key of the result dict"
        )
        for idx, key in mapped.items():
            expected = next(
                key_by_idx[(model, idx)] for model in models if (model, idx) in key_by_idx
            )
            assert key == expected


@pytest.mark.integration
async def test_keys_survive_a_reload(client: httpx.AsyncClient) -> None:
    sid = await _session_with_case(client, "ieee14.raw", ["ieee14.dyr"])

    async def keys_by_handle() -> dict[tuple[str, str], str]:
        topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
        return {
            (entry["kind"], str(entry["idx"])): entry["key"]
            for entry in _entries(topology)
        }

    before = await keys_by_handle()
    resp = await client.post(f"/api/sessions/{sid}/reload")
    assert resp.status_code == 200, resp.text
    after = await keys_by_handle()
    assert after == before

@pytest.mark.integration
async def test_a_reload_of_a_file_changed_on_disk_keys_the_new_content(
    client: httpx.AsyncClient,
) -> None:
    """The identity and the keys belong to one content of the case file. When the
    file is replaced on disk and the case reloaded, the keys are assigned afresh
    from the new content, not carried over from the old one."""
    sid = await _session_with_case(client, "ieee14.raw")
    before = (await client.get(f"/api/sessions/{sid}/keys")).json()
    assert "bus:14" in {entry["key"] for entry in before["keys"]}

    workspace = client._transport.app.state.workspace  # type: ignore[attr-defined]  # noqa: SLF001
    shutil.copyfile(_bundled_cases_dir() / "kundur" / "kundur.raw", workspace / "ieee14.raw")

    resp = await client.post(f"/api/sessions/{sid}/reload")
    assert resp.status_code == 200, resp.text
    after = (await client.get(f"/api/sessions/{sid}/keys")).json()
    keys = {entry["key"] for entry in after["keys"]}
    buses = {key for key in keys if key.startswith("bus:")}
    assert buses == {f"bus:{n}" for n in range(1, 11)}
    # Kundur's two parallel lines between buses 7 and 8, by the file's circuits.
    assert {"line:7-8-1", "line:7-8-2"} <= keys
    lines = [e for e in after["keys"] if e["bucket"] in ("line", "transformer")]
    assert lines and all(entry["source"] == "file" for entry in lines)
