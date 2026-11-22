"""The Sienna engine through the real API, against the real Julia runtime.

A real FastAPI app over an ASGI transport, with real worker subprocesses (the
fixture pattern of ``tests/integration/test_keys_api.py``, with the session
manager given the workspace as ``make_app`` gives it). A Sienna worker starts
Julia, which takes a minute or more, and its first case and power flow take
about as long again, so the module shares one app, one Sienna session and one
ANDES session (``world``), and the session loads its cases one after another.
Only the test of a second session at once and the samples script start Julia
again. Nothing asserts a time.

Skipped where ``sienna_unavailable_reason()`` is not ``None`` (CI has no Julia);
a machine with ``TENSA_JULIA`` and ``TENSA_SIENNA_PROJECT`` set runs every test.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio

from tensa.api.app import make_app
from tensa.core.examples import _andes_cases_dir
from tensa.core.session import SessionManager
from tensa.core.session_dirs import OWNER_MARKER_NAME, SESSIONS_DIRNAME, pid_is_alive
from tensa.engines.sienna.environment import sienna_unavailable_reason

_REASON = sienna_unavailable_reason()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(_REASON is not None, reason=f"the Sienna engine is not available: {_REASON}"),
    pytest.mark.asyncio(loop_scope="module"),
]

_SAMPLES = Path(__file__).parents[1] / "unit" / "sienna_samples"
_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "make_sienna_samples.py"

# A first Sienna op waits for Julia; nothing here should take ten minutes.
_LONG = httpx.Timeout(600.0, connect=10.0)
# Any one request of the route sweep; a route that hangs fails the test.
_SWEEP_REQUEST_SECONDS = 120.0

_SIENNA_OPS = [
    "add_disturbance",
    "case_document",
    "clear_disturbances",
    "eig_participation",
    "init_tds",
    "list_disturbances",
    "list_keys",
    "load_case",
    "network_matrix",
    "operating_point",
    "reload_case",
    "run_eig",
    "run_pflow",
    "run_tds",
    "topology",
]

# The case files the module loads, from ANDES's cases folder, by the name they
# have in the workspace.
_CASES = {
    "kundur.raw": "kundur/kundur.raw",
    "kundur_full.dyr": "kundur/kundur_full.dyr",
    "ieee39.raw": "ieee39/ieee39.raw",
    "case14.m": "matpower/case14.m",
    "npcc.raw": "npcc/npcc.raw",
}

# What the comparison with ANDES allows, and the largest differences it saw.
_V_TOL = 2e-5
_ANGLE_TOL = 2e-5
_POWER_TOL = 0.05


@dataclass
class World:
    client: httpx.AsyncClient
    manager: SessionManager
    root: Path
    workspace: Path
    sienna: str
    andes: str
    times: dict[str, float] = field(default_factory=dict)
    diffs: dict[str, dict[str, float]] = field(default_factory=dict)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def world(tmp_path_factory: pytest.TempPathFactory) -> AsyncIterator[World]:
    """One app with a workspace holding the cases, a Sienna session and an ANDES
    session; the manager's idle timeout leaves room for Julia's start."""
    cases = _andes_cases_dir()
    assert cases is not None
    root = tmp_path_factory.mktemp("sienna")
    workspace = root / "ws"
    workspace.mkdir(mode=0o700)
    for name, rel in _CASES.items():
        shutil.copy2(cases / rel, workspace / name)
    (workspace / "case.xlsx").write_bytes(b"PK\x03\x04 not a workbook")
    (workspace / "junk.raw").write_text("this is not a PSS/E case\n1, 2, 3\n", encoding="utf-8")
    shutil.copy2(cases / "kundur" / "kundur.raw", root / "outside.raw")

    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=6,
        idle_timeout_seconds=1800.0,
    )
    manager = SessionManager(max_sessions=6, idle_timeout=1800.0, workspace=str(workspace))
    await manager.start()
    app.state.session_manager = manager
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:8000", timeout=_LONG
        ) as client:
            started = time.monotonic()
            resp = await client.post("/api/sessions", json={"engine": "sienna"})
            assert resp.status_code == 201, resp.text
            sienna = str(resp.json()["session_id"])
            # The first reply waits for the worker's warm-up, which starts Julia.
            resp = await client.get(f"/api/sessions/{sienna}/keys")
            assert resp.status_code == 200, resp.text
            times = {"worker start to first reply": time.monotonic() - started}
            resp = await client.post("/api/sessions", json={"engine": "andes"})
            assert resp.status_code == 201, resp.text
            andes = str(resp.json()["session_id"])
            yield World(client, manager, root, workspace, sienna, andes, times)
    finally:
        await manager.shutdown()


async def _load(
    client: httpx.AsyncClient,
    sid: str,
    primary: str,
    addfiles: list[str] | None = None,
    on_unsupported: str | None = None,
) -> httpx.Response:
    body: dict[str, Any] = {"primary_path": primary}
    if addfiles:
        body["addfiles"] = addfiles
    if on_unsupported is not None:
        body["on_unsupported"] = on_unsupported
    return await client.post(f"/api/sessions/{sid}/case", json=body)


async def _ok(resp_coro: Any) -> Any:
    resp = await resp_coro
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


async def _messages(client: httpx.AsyncClient, sid: str) -> list[dict[str, Any]]:
    body = await _ok(client.get(f"/api/sessions/{sid}/messages"))
    return list(body["messages"])


def _entries(topology: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        entry
        for bucket in ("buses", "lines", "transformers", "generators", "loads", "shunts", "controllers")
        for entry in topology[bucket]
    ]


def _by_key(values: dict[str, Any], keys: dict[str, str]) -> dict[str, Any]:
    """A map of a power flow result re-keyed from idx to element key."""
    out: dict[str, Any] = {}
    for idx, value in values.items():
        key = keys.get(str(idx))
        assert key is not None, f"no key for {idx}"
        assert key not in out, f"two entries keyed {key}"
        out[key] = value
    return out


def _compare(name: str, sienna: dict[str, Any], andes: dict[str, Any]) -> dict[str, float]:
    """Hold the Sienna power flow to the ANDES one through the keys; answer the
    largest difference of each kind."""
    assert sienna["converged"] is True
    assert andes["converged"] is True
    worst: dict[str, float] = {}

    def note(kind: str, value: float) -> None:
        worst[kind] = max(worst.get(kind, 0.0), value)

    s_bus, a_bus = sienna["keys"]["bus"], andes["keys"]["bus"]
    assert set(s_bus.values()) == set(a_bus.values())
    s_v = _by_key(sienna["bus_voltages"], s_bus)
    a_v = _by_key(andes["bus_voltages"], a_bus)
    for key in s_v:
        note("v_pu", abs(s_v[key] - a_v[key]))

    def relative(result: dict[str, Any], keys: dict[str, str]) -> dict[str, float]:
        angles = {int(idx): float(a) for idx, a in result["bus_angles"].items()}
        reference = angles[min(angles)]
        return {keys[str(idx)]: a - reference for idx, a in angles.items()}

    s_a, a_a = relative(sienna, s_bus), relative(andes, a_bus)
    for key in s_a:
        note("angle_rad", abs(s_a[key] - a_a[key]))

    s_lines = _by_key(sienna["line_flows"], sienna["keys"]["line"])
    a_lines = _by_key(andes["line_flows"], andes["keys"]["line"])
    assert set(s_lines) == set(a_lines)
    for key, s in s_lines.items():
        a = a_lines[key]
        s_ends = (s_bus[str(s["from_idx"])], s_bus[str(s["to_idx"])])
        a_ends = (a_bus[str(a["from_idx"])], a_bus[str(a["to_idx"])])
        if s_ends == a_ends:
            pairs = [("p", "p"), ("q", "q"), ("p_to", "p_to"), ("q_to", "q_to")]
        else:
            assert s_ends == a_ends[::-1], key
            pairs = [("p", "p_to"), ("q", "q_to"), ("p_to", "p"), ("q_to", "q")]
        for s_field, a_field in pairs:
            note("branch_" + s_field[0], abs(float(s[s_field]) - float(a[a_field])))
        assert s["rate_a"] == pytest.approx(a["rate_a"]), key
        assert s["loading_pct"] == pytest.approx(a["loading_pct"], abs=0.01), key

    for kind, bucket in (("generator", "generator_outputs"), ("load", "load_consumption")):
        s_map = _by_key(sienna[bucket], sienna["keys"][kind])
        a_map = _by_key(andes[bucket], andes["keys"][kind])
        assert set(s_map) == set(a_map), kind
        for key in s_map:
            note(f"{kind}_p", abs(float(s_map[key]["p"]) - float(a_map[key]["p"])))
            note(f"{kind}_q", abs(float(s_map[key]["q"]) - float(a_map[key]["q"])))

    for kind, value in worst.items():
        if kind == "v_pu":
            limit = _V_TOL
        elif kind == "angle_rad":
            limit = _ANGLE_TOL
        else:
            limit = _POWER_TOL
        assert value <= limit, f"{name}: largest {kind} difference {value:.3g} over {limit}"
    return worst


async def _key_sets(client: httpx.AsyncClient, sid: str) -> dict[str, set[str]]:
    body = await _ok(client.get(f"/api/sessions/{sid}/keys"))
    sets: dict[str, set[str]] = {}
    for entry in body["keys"]:
        sets.setdefault(entry["bucket"], set()).add(entry["key"])
    return sets


async def _against_andes(world: World, name: str, addfiles: list[str] | None = None) -> dict[str, Any]:
    """Load ``name`` in both sessions, run both power flows, compare; answer
    the Sienna topology."""
    c = world.client
    topology = await _ok(_load(c, world.sienna, name, addfiles))
    sienna = await _ok(c.post(f"/api/sessions/{world.sienna}/pflow", json={}))
    await _ok(_load(c, world.andes, name, addfiles))
    andes = await _ok(c.post(f"/api/sessions/{world.andes}/pflow", json={}))
    world.diffs[name] = _compare(name, sienna, andes)
    s_keys, a_keys = await _key_sets(c, world.sienna), await _key_sets(c, world.andes)
    for bucket in ("bus", "line", "transformer", "generator", "load", "shunt"):
        assert s_keys.get(bucket, set()) == a_keys.get(bucket, set()), (name, bucket)
    assert set(s_keys) - {"dynamic"} <= {"bus", "line", "transformer", "generator", "load", "shunt"}, s_keys.keys()
    return topology  # type: ignore[no-any-return]


async def test_engines_lists_sienna(world: World) -> None:
    body = await _ok(world.client.get("/api/engines"))
    sienna = next(e for e in body["engines"] if e["name"] == "sienna")
    assert sienna["available"] is True
    assert sienna["unavailable_reason"] is None
    assert sienna["ops"] == _SIENNA_OPS
    assert sienna["formats"] == {"read": ["psse-raw", "psse-dyr", "matpower"], "write": []}
    assert sienna["routines"] == ["matrices", "pflow", "eig", "tds"]
    assert sienna["routine_options"]["tds"]["disturbances"] == ["branch_trip", "bus_fault", "gen_trip"]
    assert sienna["routine_options"]["tds"]["streaming"] is True
    assert sienna["editing"] is False
    # Read from the project's Manifest without starting Julia.
    assert sienna["versions"]["julia"].startswith("1.")
    assert sienna["versions"]["PowerSystems"]


async def test_a_whole_session(world: World) -> None:
    """Create, load Kundur, read everything the six ops give, reload, solve
    again, then IEEE 39 and case14.m in the same session; every power flow is
    held to an ANDES session's on the same file."""
    c, sid = world.client, world.sienna
    descriptor = await _ok(c.get(f"/api/sessions/{sid}"))
    assert descriptor["engine"] == "sienna"
    assert descriptor["state"] == "live"

    started = time.monotonic()
    topology = await _ok(_load(c, sid, "kundur.raw"))
    world.times["first load (kundur)"] = time.monotonic() - started
    assert len(topology["buses"]) == 10
    assert len(topology["lines"]) + len(topology["transformers"]) == 15
    assert topology["state"] == "pre-setup"
    assert topology["has_dynamics"] is False
    assert all(entry["key"] for entry in _entries(topology))
    assert await _ok(c.get(f"/api/sessions/{sid}/topology")) == {**topology, "job_id": None}

    started = time.monotonic()
    first = await _ok(c.post(f"/api/sessions/{sid}/pflow", json={}))
    world.times["first power flow (kundur)"] = time.monotonic() - started
    assert first["converged"] is True
    assert first["settings"]["flat_start"] is False
    keys_before = await _ok(c.get(f"/api/sessions/{sid}/keys"))
    assert keys_before["keys"]
    point = await _ok(c.get(f"/api/sessions/{sid}/operating-point"))
    assert point["converged"] is True
    assert point["bus_voltages"] == first["bus_voltages"]

    started = time.monotonic()
    reloaded = await _ok(c.post(f"/api/sessions/{sid}/reload"))
    world.times["reload (kundur)"] = time.monotonic() - started
    assert [e["key"] for e in _entries(reloaded)] == [e["key"] for e in _entries(topology)]
    assert await _ok(c.get(f"/api/sessions/{sid}/keys")) == keys_before
    point = await _ok(c.get(f"/api/sessions/{sid}/operating-point"))
    assert point["converged"] is False  # the reload's case as loaded, no power flow yet
    started = time.monotonic()
    again = await _ok(c.post(f"/api/sessions/{sid}/pflow", json={}))
    world.times["later power flow (kundur)"] = time.monotonic() - started
    for field_name in ("bus_voltages", "bus_angles", "line_flows", "generator_outputs", "load_consumption", "keys"):
        assert again[field_name] == first[field_name], field_name

    await _against_andes(world, "kundur.raw")

    started = time.monotonic()
    await _against_andes(world, "ieee39.raw")
    world.times["ieee39 load + power flow + ANDES"] = time.monotonic() - started

    await c.delete(f"/api/sessions/{sid}/messages")
    case14 = await _against_andes(world, "case14.m")
    # The corrections reached the branches they name: no note says otherwise,
    # and the three transformers have the file's ratios.
    texts = [m["text"] for m in await _messages(c, sid)]
    assert not [t for t in texts if "does not hold" in t], texts
    taps = {(e["params"]["bus1"], e["params"]["bus2"]): e["params"]["tap"] for e in case14["transformers"]}
    assert taps == pytest.approx({(4, 7): 0.978, (4, 9): 0.969, (5, 6): 0.932})

    print("\nSienna against ANDES, largest differences:")
    for name, worst in world.diffs.items():
        print(f"  {name}: " + ", ".join(f"{k} {v:.2e}" for k, v in sorted(worst.items())))
    print("Times (s): " + ", ".join(f"{k} {v:.1f}" for k, v in world.times.items()))


async def test_unsupported_dynamic_records(world: World) -> None:
    c, sid = world.client, world.sienna
    await _ok(_load(c, sid, "kundur.raw"))
    resp = await _load(c, sid, "kundur.raw", ["kundur_full.dyr"])
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    for bus in (1, 2, 3, 4):
        assert f"EXDC2 at bus {bus}, id 1" in detail
    assert 'on_unsupported "drop"' in detail
    # The refused load leaves no case, and the session answers as an ANDES one
    # with no case does.
    sienna_none = await c.get(f"/api/sessions/{sid}/topology")
    fresh = await _ok(c.post("/api/sessions", json={"engine": "andes"}))
    try:
        andes_none = await c.get(f"/api/sessions/{fresh['session_id']}/topology")
    finally:
        await c.delete(f"/api/sessions/{fresh['session_id']}")
    assert sienna_none.status_code == andes_none.status_code == 409
    assert sienna_none.json() == andes_none.json()
    assert (await _ok(c.get(f"/api/sessions/{sid}/keys"))) == {"keys": [], "problems": []}
    for path in ("operating-point",):
        assert (await c.get(f"/api/sessions/{sid}/{path}")).status_code == 409
    assert (await c.post(f"/api/sessions/{sid}/pflow", json={})).status_code == 409
    assert (await c.post(f"/api/sessions/{sid}/reload")).status_code == 409

    await c.delete(f"/api/sessions/{sid}/messages")
    topology = await _ok(_load(c, sid, "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop"))
    assert topology["has_dynamics"] is True
    dynamic = topology["controllers"]
    assert dynamic
    for entry in dynamic:
        assert re.fullmatch(r"gen:\d+-\w+/[a-z_]+(:\w+)?(-\d+)?", entry["key"]), entry["key"]
    warnings = [m["text"] for m in await _messages(c, sid) if m["level"] == "warning"]
    for bus in (1, 2, 3, 4):
        assert any(f"EXDC2 at bus {bus}, id 1" in text for text in warnings), warnings

    # An ANDES session ignores on_unsupported.
    topology = await _ok(_load(c, world.andes, "kundur.raw", ["kundur_full.dyr"], on_unsupported="refuse"))
    assert topology["has_dynamics"] is True


async def test_failure_paths(world: World) -> None:
    c, sid = world.client, world.sienna
    await _ok(_load(c, sid, "kundur.raw"))

    resp = await _load(c, sid, "case.xlsx")
    assert resp.status_code == 422, resp.text
    assert "the Sienna engine reads PSS/E .raw and MATPOWER .m case files; case.xlsx is neither" in resp.json()["detail"]

    for missing in ("missing.raw", "../outside.raw", str(world.root / "outside.raw")):
        resp = await _load(c, sid, missing)
        assert resp.status_code == 400, (missing, resp.text)

    resp = await _load(c, sid, "case14.m", ["kundur_full.dyr"])
    assert resp.status_code == 422, resp.text
    assert "a .dyr file goes with a PSS/E .raw case" in resp.json()["detail"]

    resp = await _load(c, sid, "junk.raw")
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail
    assert str(world.root) not in detail and str(world.workspace) not in detail
    assert not re.search(r"[A-Za-z]:[\\/]", detail), detail
    print(f"\njunk.raw: {detail}")
    # A failed load leaves the case held before, as under ANDES.
    assert len((await _ok(c.get(f"/api/sessions/{sid}/topology")))["buses"]) == 10

    for option, value in (("flat_start", True), ("flat_start", False), ("enforce_q_limits", True), ("method", "NR")):
        resp = await c.post(f"/api/sessions/{sid}/pflow", json={option: value})
        assert resp.status_code == 422, (option, resp.text)
        assert option in resp.json()["detail"]
        assert "Sienna engine does not take" in resp.json()["detail"]

    await _ok(_load(c, sid, "ieee39.raw"))
    stalled = await _ok(c.post(f"/api/sessions/{sid}/pflow", json={"max_iterations": 1}))
    assert stalled["converged"] is False
    for table in ("bus_voltages", "bus_angles", "line_flows", "generator_outputs", "load_consumption"):
        assert stalled[table] == {}, table
    assert stalled["settings"]["max_iterations"] == 1
    # A second load after the failed ones works.
    assert len((await _ok(_load(c, sid, "kundur.raw")))["buses"]) == 10


async def test_messages_of_the_corrections(world: World) -> None:
    c, sid = world.client, world.sienna
    paths = re.compile(r"[A-Za-z]:[\\/]|\\\\|/(?:home|Users|tmp)/")
    home = str(Path.home())

    def clean(texts: list[str]) -> None:
        for text in texts:
            assert str(world.root) not in text and home not in text, text
            assert not paths.search(text), text

    await c.delete(f"/api/sessions/{sid}/messages")
    await _ok(_load(c, sid, "ieee39.raw"))
    messages = await _messages(c, sid)
    infos = [m["text"] for m in messages if m["level"] == "info"]
    assert any("voltage setpoint at bus" in t for t in infos), infos
    ratio = [t for t in infos if "31" in t and "6" in t and "0.9" in t]
    assert ratio, infos
    clean([m["text"] for m in messages])
    print("\nieee39 info lines:\n  " + "\n  ".join(infos))

    await c.delete(f"/api/sessions/{sid}/messages")
    await _ok(_load(c, sid, "npcc.raw"))
    messages = await _messages(c, sid)
    infos = [m["text"] for m in messages if m["level"] == "info"]
    warnings = [m["text"] for m in messages if m["level"] == "warning"]
    charging = [t for t in infos if "charging" in t]
    assert len(charging) == 20, charging
    collapsed = [t for t in warnings if "more like it)" in t]
    assert len(collapsed) == 2, warnings
    clean([m["text"] for m in messages])
    print("npcc warnings:\n  " + "\n  ".join(warnings))


# ---- every session route on a Sienna session ---------------------------------

def _openapi() -> dict[str, Any]:
    app = make_app(workspace=Path.cwd(), bind_host="127.0.0.1", bind_port=8000)
    spec: dict[str, Any] = app.openapi()
    return spec


_SPEC = _openapi()


def _session_routes(spec: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    routes = []
    for path, operations in spec["paths"].items():
        if "{session_id}" not in path:
            continue
        for method, operation in operations.items():
            routes.append((method.upper(), path, operation))
    return routes


_SPEC_ROUTES = _session_routes(_SPEC)

# The routes that work on a Sienna session: its ops' and the ones no
# worker op answers. Every other session route answers 409 naming the engines
# that have its op.
_WORKS = {
    ("GET", "/api/sessions/{session_id}"),
    ("POST", "/api/sessions/{session_id}/case"),
    ("GET", "/api/sessions/{session_id}/case/neutral"),
    ("GET", "/api/sessions/{session_id}/topology"),
    ("POST", "/api/sessions/{session_id}/reload"),
    ("GET", "/api/sessions/{session_id}/keys"),
    ("GET", "/api/sessions/{session_id}/network-matrix"),
    ("POST", "/api/sessions/{session_id}/pflow"),
    ("GET", "/api/sessions/{session_id}/operating-point"),
    ("POST", "/api/sessions/{session_id}/eig"),
    ("GET", "/api/sessions/{session_id}/eig/modes/{mode_idx}/participation"),
    ("POST", "/api/sessions/{session_id}/tds"),
    ("POST", "/api/sessions/{session_id}/tds/init"),
    ("POST", "/api/sessions/{session_id}/disturbances"),
    ("GET", "/api/sessions/{session_id}/disturbances"),
    ("POST", "/api/sessions/{session_id}/abort"),
    ("GET", "/api/sessions/{session_id}/jobs"),
    ("GET", "/api/sessions/{session_id}/messages"),
    ("DELETE", "/api/sessions/{session_id}/messages"),
}

# Routes the sweep does not hold to "works or 409", each with its reason.
_EXEMPT = {
    ("DELETE", "/api/sessions/{session_id}"): "closes the session, so it is called on a session of its own; test_a_second_session holds what a close leaves",
    ("GET", "/api/sessions/{session_id}/jobs/{job_id}"): "no worker op; an unknown job id is 404",
    ("DELETE", "/api/sessions/{session_id}/jobs/{job_id}"): "no worker op; an unknown job id is 404",
}

_PATH_VALUES = {
    "model": "Bus",
    "idx": "1",
    "param": "v0",
    "mode_idx": "0",
    "name": "snap",
    "job_id": "0123456789abcdef0123456789abcdef",
    "run_id": "0123456789abcdef0123456789abcdef",
    "pmu_idx": "PMU_1",
    "profile_idx": "1",
}

# Bodies the generator below cannot make valid on its own.
_BODIES: dict[tuple[str, str], Any] = {
    ("POST", "/api/sessions/{session_id}/case"): {"primary_path": "kundur.raw"},
    ("POST", "/api/sessions/{session_id}/pflow"): {},
    ("POST", "/api/sessions/{session_id}/eig"): {},
    ("POST", "/api/sessions/{session_id}/tds"): {"tf": 0.1},
    ("POST", "/api/sessions/{session_id}/tds/init"): {},
    ("POST", "/api/sessions/{session_id}/disturbances"): {
        "disturbances": [{"kind": "fault", "bus_idx": 7, "tf": 0.02, "tc": 0.05, "xf": 0.0001, "rf": 0.0}]
    },
    ("POST", "/api/sessions/{session_id}/save"): {"filename": "copy.xlsx", "format": "xlsx"},
}

# Path values for the routes the server checks before it asks the worker (a
# clone edit names a controller model and one of its parameters).
_ROUTE_PATH_VALUES: dict[str, dict[str, str]] = {
    "/api/sessions/{session_id}/case/clone/params/{model}/{idx}/{param}": {"model": "TGOV1", "param": "R"},
    "/api/sessions/{session_id}/case/clone/diff/{model}/{idx}": {"model": "TGOV1"},
}


def _resolve(schema: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    while "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[1]
        schema = spec["components"]["schemas"][name]
    return schema


def _minimal(schema: dict[str, Any], spec: dict[str, Any]) -> Any:
    """A minimal value the schema accepts: required fields only, the first of
    an enum or a union, a default where one is given."""
    schema = _resolve(schema, spec)
    for union in ("anyOf", "oneOf"):
        if union in schema:
            options = [o for o in schema[union] if _resolve(o, spec).get("type") != "null"]
            return _minimal(options[0], spec)
    if "allOf" in schema:
        return _minimal(schema["allOf"][0], spec)
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    if schema.get("default") is not None:
        return schema["default"]
    kind = schema.get("type")
    if kind == "object" or "properties" in schema:
        props = schema.get("properties", {})
        return {name: _minimal(props[name], spec) for name in schema.get("required", [])}
    if kind == "array":
        return [_minimal(schema.get("items", {}), spec) for _ in range(schema.get("minItems", 0))]
    if kind == "string":
        return "x" * max(1, schema.get("minLength", 1))
    if kind == "integer":
        return max(1, int(schema.get("minimum", 1)))
    if kind == "number":
        return max(1.0, float(schema.get("minimum", 1.0)))
    if kind == "boolean":
        return False
    return None


def _request_for(method: str, path: str, operation: dict[str, Any], sid: str, spec: dict[str, Any]) -> dict[str, Any]:
    url = path.replace("{session_id}", sid)
    for name, value in {**_PATH_VALUES, **_ROUTE_PATH_VALUES.get(path, {})}.items():
        url = url.replace("{" + name + "}", value)
    kwargs: dict[str, Any] = {}
    params = {
        p["name"]: _minimal(p.get("schema", {}), spec)
        for p in operation.get("parameters", [])
        if p["in"] == "query" and p.get("required")
    }
    if path.endswith("/report"):
        params["routine"] = "pflow"
    if params:
        kwargs["params"] = params
    body = operation.get("requestBody")
    if (method, path) in _BODIES:
        kwargs["json"] = _BODIES[(method, path)]
    elif body is not None:
        content = body["content"]
        if "application/json" in content:
            kwargs["json"] = _minimal(content["application/json"]["schema"], spec)
        else:
            schema = _resolve(content["multipart/form-data"]["schema"], spec)
            files, data = {}, {}
            for name in schema.get("required", []):
                prop = _resolve(schema["properties"][name], spec)
                if prop.get("format") == "binary" or prop.get("contentMediaType"):
                    files[name] = (f"{name}.bin", b"t,v\n0,1\n")
                else:
                    data[name] = str(_minimal(prop, spec))
            kwargs["files"] = files
            if data:
                kwargs["data"] = data
    return {"method": method, "url": "/" + url.lstrip("/"), **kwargs}


async def _abort_while_idle_is_spent_by_the_next_run(c: Any, sid: str) -> None:
    """The abort the sweep sent with nothing running stops the next run at its
    first step, as on the ANDES engine, and that run spends it: the run after
    completes. This also leaves the shared session with no abort pending."""
    await _ok(_load(c, sid, "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop"))
    await _ok(c.post(f"/api/sessions/{sid}/pflow", json={}))
    stopped = await _ok(c.post(f"/api/sessions/{sid}/tds", json={"tf": 0.1}))
    assert stopped["converged"] is False
    assert stopped["final_t"] == 0.0
    completed = await _ok(c.post(f"/api/sessions/{sid}/tds", json={"tf": 0.1}))
    assert completed["converged"] is True, completed


@pytest.mark.parametrize(
    ("method", "path", "operation"),
    _SPEC_ROUTES,
    ids=[f"{m} {p}" for m, p, _ in _SPEC_ROUTES],
)
async def test_every_session_route_works_or_is_refused(
    world: World, method: str, path: str, operation: dict[str, Any]
) -> None:
    """The seam holds: a session route on a Sienna session either works (its
    ops' routes, and the ones no worker op answers) or answers 409 naming
    the engines that have its op. None answers 500 or hangs."""
    c, sid = world.client, world.sienna
    if (method, path) == ("DELETE", "/api/sessions/{session_id}"):
        # Not on the shared session: on one of its own, closed while its worker
        # is still starting Julia.
        sid = str((await _ok(c.post("/api/sessions", json={"engine": "sienna"})))["session_id"])
    topology = await c.get(f"/api/sessions/{sid}/topology")
    if topology.status_code != 200 and sid == world.sienna:
        await _ok(_load(c, sid, "kundur.raw"))
    if (method, path) in (
        ("POST", "/api/sessions/{session_id}/eig"),
        ("GET", "/api/sessions/{session_id}/eig/modes/{mode_idx}/participation"),
        ("POST", "/api/sessions/{session_id}/tds"),
        ("POST", "/api/sessions/{session_id}/tds/init"),
        ("POST", "/api/sessions/{session_id}/disturbances"),
    ):
        # The eig routes need a case with dynamic models and a solved power
        # flow; the sweep's shared session loads Kundur without its .dyr.
        descriptor = await _ok(c.get(f"/api/sessions/{sid}"))
        del descriptor
        topo = await c.get(f"/api/sessions/{sid}/topology")
        if topo.status_code != 200 or not topo.json().get("has_dynamics"):
            await _ok(_load(c, sid, "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop"))
        point = await c.get(f"/api/sessions/{sid}/operating-point")
        if point.status_code != 200 or not point.json().get("converged"):
            await _ok(c.post(f"/api/sessions/{sid}/pflow", json={}))
        if (method, path) == ("GET", "/api/sessions/{session_id}/eig/modes/{mode_idx}/participation"):
            await _ok(c.post(f"/api/sessions/{sid}/eig", json={}))
        if (method, path) == ("POST", "/api/sessions/{session_id}/disturbances"):
            # A fault on bus 7 needs the plain Kundur case (the .dyr load of
            # the eig routes leaves the same buses, so either is fine).
            pass
    request = _request_for(method, path, operation, sid, _SPEC)
    resp = await asyncio.wait_for(c.request(**request), timeout=_SWEEP_REQUEST_SECONDS)
    where = f"{method} {path}: {resp.status_code} {resp.text[:400]}"
    assert resp.status_code < 500, where
    if (method, path) in _EXEMPT:
        assert resp.status_code in (200, 204, 404), where
    elif (method, path) in _WORKS:
        assert resp.status_code in (200, 201, 202, 204), where
        if (method, path) == ("POST", "/api/sessions/{session_id}/abort"):
            await _abort_while_idle_is_spent_by_the_next_run(c, sid)
    else:
        assert resp.status_code == 409, where
        detail = resp.json()["detail"]
        assert "is not available with the sienna engine" in detail, where
        assert "engines that have it: andes" in detail, where


# ---- the eigenvalue analysis -------------------------------------------------

async def test_eig_against_andes(world: World) -> None:
    """Kundur with its .dyr in both engines: the four oscillatory modes of the
    P5-A table match within the tolerance, the Sienna result carries the PSID
    validation note, and the participation route answers on both."""
    c = world.client
    await _ok(_load(c, world.sienna, "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop"))
    await _ok(c.post(f"/api/sessions/{world.sienna}/pflow", json={}))
    await _ok(_load(c, world.andes, "kundur.raw", ["kundur_full.dyr"]))
    await _ok(c.post(f"/api/sessions/{world.andes}/pflow", json={}))

    started = time.monotonic()
    sienna = await _ok(c.post(f"/api/sessions/{world.sienna}/eig", json={"load_model": "impedance"}))
    world.times["first eig (kundur)"] = time.monotonic() - started
    andes = await _ok(c.post(f"/api/sessions/{world.andes}/eig", json={}))
    assert sienna["mode_count"] == 32
    assert sienna["load_model"] == "impedance"
    assert sienna["notes"] == [
        "PSID's small-signal results are work in progress in validation, "
        "by PSID's own documentation."
    ]
    assert andes["load_model"] is None
    assert andes["notes"] == []

    def has_mode(result: dict[str, Any], frequency: float, damping: float) -> bool:
        return any(
            abs(result["frequencies_hz"][i] - frequency) <= 5e-4
            and abs(result["damping_ratios"][i] - damping) <= 5e-4
            for i in range(result["mode_count"])
        )

    # The spike's four modes are those of four GENROU with TGOV1 and impedance
    # loads, which is what Sienna simulates of this file (PowerSystems leaves
    # the EXDC2 exciters out). ANDES keeps the exciters, so its modes are not
    # these; the like-for-like comparison builds a .dyr without them.
    for frequency, damping in (
        (0.0684, 0.6295),
        (0.6540, 0.0458),
        (1.1077, 0.0921),
        (1.1411, 0.0941),
    ):
        assert has_mode(sienna, frequency, damping), (frequency, damping)
    assert andes["mode_count"] > 32

    for sid, modes in ((world.sienna, 32), (world.andes, andes["mode_count"])):
        part = await _ok(c.get(f"/api/sessions/{sid}/eig/modes/0/participation"))
        assert part["mode_idx"] == 0
        assert len(part["participation"]) == modes


async def test_eig_refusals(world: World) -> None:
    c = world.client
    await _ok(_load(c, world.sienna, "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop"))
    resp = await c.post(f"/api/sessions/{world.sienna}/eig", json={})
    assert resp.status_code == 409, resp.text
    assert "PFlow" in resp.json()["detail"]
    resp = await c.get(f"/api/sessions/{world.sienna}/eig/modes/0/participation")
    assert resp.status_code == 409, resp.text

    await _ok(_load(c, world.andes, "kundur.raw", ["kundur_full.dyr"]))
    await _ok(c.post(f"/api/sessions/{world.andes}/pflow", json={}))
    resp = await c.post(f"/api/sessions/{world.andes}/eig", json={"load_model": "power"})
    assert resp.status_code == 422, resp.text
    assert (
        "the ANDES engine converts loads to constant impedance for the "
        "eigenvalue analysis; load_model power is not available with it"
        in resp.json()["detail"]
    )
    for sid in (world.sienna, world.andes):
        resp = await c.post(f"/api/sessions/{sid}/eig", json={"load_model": "bad"})
        assert resp.status_code == 422, resp.text

    # A case with no dynamic models is refused with the Julia answer's stage.
    await _ok(_load(c, world.sienna, "kundur.raw"))
    await _ok(c.post(f"/api/sessions/{world.sienna}/pflow", json={}))
    resp = await c.post(f"/api/sessions/{world.sienna}/eig", json={})
    assert resp.status_code == 422, resp.text
    assert "eigenvalue analysis failed at" in resp.json()["detail"]


# ---- the batch time-domain run and its disturbances ---------------------------

async def test_tds_batch_against_the_api(world: World) -> None:
    """One batch run on Kundur with its .dyr: converged, final_t at tf, neutral
    trace names, and the disturbances round-trip through the route."""
    c, sid = world.client, world.sienna
    await _ok(_load(c, sid, "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop"))
    await _ok(c.post(f"/api/sessions/{sid}/pflow", json={}))

    assert await _ok(c.get(f"/api/sessions/{sid}/disturbances")) == {"disturbances": []}
    fault = {"kind": "fault", "bus_idx": 7, "tf": 0.05, "tc": 0.1, "xf": 0.0001, "rf": 0.0}
    posted = await _ok(c.post(f"/api/sessions/{sid}/disturbances", json={"disturbances": [fault]}))
    assert posted["accepted"] == [{"kind": "fault", "idx": "0"}]
    listed = await _ok(c.get(f"/api/sessions/{sid}/disturbances"))
    assert listed["disturbances"] == [fault]

    started = time.monotonic()
    result = await _ok(c.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2}))
    world.times["first tds (kundur, fault)"] = time.monotonic() - started
    if result["converged"] is not True:
        messages = await _ok(c.get(f"/api/sessions/{sid}/messages"))
        texts = [m["text"] for m in messages["messages"]][-8:]
        raise AssertionError(f"the run did not converge: final_t {result['final_t']}; {texts}")
    assert result["final_t"] == pytest.approx(0.2)
    assert result["integrator"] == "ida"
    names = [v["name"] for v in result["traces"]["variables"]]
    assert "voltage|bus:7" in names
    assert "rotor_speed|gen:1-1" in names
    assert "angle_rel|bus:7" in names
    assert not [n for n in names if n.startswith("rotor_angle_rel|")]

    # A Toggle that closes a branch is refused (the Julia module has no
    # branch_close), and an Alter is refused naming what the engine takes.
    resp = await c.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "alter", "model": "PQ", "dev_idx": "PQ_1", "src": "p0", "t": 1.0, "method": "*", "amount": 1.2}]},
    )
    assert resp.status_code == 422, resp.text
    assert "it does not take an Alter" in resp.json()["detail"]

    # An option the engine does not have is a 422 naming it.
    resp = await c.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2, "integrator": "qndf"})
    assert resp.status_code == 422, resp.text
    assert "integrator" in resp.json()["detail"]

    # tds_init answers the initialisation report.
    init = await _ok(c.post(f"/api/sessions/{sid}/tds/init", json={}))
    assert init["initialized"] is True
    assert init["test_ok"] is True
    # Four machines of eight states each, and the real and imaginary voltage
    # of each of the ten buses.
    assert init["n_states"] == 32
    assert init["n_algeb"] == 20
    resp = await c.post(f"/api/sessions/{sid}/tds/init", json={"test_init": False})
    assert resp.status_code == 422, resp.text
    assert "test_init" in resp.json()["detail"]


async def test_tds_abort_lands_short_of_tf(world: World) -> None:
    """An abort signalled while a run is in flight ends it with 0 < final_t <
    tf, the spec's abort channel (section 13), and is spent by that run. The
    run is long enough (an hour of simulated time; Kundur's minute takes under
    two seconds once Julia is warm) that the abort lands while it steps."""
    c, sid = world.client, world.sienna
    await _ok(_load(c, sid, "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop"))
    await _ok(c.post(f"/api/sessions/{sid}/pflow", json={}))
    tf = 3600.0

    async def _abort_soon() -> None:
        await asyncio.sleep(2.0)
        await c.post(f"/api/sessions/{sid}/abort")

    aborter = asyncio.create_task(_abort_soon())
    try:
        result = await _ok(c.post(f"/api/sessions/{sid}/tds", json={"tf": tf}))
    finally:
        await aborter
    assert result["converged"] is False
    assert 0.0 < result["final_t"] < tf, result["final_t"]
    after = await _ok(c.post(f"/api/sessions/{sid}/tds", json={"tf": 0.1}))
    assert after["converged"] is True


# ---- a second session: two Julias, a quiet worker, a close -------------------

async def test_a_second_session(world: World, capfd: pytest.CaptureFixture[str]) -> None:
    """A second Sienna session runs its own worker, so its own Julia; it prints
    nothing but what it logs on ``tensa.notice`` (no strict-fs warning for the
    Sienna project folder, no juliapkg or Julia output); closing it ends its
    worker and removes its scratch folder. The worker inherits this test's
    stderr, which ``capfd`` reads."""
    c, manager = world.client, world.manager
    started = time.monotonic()
    other = str((await _ok(c.post("/api/sessions", json={"engine": "sienna"})))["session_id"])
    await _ok(_load(c, other, "kundur.raw"))
    world.times["second session: create + first load"] = time.monotonic() - started
    started = time.monotonic()
    assert (await _ok(c.post(f"/api/sessions/{other}/pflow", json={})))["converged"] is True
    world.times["second session: first power flow"] = time.monotonic() - started

    first_proc = manager._sessions[world.sienna].process
    other_proc = manager._sessions[other].process
    assert first_proc.pid != other_proc.pid
    assert first_proc.is_alive() and other_proc.is_alive()
    session_root = world.workspace / SESSIONS_DIRNAME / other
    assert (session_root / "sienna").is_dir()
    assert (session_root / OWNER_MARKER_NAME).is_file()
    logged = {m["text"] for m in await _messages(c, other)}

    resp = await c.delete(f"/api/sessions/{other}")
    assert resp.status_code in (200, 204), resp.text
    assert not other_proc.is_alive()
    assert other_proc.pid is not None and not pid_is_alive(other_proc.pid)
    assert not session_root.exists()
    assert first_proc.is_alive()

    captured = capfd.readouterr()
    assert "strict-fs" not in captured.err, captured.err
    assert "juliapkg" not in captured.out + captured.err
    assert "julia:" not in captured.err
    stray = [
        line
        for line in captured.err.splitlines()
        if line.strip() and line.strip() not in logged and "SPA bundle" not in line
    ]
    assert stray == [], captured.err
    assert captured.out.strip() == "", captured.out
    print("\nTimes (s): " + ", ".join(f"{k} {v:.1f}" for k, v in world.times.items()))


async def test_samples_script_matches_the_committed_samples(tmp_path: Path) -> None:
    """``scripts/make_sienna_samples.py`` into a temporary folder answers what
    the committed samples hold, every number within 1e-9."""
    out = tmp_path / "samples"
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")}
    done = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, str(_SCRIPT), str(out)],
        capture_output=True,
        text=True,
        timeout=1800,
        env=env,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert done.stdout.splitlines() == [f"{name}: ok" for name in _sample_names()]
    for path in sorted(_SAMPLES.glob("*.json")):
        fresh = json.loads((out / path.name).read_text("utf-8"))
        _same(fresh, json.loads(path.read_text("utf-8")), path.name)
    report = json.loads((out / "case14_m.report.json").read_text("utf-8"))
    assert not [n for n in report["notes"] if "does not hold" in n["text"]]


def _sample_names() -> list[str]:
    return ["kundur", "kundur_dyr", "ieee14", "ieee14_dyr", "ieee39", "wscc9", "npcc", "wecc", "case14_m"]


def _same(fresh: Any, recorded: Any, where: str) -> None:
    """Equal JSON values, their numbers within 1e-9."""
    if isinstance(recorded, dict):
        assert isinstance(fresh, dict) and set(fresh) == set(recorded), where
        for key in recorded:
            _same(fresh[key], recorded[key], f"{where}.{key}")
    elif isinstance(recorded, list):
        assert isinstance(fresh, list) and len(fresh) == len(recorded), where
        for index, item in enumerate(recorded):
            _same(fresh[index], item, f"{where}[{index}]")
    elif isinstance(recorded, bool) or recorded is None or isinstance(recorded, str):
        assert fresh == recorded, where
    else:
        assert isinstance(fresh, int | float) and not isinstance(fresh, bool), where
        assert math.isclose(fresh, recorded, rel_tol=1e-9, abs_tol=1e-9), where


# ---- last: a worker that dies -------------------------------------------------

async def test_a_killed_worker_reports_as_an_andes_one(world: World) -> None:
    """Kill the worker of each engine's session: the next request answers the
    same for both, and a new session of the engine can be made."""
    c, manager = world.client, world.manager
    answers = {}
    for sid in (world.andes, world.sienna):
        proc = manager._sessions[sid].process
        proc.kill()
        await asyncio.to_thread(proc.join, 30)
        topology = await c.get(f"/api/sessions/{sid}/topology")
        descriptor = await c.get(f"/api/sessions/{sid}")
        listed = await _ok(c.get("/api/sessions"))
        answers[sid] = (
            topology.status_code,
            {k: v for k, v in topology.json().items() if k != "detail"},
            descriptor.status_code,
            sid in {s["session_id"] for s in listed["sessions"]},
        )
        print(f"\nafter kill ({manager_engine(sid, world)}): topology {topology.text}; descriptor {descriptor.status_code} {descriptor.text}")
    assert answers[world.andes] == answers[world.sienna]
    fresh = await _ok(c.post("/api/sessions", json={"engine": "sienna"}))
    assert fresh["engine"] == "sienna"
    await c.delete(f"/api/sessions/{fresh['session_id']}")


def manager_engine(sid: str, world: World) -> str:
    return "sienna" if sid == world.sienna else "andes"
