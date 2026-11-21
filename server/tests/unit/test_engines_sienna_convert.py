"""Unit tests for ``tensa.engines.sienna.convert`` (unit P4-C2).

The Sienna topology, report and pflow JSON of the nine recorded cases are
turned into the ``TopologySnapshot`` and ``PflowResult`` the ANDES engine
returns, and the tests hold the result to ANDES itself: the topology of the
six static cases element by element through the keys, and the power flow of
every case against a live ANDES run on the same file. ANDES is used only as
the reference; the tests fail when its case files are missing.
"""

from __future__ import annotations

import copy
import json
import math
import shutil
from pathlib import Path
from typing import Any

import pytest

from tensa.core.examples import _andes_cases_dir
from tensa.core.wrapper import Wrapper
from tensa.core.wrapper.results import TopologyEntry, TopologySnapshot
from tensa.engines.andes.keys import assign_andes_keys
from tensa.engines.case_facts import corrections_document, read_case_facts
from tensa.engines.identity import read_identity
from tensa.engines.keys import KeyBook
from tensa.engines.roles import role_of_model
from tensa.engines.sienna.convert import (
    file_ratings,
    pflow_result,
    report_messages,
    topology_snapshot,
)
from tensa.engines.sienna.keys import assign_sienna_keys

SAMPLES = Path(__file__).resolve().parent / "sienna_samples"

# case name -> (raw file relative to the ANDES cases dir, dyr file or None)
CASES: dict[str, tuple[str, str | None]] = {
    "kundur": ("kundur/kundur.raw", None),
    "kundur_dyr": ("kundur/kundur.raw", "kundur/kundur_full.dyr"),
    "ieee14": ("ieee14/ieee14.raw", None),
    "ieee14_dyr": ("ieee14/ieee14.raw", "ieee14/ieee14.dyr"),
    "ieee39": ("ieee39/ieee39.raw", None),
    "wscc9": ("wscc9/wscc9.raw", None),
    "npcc": ("npcc/npcc.raw", None),
    "wecc": ("wecc/wecc.raw", None),
    "case14_m": ("matpower/case14.m", None),
}

CASE_NAMES = tuple(CASES)
STATIC_CASES = ("kundur", "ieee14", "ieee39", "wscc9", "npcc", "wecc")

BRANCH_PARAMS = {"bus1", "bus2", "r", "x", "b", "tap", "phi", "rate_a", "u"}
GENERATOR_PARAMS = {"bus", "Sn", "Vn", "p0", "v0", "qmax", "qmin", "u"}
LOAD_PARAMS = {"bus", "Vn", "p0", "q0", "u"}
SHUNT_PARAMS = {"bus", "Vn", "g", "b", "u"}


def _sample(name: str, kind: str) -> dict[str, Any]:
    path = SAMPLES / f"{name}.{kind}.json"
    document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return document


def _case_path(name: str) -> Path:
    cases_dir = _andes_cases_dir()
    assert cases_dir is not None, "ANDES cases folder not found"
    path = Path(cases_dir) / CASES[name][0]
    assert path.is_file(), f"ANDES case file missing: {CASES[name][0]}"
    return path


def _dyr_path(name: str) -> Path | None:
    dyr = CASES[name][1]
    if dyr is None:
        return None
    cases_dir = _andes_cases_dir()
    assert cases_dir is not None
    path = Path(cases_dir) / dyr
    assert path.is_file(), f"ANDES case file missing: {dyr}"
    return path


def _sienna_snapshot(name: str) -> TopologySnapshot:
    topology = _sample(name, "topology")
    report = _sample(name, "report")
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    return topology_snapshot(topology, report, book)


def _file_ratings(name: str) -> tuple[KeyBook, dict[str, float]]:
    """The key book of the case and the file's ratings of its case file."""
    topology = _sample(name, "topology")
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    document = corrections_document(read_case_facts(_case_path(name)))
    ratings, unmatched = file_ratings(document, book)
    assert unmatched == 0, f"{name}: {unmatched} rating row(s) matched no branch"
    assert ratings is not None
    return book, ratings


def _andes_snapshot(name: str, tmp_path: Path) -> TopologySnapshot:
    """ANDES's topology of the case, built by the Wrapper on a copy."""
    workspace = tmp_path / name
    workspace.mkdir()
    raw = shutil.copy2(_case_path(name), workspace / Path(CASES[name][0]).name)
    addfiles = None
    dyr = _dyr_path(name)
    if dyr is not None:
        copied = shutil.copy2(dyr, workspace / dyr.name)
        addfiles = [str(copied)]
    wrapper = Wrapper(workspace=str(workspace), session_id="t", owner_pid=None)
    return wrapper.load_case(str(raw), addfiles=addfiles)


def _entries_by_key(
    snapshot: TopologySnapshot, *buckets: str
) -> dict[str, TopologyEntry]:
    entries: dict[str, TopologyEntry] = {}
    for bucket in buckets:
        for entry in getattr(snapshot, bucket):
            assert entry.key is not None
            entries[entry.key] = entry
    return entries


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_topology_bucket_sizes_and_keys(name: str) -> None:
    topology = _sample(name, "topology")
    snapshot = _sienna_snapshot(name)
    machines = [
        row for row in topology["dynamics"] if role_of_model(row["model"]) == "machine"
    ]
    assert len(snapshot.buses) == len(topology["buses"])
    assert len(snapshot.lines) + len(snapshot.transformers) == len(topology["branches"])
    assert len(snapshot.generators) == len(topology["generators"]) + len(machines)
    assert len(snapshot.loads) == len(topology["loads"])
    assert len(snapshot.shunts) == len(topology["shunts"])
    assert len(snapshot.controllers) == len(topology["dynamics"]) - len(machines)

    keys: list[str] = []
    for bucket in ("buses", "lines", "transformers", "generators", "loads", "shunts", "controllers"):
        for entry in getattr(snapshot, bucket):
            assert entry.key, f"{bucket} entry {entry.idx} has no key"
            keys.append(entry.key)
    assert len(keys) == len(set(keys)), "keys are not unique across the snapshot"

    assert snapshot.state == "pre-setup"
    assert snapshot.events == []
    assert snapshot.undo is None
    assert snapshot.redo is None
    assert snapshot.base_mva == topology["base_mva"]
    assert snapshot.freq_hz == topology["freq_hz"]
    assert snapshot.has_dynamics == (len(topology["dynamics"]) > 0)


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_topology_param_shapes(name: str) -> None:
    snapshot = _sienna_snapshot(name)
    for entry in snapshot.buses:
        assert entry.kind == "Bus"
        assert set(entry.params) == {"Vn"}
    for entry in (*snapshot.lines, *snapshot.transformers):
        assert entry.kind == "Line"
        assert set(entry.params) == BRANCH_PARAMS
    static = [e for e in snapshot.generators if e.kind in ("Slack", "PV")]
    for entry in static:
        assert set(entry.params) == GENERATOR_PARAMS
    for entry in snapshot.loads:
        assert entry.kind == "PQ"
        assert set(entry.params) == LOAD_PARAMS
    for entry in snapshot.shunts:
        assert entry.kind == "Shunt"
        assert set(entry.params) == SHUNT_PARAMS


@pytest.mark.unit
def test_per_unit_conversion_on_kundur() -> None:
    snapshot = _sienna_snapshot("kundur_dyr")
    gen2 = next(e for e in snapshot.generators if e.key == "gen:2-1")
    assert gen2.params["p0"] == pytest.approx(7.0)
    assert gen2.params["qmax"] == pytest.approx(6.0)
    assert gen2.params["qmin"] == pytest.approx(-6.0)
    assert gen2.params["Sn"] == pytest.approx(900.0)
    assert gen2.params["Vn"] == pytest.approx(20.0)
    assert gen2.params["v0"] == pytest.approx(1.0)
    load = next(e for e in snapshot.loads if e.key == "load:7-2")
    assert load.params["p0"] == pytest.approx(11.59)
    assert load.params["q0"] == pytest.approx(-0.735)


@pytest.mark.unit
def test_has_dynamics_only_for_the_dyr_cases() -> None:
    for name in CASE_NAMES:
        snapshot = _sienna_snapshot(name)
        assert snapshot.has_dynamics == name.endswith("_dyr"), name


@pytest.mark.unit
@pytest.mark.parametrize("name", ("kundur_dyr", "ieee14_dyr"))
def test_machines_and_controllers_reference_existing_entries(name: str) -> None:
    snapshot = _sienna_snapshot(name)
    generator_idxes = {entry.idx for entry in snapshot.generators}
    machine_idxes = {
        entry.idx for entry in snapshot.generators if entry.kind not in ("Slack", "PV")
    }
    for entry in snapshot.generators:
        if entry.kind in ("Slack", "PV"):
            continue
        assert set(entry.params) == {"bus", "gen"}
        assert entry.params["gen"] in generator_idxes
    machine_of = {
        entry.params["gen"]: entry.idx
        for entry in snapshot.generators
        if entry.kind not in ("Slack", "PV")
    }
    exciter_of = {
        str(entry.idx).split("/")[0]: entry.idx
        for entry in snapshot.controllers
        if role_of_model(entry.kind) == "exciter"
    }
    assert snapshot.controllers, "no controller to check"
    for entry in snapshot.controllers:
        unit = str(entry.idx).split("/")[0]
        role = role_of_model(entry.kind)
        # The reference the role calls for, to the model of this unit.
        if role in ("exciter", "governor") and unit in machine_of:
            assert entry.params == {"syn": machine_of[unit]}, entry
        elif role == "pss" and unit in exciter_of:
            assert entry.params == {"avr": exciter_of[unit]}, entry
        else:
            assert entry.params == {"gen": unit}, entry
        if "syn" in entry.params:
            assert entry.params["syn"] in machine_idxes
        if "gen" in entry.params:
            assert entry.params["gen"] in generator_idxes


def _small_topology() -> dict[str, Any]:
    """Two buses, a phase-shifting transformer with no rating, a generator out
    of service with a unit whose stabiliser is listed before its exciter."""
    return {
        "base_mva": 100.0,
        "freq_hz": 50.0,
        "buses": [
            {"number": 1, "name": "A", "vn_kv": 20.0, "type": "REF", "v_pu": 1.0,
             "angle_rad": 0.0, "available": True},
            {"number": 2, "name": "B", "vn_kv": 0.0, "type": "PQ", "v_pu": 1.0,
             "angle_rad": 0.0, "available": True},
        ],
        "branches": [
            {"name": "T", "from": 1, "to": 2, "ckt": "1", "kind": "transformer",
             "sienna_type": "PhaseShiftingTransformer", "r_pu": 0.001, "x_pu": 0.1,
             "b_pu": 0.0, "tap": 0.95, "shift_rad": 0.1, "rate_mva": None,
             "available": True},
        ],
        "generators": [
            {"name": "g", "bus": 1, "id": "1", "kind": "Slack", "sienna_type": "ThermalStandard",
             "p_mw": 50.0, "q_mvar": 5.0, "v_set_pu": 1.02, "q_min_mvar": -30.0,
             "q_max_mvar": 40.0, "mbase_mva": 80.0, "available": False, "has_dynamics": True},
        ],
        "loads": [],
        "shunts": [
            {"name": "s", "bus": 2, "order": 1, "kind": "fixed", "sienna_type": "FixedAdmittance",
             "g_mw": 1.0, "b_mvar": 20.0, "available": True},
        ],
        "dynamics": [
            {"bus": 1, "id": "1", "model": "IEEEST", "generator": "g"},
            {"bus": 1, "id": "1", "model": "SEXS", "generator": "g"},
            {"bus": 1, "id": "1", "model": "GENROU", "generator": "g"},
        ],
    }


@pytest.mark.unit
def test_topology_of_a_hand_built_case() -> None:
    topology = _small_topology()
    book = assign_sienna_keys(topology, None)
    snapshot = topology_snapshot(topology, {}, book)
    transformer = snapshot.transformers[0]
    assert transformer.params["phi"] == 0.1  # radians, as ANDES holds it
    assert transformer.params["tap"] == 0.95
    assert transformer.params["rate_a"] == 0.0
    assert transformer.key == "branch:1-2-1"
    generator = snapshot.generators[0]
    assert generator.params == {
        "bus": 1, "Sn": 80.0, "Vn": 20.0, "p0": 0.5, "v0": 1.02, "qmax": 0.4,
        "qmin": -0.3, "u": 0,
    }
    shunt = snapshot.shunts[0]
    assert shunt.params == {"bus": 2, "Vn": 0.0, "g": 0.01, "b": 0.2, "u": 1}
    assert snapshot.buses_without_vn == [2]
    assert snapshot.freq_hz == 50.0
    controllers = {entry.kind: entry for entry in snapshot.controllers}
    assert controllers["IEEEST"].params == {"avr": "g/SEXS"}
    assert controllers["SEXS"].params == {"syn": "g/GENROU"}
    assert controllers["IEEEST"].key == "gen:1-1/pss"
    machine = snapshot.generators[1]
    assert (machine.idx, machine.kind, machine.params) == (
        "g/GENROU", "GENROU", {"bus": 1, "gen": "g"},
    )


@pytest.mark.unit
def test_pflow_of_a_hand_built_case() -> None:
    topology = _small_topology()
    book = assign_sienna_keys(topology, None)
    pflow = {
        "converged": True, "tolerance": 1e-9, "max_iterations": 30, "notes": [],
        "buses": [{"number": 1, "v_pu": 1.02, "angle_rad": 0.0},
                  {"number": 2, "v_pu": 0.9, "angle_rad": -0.2}],
        "branches": [{"name": "T", "from": 1, "to": 2, "ckt": "1", "p_from_mw": 30.0,
                      "q_from_mvar": 4.0, "p_to_mw": -29.0, "q_to_mvar": 12.0}],
        "generators": [{"name": "g", "bus": 1, "id": "1", "p_mw": 30.0, "q_mvar": 4.0}],
        "loads": [],
    }
    result = pflow_result(pflow, topology, book)
    flow = result.line_flows["T"]
    assert (flow.from_idx, flow.to_idx) == (1, 2)
    assert (flow.p, flow.q, flow.p_to, flow.q_to) == (30.0, 4.0, -29.0, 12.0)
    assert flow.loss == 1.0
    assert flow.rate_a is None and flow.loading_pct is None
    output = result.generator_outputs["g"]
    assert (output.v, output.bus, output.q_min, output.q_max) == (1.02, 1, None, None)
    assert result.bus_angles == {1: 0.0, 2: -0.2}
    summary = result.summary
    assert summary is not None
    assert summary.shunt_p == pytest.approx(1.0 * 0.81)
    assert summary.shunt_q == pytest.approx(-20.0 * 0.81)
    assert summary.loss_q == 16.0
    assert summary.slack_p == 30.0
    assert result.keys == {
        "bus": {"1": "bus:1", "2": "bus:2"},
        "line": {"T": "branch:1-2-1"},
        "generator": {"g": "gen:1-1"},
        "load": {},
    }


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_convert_is_deterministic_and_leaves_its_inputs(name: str) -> None:
    topology, report, pflow = (_sample(name, kind) for kind in ("topology", "report", "pflow"))
    before = copy.deepcopy((topology, report, pflow))
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    entries = book.entries()
    assert topology_snapshot(topology, report, book) == topology_snapshot(topology, report, book)
    assert pflow_result(pflow, topology, book) == pflow_result(pflow, topology, book)
    assert report_messages(report) == report_messages(report)
    assert (topology, report, pflow) == before
    assert book.entries() == entries


@pytest.mark.unit
@pytest.mark.parametrize("name", STATIC_CASES)
def test_topology_matches_andes_through_the_keys(name: str, tmp_path: Path) -> None:
    sienna = _sienna_snapshot(name)
    andes = _andes_snapshot(name, tmp_path)

    sienna_buses = _entries_by_key(sienna, "buses")
    andes_buses = _entries_by_key(andes, "buses")
    assert set(sienna_buses) == set(andes_buses)
    for key, s_entry in sienna_buses.items():
        a_entry = andes_buses[key]
        assert float(s_entry.params["Vn"]) == pytest.approx(
            float(a_entry.params["Vn"]), abs=1e-6
        ), f"bus {key} Vn"

    sienna_branches = _entries_by_key(sienna, "lines", "transformers")
    andes_branches = _entries_by_key(andes, "lines", "transformers")
    assert set(sienna_branches) == set(andes_branches)
    for key, s_entry in sienna_branches.items():
        a_entry = andes_branches[key]
        reversed_ends = (
            s_entry.params["bus1"] == a_entry.params["bus2"]
            and s_entry.params["bus2"] == a_entry.params["bus1"]
            and s_entry.params["bus1"] != a_entry.params["bus1"]
        )
        for param in ("r", "x", "b", "phi"):
            assert float(s_entry.params[param]) == pytest.approx(
                float(a_entry.params[param]), abs=1e-6
            ), f"branch {key} {param} (reversed ends: {reversed_ends})"
        s_tap = float(s_entry.params["tap"])
        a_tap = float(a_entry.params["tap"])
        if reversed_ends and abs(a_tap) > 1e-12 and abs(s_tap - 1.0 / a_tap) <= 1e-6:
            # The two engines read the ratio from opposite ends.
            assert s_tap == pytest.approx(1.0 / a_tap, abs=1e-6), f"branch {key} tap"
        else:
            assert not reversed_ends, f"branch {key} has reversed ends but no reciprocal tap"
            assert s_tap == pytest.approx(a_tap, abs=1e-6), f"branch {key} tap"

    sienna_gens = {
        key: entry
        for key, entry in _entries_by_key(sienna, "generators").items()
        if entry.kind in ("Slack", "PV")
    }
    andes_gens = {
        key: entry
        for key, entry in _entries_by_key(andes, "generators").items()
        if entry.kind in ("Slack", "PV")
    }
    assert set(sienna_gens) == set(andes_gens)
    for key, s_entry in sienna_gens.items():
        a_entry = andes_gens[key]
        for param in ("p0", "v0", "qmax", "qmin", "Sn"):
            assert float(s_entry.params[param]) == pytest.approx(
                float(a_entry.params[param]), abs=1e-6
            ), f"generator {key} {param}"

    sienna_loads = _entries_by_key(sienna, "loads")
    andes_loads = _entries_by_key(andes, "loads")
    assert set(sienna_loads) == set(andes_loads)
    for key, s_entry in sienna_loads.items():
        a_entry = andes_loads[key]
        for param in ("p0", "q0"):
            assert float(s_entry.params[param]) == pytest.approx(
                float(a_entry.params[param]), abs=1e-6
            ), f"load {key} {param}"

    sienna_shunts = _entries_by_key(sienna, "shunts")
    andes_shunts = _entries_by_key(andes, "shunts")
    assert set(sienna_shunts) == set(andes_shunts)
    for key, s_entry in sienna_shunts.items():
        a_entry = andes_shunts[key]
        for param in ("g", "b"):
            assert float(s_entry.params[param]) == pytest.approx(
                float(a_entry.params[param]), abs=1e-6
            ), f"shunt {key} {param}"


def _run_andes_pflow(name: str, tmp_path: Path) -> Any:
    """A live ANDES power flow on the case, through the Wrapper."""
    import andes

    andes.config_logger(stream_level=50)
    workspace = tmp_path / f"{name}-pf"
    workspace.mkdir()
    raw = shutil.copy2(_case_path(name), workspace / Path(CASES[name][0]).name)
    addfiles = None
    dyr = _dyr_path(name)
    if dyr is not None:
        copied = shutil.copy2(dyr, workspace / dyr.name)
        addfiles = [str(copied)]
    wrapper = Wrapper(workspace=str(workspace), session_id="t", owner_pid=None)
    wrapper.load_case(str(raw), addfiles=addfiles)
    result = wrapper.run_pflow()
    assert result.converged, f"ANDES power flow did not converge for {name}"
    return result


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_pflow_matches_andes(name: str, tmp_path: Path) -> None:
    topology = _sample(name, "topology")
    pflow = _sample(name, "pflow")
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    sienna = pflow_result(pflow, topology, book)
    assert sienna.converged
    andes = _run_andes_pflow(name, tmp_path)

    # Each result's ``keys`` goes from that result's idx to the key; the
    # comparison goes the other way, key to idx on each side.
    def by_key(result: Any, kind: str) -> dict[str, str]:
        lookup: dict[str, str] = result.keys[kind]
        inverted = {key: idx for idx, key in lookup.items()}
        assert len(inverted) == len(lookup), f"{kind}: two idx share a key"
        return inverted

    # Buses, matched by key, angles relative to the lowest-numbered bus.
    andes_bus_by_key = {key: int(idx) for key, idx in by_key(andes, "bus").items()}
    sienna_bus_by_key = {key: int(idx) for key, idx in by_key(sienna, "bus").items()}
    assert set(sienna_bus_by_key) == set(andes_bus_by_key)
    assert len(sienna_bus_by_key) == len(pflow["buses"])
    reference = min(sienna_bus_by_key.values())
    s_offset = sienna.bus_angles[reference]
    a_offset = andes.bus_angles[reference]
    for key, number in sienna_bus_by_key.items():
        a_number = andes_bus_by_key[key]
        assert sienna.bus_voltages[number] == pytest.approx(
            andes.bus_voltages[a_number], abs=2e-5
        ), f"bus {key} voltage"
        assert (sienna.bus_angles[number] - s_offset) == pytest.approx(
            andes.bus_angles[a_number] - a_offset, abs=2e-5
        ), f"bus {key} angle"

    # Branches, matched by key, oriented by the from/to buses of each side.
    andes_line_by_key = by_key(andes, "line")
    sienna_line_by_key = by_key(sienna, "line")
    assert set(sienna_line_by_key) == set(andes_line_by_key)
    assert len(sienna_line_by_key) == len(pflow["branches"])
    for key, s_name in sienna_line_by_key.items():
        a_name = andes_line_by_key[key]
        s_flow = sienna.line_flows[s_name]
        a_flow = andes.line_flows[a_name]
        same = (s_flow.from_idx, s_flow.to_idx) == (a_flow.from_idx, a_flow.to_idx)
        swapped = (s_flow.from_idx, s_flow.to_idx) == (a_flow.to_idx, a_flow.from_idx)
        assert same or swapped, f"branch {key} joins other buses in the two engines"
        swapped = swapped and not same
        if swapped:
            pairs = ((s_flow.p, a_flow.p_to), (s_flow.q, a_flow.q_to),
                     (s_flow.p_to, a_flow.p), (s_flow.q_to, a_flow.q))
        else:
            pairs = ((s_flow.p, a_flow.p), (s_flow.q, a_flow.q),
                     (s_flow.p_to, a_flow.p_to), (s_flow.q_to, a_flow.q_to))
        for s_value, a_value in pairs:
            assert s_value == pytest.approx(a_value, abs=0.05), (
                f"branch {key} flow (swapped: {swapped})"
            )

    # Generators and loads, matched by key.
    andes_gen_by_key = by_key(andes, "generator")
    sienna_gen_by_key = by_key(sienna, "generator")
    assert set(sienna_gen_by_key) == set(andes_gen_by_key)
    assert len(sienna_gen_by_key) == len(pflow["generators"])
    for key, s_name in sienna_gen_by_key.items():
        a_output = andes.generator_outputs[andes_gen_by_key[key]]
        s_output = sienna.generator_outputs[s_name]
        assert s_output.p == pytest.approx(a_output.p, abs=0.05), f"generator {key} p"
        assert s_output.q == pytest.approx(a_output.q, abs=0.05), f"generator {key} q"

    andes_load_by_key = by_key(andes, "load")
    sienna_load_by_key = by_key(sienna, "load")
    assert set(sienna_load_by_key) == set(andes_load_by_key)
    assert len(sienna_load_by_key) == len(pflow["loads"])
    for key, s_name in sienna_load_by_key.items():
        a_load = andes.load_consumption[andes_load_by_key[key]]
        s_load = sienna.load_consumption[s_name]
        assert s_load.p == pytest.approx(a_load.p, abs=0.05), f"load {key} p"
        assert s_load.q == pytest.approx(a_load.q, abs=0.05), f"load {key} q"


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_pflow_result_details(name: str) -> None:
    topology = _sample(name, "topology")
    pflow = _sample(name, "pflow")
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    result = pflow_result(pflow, topology, book)
    assert result.converged
    assert result.iterations == 0
    assert result.mismatch == 0.0
    assert result.settings is None

    rate_of = {row["name"]: row["rate_mva"] for row in topology["branches"]}
    for branch_name, flow in result.line_flows.items():
        assert flow.loss == flow.p + flow.p_to
        rate = rate_of[branch_name]
        if rate is None or rate == 0:
            assert flow.rate_a is None
            assert flow.loading_pct is None
        else:
            assert flow.rate_a == rate
            bigger = max(
                math.hypot(flow.p, flow.q), math.hypot(flow.p_to, flow.q_to)
            )
            assert flow.loading_pct == pytest.approx(100.0 * bigger / rate)

    summary = result.summary
    assert summary is not None
    assert summary.generation_p == pytest.approx(
        summary.load_p + summary.shunt_p + summary.loss_p, abs=0.05
    ), f"{name}: generation_p off by {summary.generation_p - summary.load_p - summary.shunt_p - summary.loss_p}"
    assert summary.generation_q == pytest.approx(
        summary.load_q + summary.shunt_q + summary.loss_q, abs=0.5
    ), f"{name}: generation_q off by {summary.generation_q - summary.load_q - summary.shunt_q - summary.loss_q}"

    slack_rows = [row for row in topology["generators"] if row["kind"] == "Slack"]
    if slack_rows:
        assert summary.slack_p is not None
        assert summary.slack_q is not None
        expected_p = sum(
            result.generator_outputs[row["name"]].p for row in slack_rows
        )
        assert summary.slack_p == pytest.approx(expected_p)
    else:
        assert summary.slack_p is None
        assert summary.slack_q is None

    # The keys maps name every element of each kind.
    assert set(result.keys["bus"]) == {str(row["number"]) for row in pflow["buses"]}
    assert set(result.keys["line"]) == {row["name"] for row in pflow["branches"]}
    assert set(result.keys["generator"]) == {row["name"] for row in pflow["generators"]}
    assert set(result.keys["load"]) == {row["name"] for row in pflow["loads"]}


@pytest.mark.unit
def test_pflow_not_converged() -> None:
    topology = _sample("kundur", "topology")
    book = assign_sienna_keys(topology, read_identity(_case_path("kundur")))
    pflow = {
        "converged": False,
        "tolerance": 1e-9,
        "max_iterations": 50,
        "notes": [],
        "buses": [],
        "branches": [],
        "generators": [],
        "loads": [],
    }
    result = pflow_result(pflow, topology, book)
    assert not result.converged
    assert result.bus_voltages == {}
    assert result.bus_angles == {}
    assert result.line_flows == {}
    assert result.generator_outputs == {}
    assert result.load_consumption == {}
    assert result.summary is None
    assert result.keys == {}


@pytest.mark.unit
def test_report_messages_kundur_dyr_unsupported() -> None:
    report = _sample("kundur_dyr", "report")
    messages = report_messages(report)
    warnings = [text for level, text in messages if level == "warning"]
    for record in report["unsupported"]:
        expected = (
            f"Sienna: {record['model']} at bus {record['bus']}, id {record['id']}, "
            f"is not in the System: {record['reason']}"
        )
        assert expected in warnings
    # The unsupported warnings come first, in the records' order.
    first_four = messages[:4]
    assert [level for level, _ in first_four] == ["warning"] * 4
    assert first_four[0][1].startswith("Sienna: EXDC2 at bus 1, id 1,")
    assert first_four[3][1].startswith("Sienna: EXDC2 at bus 4, id 1,")


@pytest.mark.unit
def test_report_messages_ieee39_applied() -> None:
    report = _sample("ieee39", "report")
    messages = report_messages(report)
    infos = [text for level, text in messages if level == "info"]
    assert (
        "Sienna: the voltage setpoint at bus 2 is the file's 1.0037, "
        "where PowerSystems read 1.00247" in infos
    )
    assert (
        "Sienna: the ratio of GEN31-BUS6-i_1 is the file's 0.9, "
        "where PowerSystems read 0.914286" in infos
    )
    # The applied lines come before the notes.
    applied_count = len(report["applied"])
    assert all(level == "info" for level, _ in messages[:applied_count])


@pytest.mark.unit
def test_report_messages_npcc_notes_collapse() -> None:
    report = _sample("npcc", "report")
    messages = report_messages(report)
    note_messages = messages[len(report["unsupported"]) + len(report["applied"]):]
    assert len(report["notes"]) >= 200
    assert len(note_messages) < len(report["notes"]) // 4
    collapsed = [text for _, text in note_messages if "more like it" in text]
    assert collapsed, "no collapsed note line"
    # A collapsed line says how many more notes of the same shape there were.
    assert any("(and 137 more like it)" in text for text in collapsed)
    # Levels: the parser warnings stay warnings.
    assert all(level == "warning" for level, _ in note_messages)


CHATTER = (
    "Parsing PSS(R)E Substation data into a PowerModels Dict...",
    "This PSS(R)E parser currently doesn't support Storage data parsing...",
    "No substation data found",
)


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_report_messages_leave_out_parser_chatter(name: str) -> None:
    report = _sample(name, "report")
    texts = [text for _, text in report_messages(report)]
    for chatter in CHATTER:
        assert not any(chatter in text for text in texts), (name, chatter)
    assert not any("Dict{" in text for text in texts), name


@pytest.mark.unit
def test_report_messages_what_the_user_sees() -> None:
    # The whole of what three cases send to the message log.
    kundur = report_messages(_sample("kundur_dyr", "report"))
    assert [level for level, _ in kundur] == ["warning"] * 5
    assert kundur[4] == (
        "warning",
        "bus type SLACK (area interchange slack) read as PV, or REF where the "
        "case has no REF bus, at buses [3]",
    )
    # The notes that repeat an unsupported record's reason are not repeated.
    assert sum("EXDC2" in text for _, text in kundur) == 4

    ieee39_report = _sample("ieee39", "report")
    ieee39 = report_messages(ieee39_report)
    # Only the eight applied lines: the note that the ratio of GEN31-BUS6 was
    # moved to 0.914 describes what the applied line says was put back.
    assert len(ieee39) == len(ieee39_report["applied"]) == 8
    assert all(level == "info" for level, _ in ieee39)

    npcc_report = _sample("npcc", "report")
    npcc = report_messages(npcc_report)
    notes = npcc[len(npcc_report["applied"]):]
    assert notes == [
        (
            "warning",
            "Branch 134 - 136 has different voltage levels endpoints (from: "
            "230.0kV, to: 345.0kV) which exceed the 1.0% threshold; converting "
            "to transformer. (and 68 more like it)",
        ),
        (
            "warning",
            "Can't determine control objective for the transformer from the "
            "COD1 field (and 137 more like it)",
        ),
    ]


@pytest.mark.unit
def test_report_messages_tap_note_kept_unless_put_back() -> None:
    note = {
        "level": "warning",
        "text": "Transformer primary winding tap setting is not on a step; 0.9 set to 0.9142857142857143",
    }
    put_back = {"kind": "tap", "branch": "T", "from": 0.9142857142857143, "to": 0.9}
    other = {"kind": "tap", "branch": "T", "from": 0.95, "to": 0.9}
    assert report_messages({"notes": [note], "applied": [put_back]}) == [
        ("info", "Sienna: the ratio of T is the file's 0.9, where PowerSystems read 0.914286")
    ]
    kept = report_messages({"notes": [note], "applied": [other]})
    assert kept[-1] == ("warning", note["text"])


@pytest.mark.unit
def test_file_ratings_none_and_missing_key() -> None:
    topology = _small_topology()
    book = assign_sienna_keys(topology, None)
    assert file_ratings(None, book) == (None, 0)
    assert file_ratings({"v_setpoints": {}}, book) == (None, 0)


@pytest.mark.unit
def test_file_ratings_keys_and_unmatched_rows() -> None:
    topology = _small_topology()
    book = assign_sienna_keys(topology, None)
    document = {
        "ratings": [
            [1, 2, "1", 250.0],
            [1, 2, "9", 100.0],  # no branch:1-2-9 in the book
            [3, 4, "1", 50.0],  # no such branch at all
        ]
    }
    ratings, unmatched = file_ratings(document, book)
    assert ratings == {"branch:1-2-1": 250.0}
    assert unmatched == 2


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_file_ratings_cover_every_branch_of_the_book(name: str) -> None:
    book, ratings = _file_ratings(name)
    branch_keys = {entry.key for entry in book.entries() if entry.model == "Line"}
    assert set(ratings) == branch_keys
    rows = corrections_document(read_case_facts(_case_path(name)))["ratings"]
    assert isinstance(rows, list)
    assert len(ratings) == len(rows)


@pytest.mark.unit
@pytest.mark.parametrize("relative", ["matpower/case300.m", "GBnetwork/GBnetwork.m"])
def test_file_ratings_keys_on_matpower_parallel_branches(relative: str) -> None:
    # No Sienna sample holds a MATPOWER case with parallel branches, so the
    # keys are held to the book ANDES gets for the file: every row, a pair
    # written twice or with either end first included, finds its branch.
    import andes

    cases_dir = _andes_cases_dir()
    assert cases_dir is not None, "ANDES cases folder not found"
    path = Path(cases_dir) / relative
    assert path.is_file(), f"ANDES case file missing: {relative}"
    identity = read_identity(path)
    pairs = [(min(b.from_bus, b.to_bus), max(b.from_bus, b.to_bus)) for b in identity.branches]
    assert len(set(pairs)) < len(pairs), "the case has no parallel branches"
    andes.config_logger(stream_level=50)
    ss = andes.load(str(path), setup=False, no_output=True, default_config=True)
    book = assign_andes_keys(ss, identity)
    rows = corrections_document(read_case_facts(path))["ratings"]
    assert isinstance(rows, list)
    ratings, unmatched = file_ratings({"ratings": rows}, book)
    assert unmatched == 0
    assert ratings is not None
    assert len(ratings) == len(rows)
    assert set(ratings) == {entry.key for entry in book.entries() if entry.model == "Line"}


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_topology_with_ratings_matches_andes(name: str, tmp_path: Path) -> None:
    topology = _sample(name, "topology")
    report = _sample(name, "report")
    book, ratings = _file_ratings(name)
    sienna = topology_snapshot(topology, report, book, ratings)
    andes = _andes_snapshot(name, tmp_path)
    sienna_branches = _entries_by_key(sienna, "lines", "transformers")
    andes_branches = _entries_by_key(andes, "lines", "transformers")
    assert set(sienna_branches) == set(andes_branches)
    for key, s_entry in sienna_branches.items():
        a_entry = andes_branches[key]
        assert float(s_entry.params["rate_a"]) == pytest.approx(
            float(a_entry.params["rate_a"]), abs=1e-6
        ), f"branch {key} rate_a"


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_pflow_with_ratings_matches_andes(name: str, tmp_path: Path) -> None:
    topology = _sample(name, "topology")
    pflow = _sample(name, "pflow")
    book, ratings = _file_ratings(name)
    sienna = pflow_result(pflow, topology, book, ratings)
    assert sienna.converged
    andes = _run_andes_pflow(name, tmp_path)

    def by_key(result: Any, kind: str) -> dict[str, str]:
        lookup: dict[str, str] = result.keys[kind]
        return {key: idx for idx, key in lookup.items()}

    andes_line_by_key = by_key(andes, "line")
    sienna_line_by_key = by_key(sienna, "line")
    assert set(sienna_line_by_key) == set(andes_line_by_key)
    for key, s_name in sienna_line_by_key.items():
        a_flow = andes.line_flows[andes_line_by_key[key]]
        s_flow = sienna.line_flows[s_name]
        if a_flow.rate_a is None:
            # The file gives no rating: no rating and no loading on either side.
            assert s_flow.rate_a is None, f"branch {key} rate_a"
            assert s_flow.loading_pct is None, f"branch {key} loading_pct"
        else:
            assert s_flow.rate_a == pytest.approx(a_flow.rate_a, abs=1e-6), (
                f"branch {key} rate_a"
            )
            assert s_flow.loading_pct == pytest.approx(
                a_flow.loading_pct, abs=0.05
            ), f"branch {key} loading_pct"


@pytest.mark.unit
def test_kundur_ratings_are_the_files_not_the_invented_ones() -> None:
    # The kundur file gives no branch a rating (0). PowerSystems invents one
    # from each branch's impedance and voltage and reports it as rate_mva;
    # with the file's ratings the snapshot and the result say what the file
    # says, as ANDES does.
    topology = _sample("kundur", "topology")
    pflow = _sample("kundur", "pflow")
    book, ratings = _file_ratings("kundur")
    without = topology_snapshot(topology, _sample("kundur", "report"), book)
    for entry in (*without.lines, *without.transformers):
        assert float(entry.params["rate_a"]) > 0.0  # the engine's invented value
    with_ratings = topology_snapshot(topology, _sample("kundur", "report"), book, ratings)
    for entry in (*with_ratings.lines, *with_ratings.transformers):
        assert entry.params["rate_a"] == 0.0
    for flow in pflow_result(pflow, topology, book).line_flows.values():
        assert flow.rate_a is not None and flow.rate_a > 0.0  # invented
        assert flow.loading_pct is not None
    result = pflow_result(pflow, topology, book, ratings)
    assert result.line_flows
    for flow in result.line_flows.values():
        assert flow.rate_a is None
        assert flow.loading_pct is None


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_ratings_none_is_what_the_functions_gave_before(name: str) -> None:
    topology = _sample(name, "topology")
    report = _sample(name, "report")
    pflow = _sample(name, "pflow")
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    snapshot = topology_snapshot(topology, report, book, None)
    result = pflow_result(pflow, topology, book, None)
    assert snapshot == topology_snapshot(topology, report, book)
    assert result == pflow_result(pflow, topology, book)
    # What "before" was: the engine's rate_mva, and no rating where it is 0.
    # A mapping that holds none of the keys changes nothing either.
    engine_rate = {row["name"]: float(row["rate_mva"]) for row in topology["branches"]}
    for entry in (*snapshot.lines, *snapshot.transformers):
        assert entry.params["rate_a"] == engine_rate[entry.name]
    for line_name, flow in result.line_flows.items():
        assert flow.rate_a == (engine_rate[line_name] or None)
    assert topology_snapshot(topology, report, book, {}) == snapshot
    assert pflow_result(pflow, topology, book, {}) == result


@pytest.mark.unit
def test_ratings_given_replace_the_engines_where_both_rate() -> None:
    # On IEEE 14 the file and the engine give every branch the same rating,
    # so the comparison with ANDES cannot tell which one was used; a rating
    # that differs from the engine's must be the one shown, and the loading
    # must be computed from it.
    topology = _sample("ieee14", "topology")
    report = _sample("ieee14", "report")
    pflow = _sample("ieee14", "pflow")
    book = assign_sienna_keys(topology, read_identity(_case_path("ieee14")))
    engine = pflow_result(pflow, topology, book)
    doubled: dict[str, float] = {}
    for row in topology["branches"]:
        key = book.key_of("Line", row["name"])
        assert key is not None
        assert float(row["rate_mva"]) > 0.0
        doubled[key] = 2.0 * float(row["rate_mva"])
    snapshot = topology_snapshot(topology, report, book, doubled)
    for entry in (*snapshot.lines, *snapshot.transformers):
        assert entry.key is not None
        assert entry.params["rate_a"] == doubled[entry.key]
    result = pflow_result(pflow, topology, book, doubled)
    for line_name, flow in result.line_flows.items():
        before = engine.line_flows[line_name]
        assert before.rate_a is not None and before.loading_pct is not None
        assert flow.rate_a == 2.0 * before.rate_a
        assert flow.loading_pct == pytest.approx(before.loading_pct / 2.0, rel=1e-12)


@pytest.mark.unit
def test_report_messages_order_and_levels() -> None:
    report = {
        "buses": 1,
        "unsupported": [
            {"bus": 3, "model": "EXDC2", "id": "1", "handling": "dropped",
             "reason": "not supported"},
        ],
        "applied": [
            {"kind": "setpoint", "bus": 3, "from": 1.01, "to": 1.02},
            {"kind": "tap", "branch": "T1", "from": 0.99, "to": 1.0},
            {"kind": "charging", "branch": "L1", "from": 0.5, "to": 0.3},
        ],
        "notes": [
            {"level": "info", "text": "note one"},
            {"level": "error", "text": "note two"},
        ],
        "events": [],
        "normalised_buses": [],
        "dyr_records": 0,
        "dynamic_injectors": 0,
    }
    messages = report_messages(report)
    assert [level for level, _ in messages] == [
        "warning", "info", "info", "info", "info", "warning",
    ]
    assert messages[0][1] == "Sienna: EXDC2 at bus 3, id 1, is not in the System: not supported"
    assert messages[1][1] == (
        "Sienna: the voltage setpoint at bus 3 is the file's 1.02, "
        "where PowerSystems read 1.01"
    )
    assert messages[2][1] == (
        "Sienna: the ratio of T1 is the file's 1, where PowerSystems read 0.99"
    )
    assert messages[3][1] == (
        "Sienna: the line charging of L1 is the file's 0.3, "
        "where PowerSystems kept 0.5"
    )
    assert messages[4] == ("info", "note one")
    assert messages[5] == ("warning", "note two")
