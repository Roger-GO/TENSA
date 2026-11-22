"""Workflow tests for the keys of a case and the engine of a session, end to end
through the API.

Each test is one sequence of calls a user's session makes (create, load, read
the topology and the keys, run, edit, reload) over a real app with real worker
subprocesses, and asserts what must hold across the whole sequence. The
expected keys come from a small reader of the PSS/E ``.raw`` file written in
this module (the oracle, ``read_raw_keys``), never from TENSA's own reader, so
the server is compared with the file and not with itself.

Same fixtures and client as ``tests/integration/test_keys_api.py``.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration

_MAX_SESSIONS = 4

_TOPOLOGY_BUCKETS = (
    "buses",
    "lines",
    "transformers",
    "generators",
    "loads",
    "shunts",
    "controllers",
)

# The kinds of the static generators among the entries of ``generators``,
# which also holds the machines of a case with dynamics.
_STATIC_GENERATOR_KINDS = ("PV", "Slack")


def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh app whose workspace holds
    the IEEE 14 case with its dynamics addfile and the Kundur case."""
    cases = _bundled_cases_dir()
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for src in (
        cases / "ieee14" / "ieee14.raw",
        cases / "ieee14" / "ieee14.dyr",
        cases / "kundur" / "kundur.raw",
    ):
        shutil.copy2(src, workspace / src.name)

    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=_MAX_SESSIONS,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=_MAX_SESSIONS, idle_timeout=180.0)
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


# ---- the oracle: a small PSS/E .raw reader (revisions 32 and 33) -----------

# The data sections of a revision 32 or 33 file, in file order; each is ended
# by a line whose first field is 0, and the file by ``Q``.
_SECTIONS = (
    "bus",
    "load",
    "fixed shunt",
    "generator",
    "branch",
    "transformer",
    "area",
    "two-terminal dc",
    "vsc dc",
    "impedance correction",
    "multi-terminal dc",
    "multi-section line",
    "zone",
    "inter-area transfer",
    "owner",
    "facts",
    "switched shunt",
    "gne",
)


def _fields(line: str) -> list[str]:
    """The comma-separated fields of one record, quotes and spaces stripped."""
    out: list[str] = []
    for part in line.split(","):
        text = part.strip()
        if len(text) >= 2 and text.startswith("'") and text.endswith("'"):
            text = text[1:-1]
        out.append(text.strip())
    return out


def _is_section_end(line: str) -> bool:
    """Whether ``line`` ends a section: its first field, before any ``/``
    comment, is ``0`` (``0`` alone, or ``0 /End of ...``)."""
    return line.split("/", 1)[0].split(",", 1)[0].strip() == "0"


def _raw_sections(path: Path) -> dict[str, list[str]]:
    """The non-empty lines of every data section of a PSS/E ``.raw`` file of
    revision 32 or 33, by section name. Raises on another revision, and on a
    file whose sections do not end as the format says."""
    lines = path.read_text(encoding="utf-8").splitlines()
    revision = int(_fields(lines[0].split("/", 1)[0])[2])
    if revision not in (32, 33):
        raise ValueError(f"{path.name} is PSS/E revision {revision}; the oracle reads 32 and 33")
    sections: dict[str, list[str]] = {}
    current: list[str] = []
    for line in lines[3:]:  # the three header lines
        if line.strip() == "Q":
            break
        if _is_section_end(line):
            if len(sections) == len(_SECTIONS):
                raise ValueError(f"{path.name} has more sections than revision {revision}")
            sections[_SECTIONS[len(sections)]] = current
            current = []
        elif line.strip():
            current.append(line)
    if len(sections) != len(_SECTIONS) or current:
        raise ValueError(f"{path.name} does not end its sections as revision {revision} does")
    return sections


def read_raw_keys(path: Path) -> dict[str, set[str]]:
    """The keys a PSS/E ``.raw`` file (revision 32 or 33) gives its elements,
    as sets by kind: ``bus``, ``branch`` (lines and two-winding transformers),
    ``gen``, ``load`` and ``shunt`` (fixed and switched).

    A fixed shunt's id is the file's own. A switched shunt record has no id, so
    it takes the first ordinal on its bus that no shunt before it holds (the
    fixed shunts come first in the file). Raises on a three-winding
    transformer, which neither file this suite reads has.
    """
    sections = _raw_sections(path)
    keys: dict[str, set[str]] = {
        "bus": {f"bus:{_fields(line)[0]}" for line in sections["bus"]},
        "load": {
            f"load:{record[0]}-{record[1]}"
            for record in map(_fields, sections["load"])
        },
        "shunt": {
            f"shunt:{record[0]}-{record[1]}"
            for record in map(_fields, sections["fixed shunt"])
        },
        "gen": {
            f"gen:{record[0]}-{record[1]}"
            for record in map(_fields, sections["generator"])
        },
        "branch": {
            f"branch:{record[0]}-{abs(int(record[1]))}-{record[2]}"
            for record in map(_fields, sections["branch"])
        },
    }

    # A two-winding transformer record is four lines, the first with K = 0.
    transformers = sections["transformer"]
    for start in range(0, len(transformers), 4):
        first = _fields(transformers[start])
        if first[2] != "0":
            raise ValueError(
                f"{path.name} has a three-winding transformer {first[0]}-{first[1]}-"
                f"{first[2]}: the oracle reads two-winding records only"
            )
        keys["branch"].add(f"branch:{first[0]}-{abs(int(first[1]))}-{first[3]}")
    if len(transformers) % 4:
        raise ValueError(f"{path.name}: the transformer section is not whole records")

    for record in map(_fields, sections["switched shunt"]):
        ordinal = 1
        while f"shunt:{record[0]}-{ordinal}" in keys["shunt"]:
            ordinal += 1
        keys["shunt"].add(f"shunt:{record[0]}-{ordinal}")
    return keys


def _all_keys(oracle: dict[str, set[str]]) -> set[str]:
    """Every key the oracle gives a file."""
    return set().union(*oracle.values())


# ---- helpers ---------------------------------------------------------------


async def _session_with_case(
    client: httpx.AsyncClient,
    primary: str,
    addfiles: list[str] | None = None,
) -> str:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    if addfiles:
        body["addfiles"] = addfiles
    resp = await client.post(f"/api/sessions/{sid}/case", json=body)
    assert resp.status_code == 200, resp.text
    return sid


async def _close(client: httpx.AsyncClient, sid: str) -> None:
    resp = await client.delete(f"/api/sessions/{sid}")
    assert resp.status_code == 204, resp.text


async def _topology(client: httpx.AsyncClient, sid: str) -> dict[str, object]:
    resp = await client.get(f"/api/sessions/{sid}/topology")
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


async def _key_list(client: httpx.AsyncClient, sid: str) -> dict[str, object]:
    """``GET /keys``, held to a clean book: for the two files these tests read,
    at every step, no key carries the ``~N`` suffix ``KeyBook.assign`` gives a
    key that another element holds, and the assignment noted no problem. Every
    listing a test reads goes through here, so a regression that reaches that
    fallback fails at the step that caused it."""
    resp = await client.get(f"/api/sessions/{sid}/keys")
    assert resp.status_code == 200, resp.text
    body = dict(resp.json())
    suffixed = sorted(str(e["key"]) for e in body["keys"] if "~" in str(e["key"]))  # type: ignore[attr-defined]
    assert not suffixed, f"no key may carry the ~N suffix of a held key: {suffixed}"
    assert body["problems"] == [], f"the key assignment must note no problem: {body['problems']}"
    return body


async def _add_element(
    client: httpx.AsyncClient, sid: str, model: str, params: dict[str, object]
) -> None:
    resp = await client.post(
        f"/api/sessions/{sid}/elements", json={"model": model, "params": params}
    )
    assert resp.status_code == 201, resp.text


async def _add_load(
    client: httpx.AsyncClient, sid: str, idx: str, bus: str, vn: float = 69.0
) -> None:
    await _add_element(
        client,
        sid,
        "PQ",
        {"idx": idx, "name": idx, "bus": bus, "Vn": vn, "p0": 0.05, "q0": 0.01},
    )


def _entries(topology: dict[str, object], *buckets: str) -> list[dict[str, object]]:
    """The entries of the named buckets of a topology (all when none named)."""
    return [
        entry
        for bucket in (buckets or _TOPOLOGY_BUCKETS)
        for entry in topology[bucket]  # type: ignore[attr-defined]
    ]


def _bucket_keys(topology: dict[str, object], *buckets: str) -> set[str]:
    return {str(entry["key"]) for entry in _entries(topology, *buckets)}


def _static_generator_keys(topology: dict[str, object]) -> set[str]:
    return {
        str(entry["key"])
        for entry in _entries(topology, "generators")
        if entry["kind"] in _STATIC_GENERATOR_KINDS
    }


def _keys_of_topology(topology: dict[str, object]) -> dict[tuple[str, str], str]:
    """The key of every topology entry, by ``(kind, idx as text)``."""
    out: dict[tuple[str, str], str] = {}
    for entry in _entries(topology):
        handle = (str(entry["kind"]), str(entry["idx"]))
        assert handle not in out, f"two topology entries have the handle {handle}"
        out[handle] = str(entry["key"])
    return out


def _keys_of_listing(body: dict[str, object]) -> dict[tuple[str, str], tuple[str, str, str]]:
    """Every entry of a ``GET /keys`` answer, by ``(model, idx as text)``: its
    key, bucket and source. A book keeps an entry as it was given, so all three
    stay the same for an element nothing changed."""
    out: dict[tuple[str, str], tuple[str, str, str]] = {}
    for entry in body["keys"]:  # type: ignore[attr-defined]
        handle = (str(entry["model"]), str(entry["idx"]))
        assert handle not in out, f"GET /keys lists the handle {handle} twice"
        out[handle] = (str(entry["key"]), str(entry["bucket"]), str(entry["source"]))
    return out


def _listed_keys(body: dict[str, object]) -> set[str]:
    return {str(entry["key"]) for entry in body["keys"]}  # type: ignore[attr-defined]


def _assert_same_keys(before: dict[tuple[str, str], object], after: dict[tuple[str, str], object], when: str) -> None:
    assert before, f"nothing was kept to compare {when}"
    assert after == before, (
        f"the keys must not change {when}: "
        f"lost {sorted(set(before) - set(after))}, "
        f"gained {sorted(set(after) - set(before))}, "
        f"changed {sorted((h, before[h], after[h]) for h in before if h in after and before[h] != after[h])}"
    )


def _assert_keys_are_the_files(topology: dict[str, object], oracle: dict[str, set[str]], when: str) -> None:
    """Each bucket of the topology carries exactly the keys the file gives."""
    for kind in ("bus", "branch", "gen", "load"):
        assert oracle[kind], f"the oracle read no {kind} from the file"
    got_buses = _bucket_keys(topology, "buses")
    assert got_buses == oracle["bus"], (
        f"the bus keys {when} must be the file's bus numbers: "
        f"missing {sorted(oracle['bus'] - got_buses)}, extra {sorted(got_buses - oracle['bus'])}"
    )
    got_branches = _bucket_keys(topology, "lines", "transformers")
    assert got_branches == oracle["branch"], (
        f"the keys of lines and transformers {when} must be the file's branches: "
        f"missing {sorted(oracle['branch'] - got_branches)}, "
        f"extra {sorted(got_branches - oracle['branch'])}"
    )
    got_loads = _bucket_keys(topology, "loads")
    assert got_loads == oracle["load"], (
        f"the load keys {when} must be the file's loads: "
        f"missing {sorted(oracle['load'] - got_loads)}, extra {sorted(got_loads - oracle['load'])}"
    )
    got_shunts = _bucket_keys(topology, "shunts")
    assert got_shunts == oracle["shunt"], (
        f"the shunt keys {when} must be the file's fixed and switched shunts: "
        f"missing {sorted(oracle['shunt'] - got_shunts)}, extra {sorted(got_shunts - oracle['shunt'])}"
    )
    got_gens = _static_generator_keys(topology)
    assert got_gens == oracle["gen"], (
        f"the keys of the static generators {when} must be the file's generators: "
        f"missing {sorted(oracle['gen'] - got_gens)}, extra {sorted(got_gens - oracle['gen'])}"
    )


# ---- 1. from a file to results ----------------------------------------------


async def test_from_a_file_to_results(client: httpx.AsyncClient) -> None:
    """Load IEEE 14 with its dynamics, read the topology and ``GET /keys``, run
    the power flow and read a voltage through its key: every element carries
    the key the file gives it, wherever a client looks.
    Fails if a bucket of the topology has no key or keys other than the file's,
    if ``GET /keys`` gives a key to another (model, idx) than the topology
    does, or if the result's ``keys`` lookup is built from another bucket."""
    oracle = read_raw_keys(_bundled_cases_dir() / "ieee14" / "ieee14.raw")
    assert oracle["shunt"], "the oracle read no shunt from ieee14.raw, which has two"
    sid = await _session_with_case(client, "ieee14.raw", ["ieee14.dyr"])
    try:
        topology = await _topology(client, sid)
        entries = _entries(topology)
        assert entries, "the topology lists no element"
        keys = [entry["key"] for entry in entries]
        missing = [
            (entry["kind"], entry["idx"])
            for entry in entries
            if not (isinstance(entry["key"], str) and entry["key"])
        ]
        assert not missing, f"every topology entry must carry a non-empty key; these do not: {missing}"
        assert len(set(keys)) == len(keys), (
            f"no key may occur twice in the topology: {sorted(k for k in set(keys) if keys.count(k) > 1)}"
        )
        _assert_keys_are_the_files(topology, oracle, "of IEEE 14")

        listing = await _key_list(client, sid)
        listed = _keys_of_listing(listing)
        by_handle = _keys_of_topology(topology)
        assert {key for key, _, _ in listed.values()} == set(keys), (
            "GET /keys must list exactly the keys of the topology: "
            f"{sorted({key for key, _, _ in listed.values()} ^ set(keys))}"
        )
        for handle, (key, _, _) in listed.items():
            assert by_handle.get(handle) == key, (
                f"GET /keys gives {handle} the key {key}, the topology entry with that "
                f"kind and idx carries {by_handle.get(handle)}"
            )

        resp = await client.post(f"/api/sessions/{sid}/pflow", json={})
        assert resp.status_code == 200, resp.text
        result = resp.json()
        assert result["converged"] is True, "the power flow of IEEE 14 must converge"
        plans = (
            ("bus", "bus_voltages", ("buses",), None),
            ("line", "line_flows", ("lines", "transformers"), None),
            ("generator", "generator_outputs", ("generators",), _STATIC_GENERATOR_KINDS),
            ("load", "load_consumption", ("loads",), None),
        )
        for name, field, buckets, kinds in plans:
            values = result[field]
            mapped = result["keys"][name]
            assert values, f"the power flow result has no {field}"
            assert set(mapped) == {str(idx) for idx in values}, (
                f"keys.{name} must map every idx of {field} and nothing else: "
                f"{sorted(set(mapped) ^ {str(idx) for idx in values})}"
            )
            expected = {
                str(entry["idx"]): str(entry["key"])
                for entry in _entries(topology, *buckets)
                if kinds is None or entry["kind"] in kinds
            }
            for idx, key in mapped.items():
                assert key == expected.get(idx), (
                    f"keys.{name} maps idx {idx} to {key}; the topology's {'/'.join(buckets)} "
                    f"entry with that idx carries {expected.get(idx)}"
                )

        # Read one value through a key, the way a client comparing engines would.
        holders = [entry for entry in listing["keys"] if entry["key"] == "bus:1"]  # type: ignore[attr-defined]
        assert len(holders) == 1 and holders[0]["model"] == "Bus", (
            f"GET /keys must give bus:1 to exactly one Bus: {holders}"
        )
        through_key = result["bus_voltages"][str(holders[0]["idx"])]
        bus_one = [entry for entry in topology["buses"] if str(entry["idx"]) == "1"]  # type: ignore[attr-defined]
        assert len(bus_one) == 1, "the topology must have one bus of idx 1"
        through_topology = result["bus_voltages"][str(bus_one[0]["idx"])]
        assert through_key == through_topology, (
            f"the voltage of bus:1 read through GET /keys is {through_key}; "
            f"bus_voltages at the topology's bus of idx 1 is {through_topology}"
        )
    finally:
        await _close(client, sid)


# ---- 2. keys do not change during a session ---------------------------------


async def test_keys_do_not_change_during_a_session(client: httpx.AsyncClient) -> None:
    """Load IEEE 14, then run, reload, add a load, undo, redo and delete one:
    after each step every key the case had is as it was, the added load is
    ``load:4-2``, and undo and the delete take only their own key away.
    Fails if a run or a reload hands the keys out afresh instead of keeping the
    book, if an added element takes a key an element has, if undo leaves the
    added load's key in the book, or if a delete drops or re-keys a neighbour."""
    sid = await _session_with_case(client, "ieee14.raw")
    try:
        kept_topology = _keys_of_topology(await _topology(client, sid))
        kept_listing = _keys_of_listing(await _key_list(client, sid))
        assert "load:4-1" in kept_topology.values(), "IEEE 14 has one load on bus 4, load:4-1"
        assert "load:4-2" not in kept_topology.values(), "IEEE 14 has no load:4-2 of its own"

        async def assert_as_kept(when: str) -> None:
            _assert_same_keys(kept_topology, _keys_of_topology(await _topology(client, sid)), when)
            _assert_same_keys(kept_listing, _keys_of_listing(await _key_list(client, sid)), when)

        resp = await client.post(f"/api/sessions/{sid}/pflow", json={})
        assert resp.status_code == 200, resp.text
        assert resp.json()["converged"] is True, "the power flow of IEEE 14 must converge"
        await assert_as_kept("after the power flow")

        resp = await client.post(f"/api/sessions/{sid}/reload")
        assert resp.status_code == 200, resp.text
        await assert_as_kept("after reload")

        await _add_load(client, sid, "PQ_new", "4")
        added_topology = _keys_of_topology(await _topology(client, sid))
        added_listing = _keys_of_listing(await _key_list(client, sid))
        assert set(added_topology) - set(kept_topology) == {("PQ", "PQ_new")}, (
            "adding a load must add exactly that load to the topology: "
            f"{sorted(set(added_topology) ^ set(kept_topology))}"
        )
        assert added_topology[("PQ", "PQ_new")] == "load:4-2", (
            "the load added on bus 4 must take the next free ordinal, load:4-2; "
            f"it took {added_topology[('PQ', 'PQ_new')]}"
        )
        assert added_listing.get(("PQ", "PQ_new"), ("",))[0] == "load:4-2", (
            f"GET /keys must give the added load load:4-2: {added_listing.get(('PQ', 'PQ_new'))}"
        )
        _assert_same_keys(
            kept_topology,
            {h: k for h, k in added_topology.items() if h != ("PQ", "PQ_new")},
            "of the other elements when a load is added",
        )
        _assert_same_keys(
            kept_listing,
            {h: e for h, e in added_listing.items() if h != ("PQ", "PQ_new")},
            "of the other elements when a load is added",
        )

        resp = await client.post(f"/api/sessions/{sid}/undo-last-edit")
        assert resp.status_code == 200, resp.text
        undone_listing = await _key_list(client, sid)
        assert "load:4-2" not in _listed_keys(undone_listing), "undo must take load:4-2 out of GET /keys"
        await assert_as_kept("after undo")

        resp = await client.post(f"/api/sessions/{sid}/redo-edit")
        assert resp.status_code == 200, resp.text
        topology = await _topology(client, sid)
        redone_topology = _keys_of_topology(topology)
        redone_listing = _keys_of_listing(await _key_list(client, sid))
        back = [entry for entry in topology["loads"] if entry["key"] == "load:4-2"]  # type: ignore[attr-defined]
        assert len(back) == 1 and str(back[0]["params"]["bus"]) == "4", (
            f"redo must bring load:4-2 back on one load on bus 4: {back}"
        )
        _assert_same_keys(added_topology, redone_topology, "after redo")
        _assert_same_keys(added_listing, redone_listing, "after redo")

        victims = [handle for handle, (key, _, _) in redone_listing.items() if key == "load:5-1"]
        assert len(victims) == 1 and victims[0][0] == "PQ", f"load:5-1 must be one PQ: {victims}"
        resp = await client.delete(f"/api/sessions/{sid}/elements/PQ/{victims[0][1]}")
        assert resp.status_code == 200, resp.text
        deleted_listing = _keys_of_listing(await _key_list(client, sid))
        assert "load:5-1" not in {key for key, _, _ in deleted_listing.values()}, (
            "the deleted load's key load:5-1 must be gone from GET /keys"
        )
        _assert_same_keys(
            {h: k for h, k in redone_topology.items() if h != victims[0]},
            _keys_of_topology(await _topology(client, sid)),
            "of the other elements when load:5-1 is deleted",
        )
        _assert_same_keys(
            {h: e for h, e in redone_listing.items() if h != victims[0]},
            deleted_listing,
            "of the other elements when load:5-1 is deleted",
        )
    finally:
        await _close(client, sid)


# ---- 2b. an added line and generator take free keys -------------------------


async def test_added_line_and_generator_take_free_keys(client: httpx.AsyncClient) -> None:
    """Load IEEE 14, add a line beside the file's branch 6 to 5 (written from 5
    to 6) and a second static generator on bus 2, then undo both and redo both:
    the line is ``branch:6-5-2`` and the generator ``gen:2-2``, the same keys
    come back on redo, and every other key is unchanged throughout.
    Fails if an added line or generator takes its circuit or id by position (a
    key another element holds, stored with a ``~N`` suffix), if an added
    circuit of a corridor is written in the other orientation, or if undo and
    redo do not take the keys away and bring the same ones back."""
    oracle = read_raw_keys(_bundled_cases_dir() / "ieee14" / "ieee14.raw")
    assert "branch:6-5-1" in oracle["branch"] and "branch:5-6-1" not in oracle["branch"], (
        "IEEE 14 writes its branch between buses 5 and 6 from 6 to 5, with circuit 1"
    )
    assert "gen:2-1" in oracle["gen"] and "gen:2-2" not in oracle["gen"], (
        "IEEE 14 has one generator on bus 2, gen:2-1"
    )
    sid = await _session_with_case(client, "ieee14.raw")
    try:
        kept_topology = _keys_of_topology(await _topology(client, sid))
        kept_listing = _keys_of_listing(await _key_list(client, sid))

        await _add_element(
            client,
            sid,
            "Line",
            {"idx": "L_new", "name": "L_new", "bus1": "5", "bus2": "6", "r": 0.01, "x": 0.05},
        )
        await _add_element(
            client,
            sid,
            "PV",
            {"idx": "G_new", "name": "G_new", "bus": "2", "Sn": 100.0, "Vn": 69.0, "p0": 0.1, "v0": 1.0},
        )
        added_topology = _keys_of_topology(await _topology(client, sid))
        added_listing = _keys_of_listing(await _key_list(client, sid))
        new = {("Line", "L_new"): "branch:6-5-2", ("PV", "G_new"): "gen:2-2"}
        assert {h: added_topology.get(h) for h in new} == new, (
            "the added line must be the second circuit of the corridor 6 to 5, branch:6-5-2, "
            "and the added generator the first free id on bus 2, gen:2-2: "
            f"{ {h: added_topology.get(h) for h in new} }"
        )
        assert {h: added_listing.get(h, ("",))[0] for h in new} == new, (
            f"GET /keys must give the added elements the same keys: { {h: added_listing.get(h) for h in new} }"
        )
        _assert_same_keys(
            kept_topology,
            {h: k for h, k in added_topology.items() if h not in new},
            "of the other elements when a line and a generator are added",
        )
        _assert_same_keys(
            kept_listing,
            {h: e for h, e in added_listing.items() if h not in new},
            "of the other elements when a line and a generator are added",
        )

        for _ in new:
            resp = await client.post(f"/api/sessions/{sid}/undo-last-edit")
            assert resp.status_code == 200, resp.text
        undone = _listed_keys(await _key_list(client, sid))
        assert not undone & set(new.values()), (
            f"undoing both edits must take their keys away: {sorted(undone & set(new.values()))}"
        )
        _assert_same_keys(kept_topology, _keys_of_topology(await _topology(client, sid)), "after undo")
        _assert_same_keys(kept_listing, _keys_of_listing(await _key_list(client, sid)), "after undo")

        for _ in new:
            resp = await client.post(f"/api/sessions/{sid}/redo-edit")
            assert resp.status_code == 200, resp.text
        _assert_same_keys(added_topology, _keys_of_topology(await _topology(client, sid)), "after redo")
        _assert_same_keys(added_listing, _keys_of_listing(await _key_list(client, sid)), "after redo")
    finally:
        await _close(client, sid)


# ---- 3. a file replaced on disk is keyed afresh ------------------------------


async def test_a_file_replaced_on_disk_is_keyed_afresh(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """Load IEEE 14, write the Kundur bytes over the workspace's ``ieee14.raw``
    and reload: the keys are exactly the ones the new content gives.
    Fails if a reload of a file that changed on disk keeps the book of the old
    content (its stamp is not checked), so ids read from IEEE 14 are handed to
    Kundur's elements or IEEE 14's keys are left."""
    old_oracle = read_raw_keys(_bundled_cases_dir() / "ieee14" / "ieee14.raw")
    new_oracle = read_raw_keys(_bundled_cases_dir() / "kundur" / "kundur.raw")
    assert "bus:14" in old_oracle["bus"] and "bus:14" not in new_oracle["bus"], (
        "the oracle must see bus 14 in IEEE 14 and not in Kundur"
    )
    sid = await _session_with_case(client, "ieee14.raw")
    try:
        before = _listed_keys(await _key_list(client, sid))
        assert before == _all_keys(old_oracle), (
            f"IEEE 14's keys before the file is replaced must be its own: {sorted(before ^ _all_keys(old_oracle))}"
        )

        target = tmp_path / "ws" / "ieee14.raw"
        old_size = target.stat().st_size
        shutil.copyfile(_bundled_cases_dir() / "kundur" / "kundur.raw", target)
        assert target.stat().st_size != old_size, "the replaced file must differ in size"

        resp = await client.post(f"/api/sessions/{sid}/reload")
        assert resp.status_code == 200, resp.text
        _assert_keys_are_the_files(await _topology(client, sid), new_oracle, "after the file was replaced")
        after = _listed_keys(await _key_list(client, sid))
        assert "bus:14" not in after, "bus:14 of the first file must be gone after the reload"
        assert after == _all_keys(new_oracle), (
            "GET /keys after the reload must be exactly the new file's keys: "
            f"missing {sorted(_all_keys(new_oracle) - after)}, left over {sorted(after - _all_keys(new_oracle))}"
        )
    finally:
        await _close(client, sid)


# ---- 4. the engine of a session ----------------------------------------------


async def test_the_engine_of_a_session(client: httpx.AsyncClient) -> None:
    """``GET /engines`` lists ANDES with its routines; a session created with no
    body or with ``{"engine": "andes"}`` reports ``andes``; an unknown engine or
    field is a 422; Sienna, when the server says it is not available, is a 409
    that carries that reason and creates nothing.
    Fails if a session reports another engine than it was created for, if a
    bad body is not refused, or if a refused engine answers anything but 409 or
    takes a session slot."""
    resp = await client.get("/api/engines")
    assert resp.status_code == 200, resp.text
    engines = {entry["name"]: entry for entry in resp.json()["engines"]}
    assert engines["andes"]["available"] is True, "GET /engines must report andes available"
    assert engines["andes"]["routines"], "GET /engines must list the routines of andes"

    for body in (None, {"engine": "andes"}):
        created = await client.post("/api/sessions", json=body)
        assert created.status_code == 201, created.text
        sid = str(created.json()["session_id"])
        try:
            assert created.json()["engine"] == "andes", (
                f"a session created with {body} must report engine andes: {created.json()}"
            )
            described = await client.get(f"/api/sessions/{sid}")
            assert described.status_code == 200, described.text
            assert described.json()["engine"] == "andes", (
                f"GET /sessions/{{id}} of a session created with {body} must report andes: "
                f"{described.json()}"
            )
        finally:
            await _close(client, sid)

    for body in ({"engine": "no-such-engine"}, {"engine": "andes", "bogus": 1}):
        refused = await client.post("/api/sessions", json=body)
        assert refused.status_code == 422, (
            f"creating a session with {body} must be refused with 422: {refused.status_code} {refused.text}"
        )

    assert (await client.get("/api/sessions")).json()["sessions"] == [], (
        "no session may be left over before the sienna part"
    )
    sienna = engines.get("sienna")
    assert sienna is not None, "GET /engines must list sienna"
    if sienna["available"]:
        pytest.skip("GET /engines reports sienna available here, so it is not refused")
    reason = str(sienna["unavailable_reason"] or "")
    assert reason, "GET /engines must give the reason sienna is not available"
    refused = await client.post("/api/sessions", json={"engine": "sienna"})
    assert refused.status_code == 409, (
        f"a session for the unavailable sienna must be refused with 409: {refused.status_code} {refused.text}"
    )
    problem = refused.json()
    assert problem["status"] == 409, f"the refusal must be a problem document of status 409: {problem}"
    assert reason in str(problem["detail"]), (
        f"the refusal must hold the reason GET /engines gives ({reason!r}): {problem}"
    )
    assert (await client.get("/api/sessions")).json()["sessions"] == [], (
        "the refused sienna session must not be listed"
    )
    # Nor may it hold a slot: ANDES sessions up to the cap still start.
    made: list[str] = []
    try:
        for _ in range(_MAX_SESSIONS):
            created = await client.post("/api/sessions")
            assert created.status_code == 201, (
                f"after the refused sienna session, {_MAX_SESSIONS} ANDES sessions must start; "
                f"number {len(made) + 1} answered {created.status_code} {created.text}"
            )
            made.append(str(created.json()["session_id"]))
    finally:
        for made_sid in made:
            await _close(client, made_sid)


# ---- 5. two sessions do not share keys ---------------------------------------


async def test_two_sessions_do_not_share_keys(client: httpx.AsyncClient) -> None:
    """One session on IEEE 14 and one on Kundur at once: each lists its own
    file's keys and none of the other's, and a load added in one is keyed in
    that one alone.
    Fails if the two sessions share one key book, so one case's keys show in
    the other's listing or an edit in one re-keys the other."""
    oracle14 = read_raw_keys(_bundled_cases_dir() / "ieee14" / "ieee14.raw")
    oracle_kundur = read_raw_keys(_bundled_cases_dir() / "kundur" / "kundur.raw")
    only14 = _all_keys(oracle14) - _all_keys(oracle_kundur)
    only_kundur = _all_keys(oracle_kundur) - _all_keys(oracle14)
    assert only14 and only_kundur, "each file must have keys the other has not"
    sid14 = await _session_with_case(client, "ieee14.raw")
    sid_kundur = await _session_with_case(client, "kundur.raw")
    try:
        keys14 = _listed_keys(await _key_list(client, sid14))
        listing_kundur = await _key_list(client, sid_kundur)
        keys_kundur = _listed_keys(listing_kundur)
        assert keys14 == _all_keys(oracle14), (
            f"the IEEE 14 session's keys must be its file's: {sorted(keys14 ^ _all_keys(oracle14))}"
        )
        assert keys_kundur == _all_keys(oracle_kundur), (
            f"the Kundur session's keys must be its file's: {sorted(keys_kundur ^ _all_keys(oracle_kundur))}"
        )
        assert not keys14 & only_kundur, f"Kundur's keys show in the IEEE 14 session: {sorted(keys14 & only_kundur)}"
        assert not keys_kundur & only14, f"IEEE 14's keys show in the Kundur session: {sorted(keys_kundur & only14)}"

        kundur_topology = _keys_of_topology(await _topology(client, sid_kundur))
        kundur_entries = _keys_of_listing(listing_kundur)
        await _add_load(client, sid14, "PQ_new", "4")
        assert "load:4-2" in _listed_keys(await _key_list(client, sid14)), (
            "the load added to the IEEE 14 session must be keyed there as load:4-2"
        )
        _assert_same_keys(
            kundur_topology,
            _keys_of_topology(await _topology(client, sid_kundur)),
            "in the Kundur session when a load is added to the IEEE 14 one",
        )
        _assert_same_keys(
            kundur_entries,
            _keys_of_listing(await _key_list(client, sid_kundur)),
            "in the Kundur session when a load is added to the IEEE 14 one",
        )

        # And the other way: a load added to Kundur on a bus whose only load has
        # an id other than 1 takes the first ordinal free there, and the IEEE 14
        # session is untouched.
        loads_kundur = sorted(oracle_kundur["load"])
        odd = [key for key in loads_kundur if not key.endswith("-1")]
        assert odd, "Kundur has a load whose id is not 1"
        bus = odd[0].removeprefix("load:").split("-")[0]
        free = next(
            f"load:{bus}-{n}" for n in range(1, 99) if f"load:{bus}-{n}" not in oracle_kundur["load"]
        )
        topology14 = _keys_of_topology(await _topology(client, sid14))
        await _add_load(client, sid_kundur, "PQ_k", bus, vn=230.0)
        keyed = _keys_of_listing(await _key_list(client, sid_kundur)).get(("PQ", "PQ_k"))
        assert keyed is not None and keyed[0] == free, (
            f"a load added on Kundur's bus {bus} must take the first free ordinal, {free}: {keyed}"
        )
        _assert_same_keys(
            topology14,
            _keys_of_topology(await _topology(client, sid14)),
            "in the IEEE 14 session when a load is added to the Kundur one",
        )
    finally:
        await _close(client, sid14)
        await _close(client, sid_kundur)
