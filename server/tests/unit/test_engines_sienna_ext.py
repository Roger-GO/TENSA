"""Unit tests of the ``ext.sienna`` document and of ``run_tds`` with it.

No Julia: the models, the validation against the key book and the topology,
the serialisation, and the state's handling of the block against a fake
bridge. The fixtures mirror the Julia ``topology_json`` shape.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from tensa.api.schemas.tds import TdsRunRequest
from tensa.core.errors import TdsRequestError
from tensa.engines.capabilities import engine_capabilities
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.ext import (
    INVERTER_PARAMETER_SETS,
    PARAMETER_SET_PARTS,
    DynamicBranchSpec,
    InverterSpec,
    SiennaExtSpec,
    ext_to_json,
    validate_ext,
)
from tensa.engines.sienna.state import SiennaState


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("bus:7", "bus", "Bus", 7, "engine"))
    book.assign(KeyEntry("bus:8", "bus", "Bus", 8, "engine"))
    book.assign(KeyEntry("bus:1", "bus", "Bus", 1, "engine"))
    book.assign(KeyEntry("branch:7-8-1", "line", "Line", "line-7-8-1", "file"))
    book.assign(KeyEntry("gen:1-1", "generator", "PV", "generator-1-1", "file"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "file"))
    return book


def _topology() -> dict[str, Any]:
    return {
        "buses": [{"number": 1}, {"number": 2}, {"number": 7}, {"number": 8}],
        "branches": [
            {"name": "line-7-8-1", "from": 7, "to": 8, "available": True},
        ],
        "generators": [
            {"name": "generator-1-1", "bus": 1, "available": True},
            {"name": "generator-2-1", "bus": 2, "available": True},
        ],
        "dynamics": [
            {"generator": "generator-1-1", "model": "GENROU"},
        ],
    }


def _spec() -> SiennaExtSpec:
    return SiennaExtSpec(
        dynamic_branches=[DynamicBranchSpec(target="branch:7-8-1")],
        inverters=[InverterSpec(target="gen:2-1", parameter_set="gfl-omib")],
    )


def test_dynamic_branch_spec_roundtrip() -> None:
    spec = SiennaExtSpec.model_validate(
        {"dynamic_branches": [{"target": "branch:7-8-1"}], "inverters": []}
    )
    assert spec.dynamic_branches[0].target == "branch:7-8-1"
    with pytest.raises(ValidationError):
        SiennaExtSpec.model_validate(
            {"dynamic_branches": [{"target": "branch:7-8-1", "x": 1}]}
        )


def test_validate_unknown_branch_key() -> None:
    spec = SiennaExtSpec(dynamic_branches=[DynamicBranchSpec(target="branch:7-9-1")])
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(spec, _book(), _topology())
    assert str(excinfo.value) == "ext.sienna: no branch with key branch:7-9-1"


def test_validate_branch_twice() -> None:
    spec = SiennaExtSpec(
        dynamic_branches=[
            DynamicBranchSpec(target="branch:7-8-1"),
            DynamicBranchSpec(target="branch:7-8-1"),
        ]
    )
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(spec, _book(), _topology())
    assert str(excinfo.value) == "ext.sienna: branch branch:7-8-1 is listed twice"


def test_validate_branch_out_of_service() -> None:
    topology = _topology()
    topology["branches"][0]["available"] = False
    spec = SiennaExtSpec(dynamic_branches=[DynamicBranchSpec(target="branch:7-8-1")])
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(spec, _book(), topology)
    assert str(excinfo.value) == "ext.sienna: branch branch:7-8-1 is out of service"


def test_validate_inverter_on_machine_with_dynamics() -> None:
    spec = SiennaExtSpec(
        inverters=[InverterSpec(target="gen:1-1", parameter_set="gfl-omib")]
    )
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(spec, _book(), _topology())
    assert str(excinfo.value) == (
        "ext.sienna: generator gen:1-1 already has a dynamic model; "
        "an inverter is given only to a generator without one"
    )


def test_validate_unknown_parameter_set() -> None:
    spec = SiennaExtSpec(
        inverters=[InverterSpec(target="gen:2-1", parameter_set="gfll")]
    )
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(spec, _book(), _topology())
    assert str(excinfo.value) == (
        "ext.sienna: unknown inverter parameter set gfll; the sets are gfl-omib, gfm-omib"
    )


def test_validate_unknown_generator() -> None:
    spec = SiennaExtSpec(
        inverters=[InverterSpec(target="gen:9-9", parameter_set="gfl-omib")]
    )
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(spec, _book(), _topology())
    assert str(excinfo.value) == "ext.sienna: no generator with key gen:9-9"


def test_validate_generator_twice_and_out_of_service() -> None:
    twice = SiennaExtSpec(
        inverters=[
            InverterSpec(target="gen:2-1", parameter_set="gfl-omib"),
            InverterSpec(target="gen:2-1", parameter_set="gfm-omib"),
        ]
    )
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(twice, _book(), _topology())
    assert str(excinfo.value) == "ext.sienna: generator gen:2-1 is listed twice"
    topology = _topology()
    topology["generators"][1]["available"] = False
    with pytest.raises(TdsRequestError) as excinfo:
        validate_ext(_spec(), _book(), topology)
    assert str(excinfo.value) == "ext.sienna: generator gen:2-1 is out of service"


def test_ext_to_json_addresses() -> None:
    assert ext_to_json(_spec(), _book()) == {
        "dynamic_branches": [{"from": 7, "to": 8, "ckt": "1"}],
        "inverters": [{"bus": 2, "id": "1", "parameter_set": "gfl-omib"}],
    }


def test_parameter_sets_have_required_parts() -> None:
    for set_id, parts in INVERTER_PARAMETER_SETS.items():
        assert sorted(parts) == sorted(PARAMETER_SET_PARTS), set_id
        for part in PARAMETER_SET_PARTS:
            assert isinstance(parts[part], dict) and parts[part], (set_id, part)


def test_validate_accepts_clean_spec() -> None:
    validate_ext(_spec(), _book(), _topology())


# ---- run_tds with ext_sienna, against a fake bridge --------------------------

RUN_OK: dict[str, Any] = {
    "ok": True,
    "status": "completed",
    "error": None,
    "t": [0.0, 1.0],
    "columns": [
        {"quantity": "voltage", "kind": "bus", "bus": 7, "unit": "pu"},
        {"quantity": "i_from", "kind": "branch", "from": 7, "to": 8, "ckt": "1", "unit": "pu"},
    ],
    "rows": [[1.03, 0.5], [1.02, 0.51]],
    "post": None,
    "steps": 1,
    "t_end": 1.0,
    "loads": {"converted": 0, "left": []},
    "notes": [],
    "timings": {"build_s": 0.1, "run_s": 0.2},
}


class FakeBridge:
    def __init__(self, run_answer: dict[str, Any] | None = None) -> None:
        self.run_answer = RUN_OK if run_answer is None else run_answer
        self.calls: list[dict[str, Any]] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def tds_run(self, session: Any, tf: float, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.run_answer


def _loaded(bridge: FakeBridge) -> SiennaState:
    state = SiennaState(None, None, None, bridge=bridge)
    state._session = object()  # noqa: SLF001
    state._topology_json = _topology()  # noqa: SLF001
    state._pflow_json = {"converged": True}  # noqa: SLF001
    state._key_book = _book()  # noqa: SLF001
    return state


def test_run_tds_passes_ext_to_bridge() -> None:
    bridge = FakeBridge()
    _loaded(bridge).run_tds(tf=1.0, ext_sienna=_spec())
    assert bridge.calls[-1]["ext"] == {
        "dynamic_branches": [{"from": 7, "to": 8, "ckt": "1"}],
        "inverters": [{"bus": 2, "id": "1", "parameter_set": "gfl-omib"}],
    }
    assert bridge.calls[-1]["load_model"] == "impedance"


def test_run_tds_without_ext_sends_none() -> None:
    bridge = FakeBridge()
    _loaded(bridge).run_tds(tf=1.0)
    # No ext document, no ext keyword: the bridge sends no ext key to Julia.
    assert "ext" not in bridge.calls[-1]


def test_run_tds_ext_invalid_target_refused_before_bridge() -> None:
    bridge = FakeBridge()
    spec = SiennaExtSpec(dynamic_branches=[DynamicBranchSpec(target="branch:7-9-1")])
    with pytest.raises(TdsRequestError) as excinfo:
        _loaded(bridge).run_tds(tf=1.0, ext_sienna=spec)
    assert str(excinfo.value) == "ext.sienna: no branch with key branch:7-9-1"
    assert bridge.calls == []


def test_run_tds_branch_column_named() -> None:
    bridge = FakeBridge()
    payload = _loaded(bridge).run_tds(tf=1.0, ext_sienna=_spec())
    by_name = {v["name"]: v["values"] for v in payload["traces"]["variables"]}
    assert by_name["i_from|branch:7-8-1"] == [0.5, 0.51]


def test_run_tds_branch_column_without_key_falls_back() -> None:
    answer = dict(RUN_OK)
    answer["columns"] = [
        {"quantity": "i_from", "kind": "branch", "from": 7, "to": 8, "ckt": "2", "unit": "pu"},
    ]
    answer["rows"] = [[0.5], [0.51]]
    bridge = FakeBridge(answer)
    payload = _loaded(bridge).run_tds(tf=1.0)
    by_name = {v["name"]: v["values"] for v in payload["traces"]["variables"]}
    assert by_name["i_from|branch 7-8-2"] == [0.5, 0.51]
    assert (
        "no key for branch 7-8-2; its series is named i_from|branch 7-8-2"
        in payload["notes"]
    )


def test_run_tds_ext_logged(caplog: pytest.LogCaptureFixture) -> None:
    bridge = FakeBridge()
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        _loaded(bridge).run_tds(tf=1.0, ext_sienna=_spec())
    texts = [record.getMessage() for record in caplog.records]
    assert "ext.sienna: branch branch:7-8-1 is simulated dynamically (DynamicBranch)" in texts
    assert "ext.sienna: generator gen:2-1 runs as an inverter (gfl-omib)" in texts


def test_capabilities_publish_ext() -> None:
    block = engine_capabilities("sienna")
    if not block["available"]:
        # Without Julia the block reports only the unavailability; the ext
        # publication is checked where the engine can start (the integration
        # tests run there). This arm still pins the unavailable shape.
        assert block["unavailable_reason"]
        assert "routine_options" not in block
        return
    tds = block["routine_options"]["tds"]["ext"]
    assert tds["dynamic_branches"] is True
    assert tds["inverters"]["parameter_sets"] == ["gfl-omib", "gfm-omib"]


def test_tds_request_schema_takes_ext() -> None:
    request = TdsRunRequest.model_validate(
        {"tf": 1.0, "ext_sienna": {"dynamic_branches": [{"target": "branch:7-8-1"}], "inverters": []}}
    )
    assert request.ext_sienna is not None
    assert request.ext_sienna.dynamic_branches[0].target == "branch:7-8-1"
    with pytest.raises(ValidationError):
        TdsRunRequest.model_validate({"tf": 1.0, "ext_sienna": {"bogus": 1}})


def test_python_and_julia_parameter_set_ids_agree() -> None:
    """The Julia ``INVERTER_SETS`` table of ``TensaSiennaDyn.jl`` holds exactly
    the ids of the Python ``INVERTER_PARAMETER_SETS``: the two tables are one
    truth, held together by reading the Julia source text (no Julia needed)."""
    # parents: test file -> unit -> tests -> server; the Julia sources ship
    # under server/src.
    source = (
        Path(__file__).parents[2]
        / "src"
        / "tensa"
        / "engines"
        / "sienna"
        / "julia"
        / "TensaSiennaDyn.jl"
    ).read_text(encoding="utf-8")
    julia_ids = set(re.findall(r'^\s+"(g\w+-\w+)"\s*=>', source, flags=re.MULTILINE))
    assert julia_ids == set(INVERTER_PARAMETER_SETS)
