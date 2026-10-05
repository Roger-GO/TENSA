"""Unit tests for the catalogue of ANDES variables a run can record.

These run on stand-ins for the parts of an ANDES System the catalogue reads
(``find_models``, each model's ``states`` / ``algebs`` / ``idx`` / ``idx_params``
and the groups that resolve an idx to its model), so what is checked is the
catalogue's own logic: the names, their order, which devices lose their
algebraic variables to a replacement, and what a refused request says. That the
names are the ones ANDES writes into ``dae.x_name`` / ``dae.y_name``, on real
cases, is in ``tests/integration/test_dae_vars.py``.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tensa.core.dae_vars import (
    MAX_DAE_VARS,
    dae_var_name,
    dae_variables,
    resolve_dae_vars,
    search_dae_variables,
)
from tensa.core.errors import TdsRequestError

pytestmark = pytest.mark.unit


def _var(unit: str | None = None, info: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(unit=unit, info=info)


def _model(
    name: str,
    idx: list[Any],
    *,
    states: dict[str, SimpleNamespace] | None = None,
    algebs: dict[str, SimpleNamespace] | None = None,
    flags: tuple[str, ...] = ("tds",),
    replaces: tuple[str, list[Any]] | None = None,
    online: list[int] | None = None,
) -> SimpleNamespace:
    """A model with ``idx``; ``replaces=(group, targets)`` gives it an ``IdxParam``
    naming the static device each of its devices stands in for."""
    model = SimpleNamespace(
        class_name=name,
        n=len(idx),
        idx=SimpleNamespace(v=list(idx)),
        states=states or {},
        algebs=algebs or {},
        flag_names=flags,
        idx_params={},
        uids={i: uid for uid, i in enumerate(idx)},
    )
    model.idx2uid = model.uids.__getitem__  # type: ignore[attr-defined]
    if online is not None:
        model.u = SimpleNamespace(v=list(online))
    if replaces is not None:
        group, targets = replaces
        model.idx_params["gen"] = SimpleNamespace(replaces=True, model=group, v=list(targets))
    return model


class _Groups:
    """``system.groups``: ``groups[name].idx2model(idx)`` is the model of a device.
    Every group here is the one of static generators, whose only member is ``PV``."""

    def __init__(self, by_name: dict[str, SimpleNamespace]) -> None:
        self._by_name = by_name

    def __getitem__(self, name: str) -> SimpleNamespace:
        return SimpleNamespace(idx2model=lambda idx: self._by_name["PV"])


def _system(*models: SimpleNamespace) -> SimpleNamespace:
    by_name = {m.class_name: m for m in models}

    def find_models(flag: str | tuple[str, ...]) -> dict[str, SimpleNamespace]:
        wanted = (flag,) if isinstance(flag, str) else flag
        return {
            name: m for name, m in by_name.items() if any(f in m.flag_names for f in wanted)
        }

    return SimpleNamespace(find_models=find_models, groups=_Groups(by_name))


def _case() -> SimpleNamespace:
    """Two buses, a PV on bus 2, and a generator that replaces that PV."""
    bus = _model(
        "Bus",
        [1, 2],
        algebs={"a": _var("rad", "voltage angle"), "v": _var("pu", "voltage magnitude")},
        flags=("pflow",),
    )
    pv = _model(
        "PV",
        [2],
        algebs={"q": _var(None, "reactive power")},
        flags=("pflow", "tds"),
    )
    gen = _model(
        "GENROU",
        ["GENROU_1"],
        states={"delta": _var("rad"), "omega": _var("pu")},
        algebs={"Pe": _var()},
        replaces=("PV", [2]),
        online=[1],
    )
    return _system(bus, pv, gen)


# ---- names ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "var", "idx", "expected"),
    [
        ("GENROU", "omega", 1, "omega GENROU 1"),
        ("Bus", "v", 14, "v Bus 14"),
        # A string idx that already holds the model name is not prefixed again.
        ("GENROU", "delta", "GENROU_2", "delta GENROU 2"),
        # Any other string idx is, and underscores in it become spaces.
        ("GENROU", "delta", "G_2", "delta GENROU G 2"),
        # Underscores in the variable's own name stay.
        ("TGOV1", "LL_x", 3, "LL_x TGOV1 3"),
    ],
)
def test_names_follow_andes_spelling(model: str, var: str, idx: int | str, expected: str) -> None:
    assert dae_var_name(model, var, idx) == expected


# ---- the catalogue ----------------------------------------------------------------


def test_catalogue_lists_states_before_algebraic_variables_model_by_model() -> None:
    names = [v.name for v in dae_variables(_case())]
    assert names == [
        "a Bus 1",
        "a Bus 2",
        "v Bus 1",
        "v Bus 2",
        "delta GENROU 1",
        "omega GENROU 1",
        "Pe GENROU 1",
    ]


def test_each_entry_carries_what_andes_says_about_it() -> None:
    by_name = {v.name: v for v in dae_variables(_case())}
    angle = by_name["a Bus 1"]
    assert (angle.kind, angle.model, angle.var, angle.idx) == ("y", "Bus", "a", 1)
    assert (angle.unit, angle.info) == ("rad", "voltage angle")
    omega = by_name["omega GENROU 1"]
    assert (omega.kind, omega.model, omega.var, omega.idx) == ("x", "GENROU", "omega", "GENROU_1")
    # A variable ANDES gives no unit or description reads None, not an empty string.
    assert (by_name["Pe GENROU 1"].unit, by_name["Pe GENROU 1"].info) == (None, None)


def test_a_replaced_static_device_keeps_no_algebraic_variables() -> None:
    system = _case()
    assert "q PV 2" not in [v.name for v in dae_variables(system)]
    assert "q PV 2" in [v.name for v in dae_variables(system, include_replaced=True)]


def test_an_offline_dynamic_device_replaces_nothing() -> None:
    system = _case()
    system.find_models("tds")["GENROU"].u.v = [0]
    assert "q PV 2" in [v.name for v in dae_variables(system)]


def test_a_replacement_that_names_no_device_replaces_nothing() -> None:
    system = _case()
    system.find_models("tds")["GENROU"].idx_params["gen"].v = [None]
    assert "q PV 2" in [v.name for v in dae_variables(system)]


def test_a_repeated_name_is_listed_once() -> None:
    # Two idx that ANDES spells the same ("A_1" and "A 1") would be one column.
    system = _system(_model("M", ["A_1", "A 1"], states={"x": _var()}))
    assert [v.name for v in dae_variables(system)] == ["x M A 1"]


# ---- searching ----------------------------------------------------------------------


def test_every_word_of_the_query_must_match_whatever_its_case() -> None:
    variables = dae_variables(_case())
    assert [v.name for v in search_dae_variables(variables, query="OMEGA gen")] == [
        "omega GENROU 1"
    ]
    assert search_dae_variables(variables, query="omega bus") == []
    assert len(search_dae_variables(variables, query="  ")) == len(variables)


def test_kind_and_model_filters_narrow_the_list() -> None:
    variables = dae_variables(_case())
    assert {v.kind for v in search_dae_variables(variables, kind="x")} == {"x"}
    assert {v.model for v in search_dae_variables(variables, model="genrou")} == {"GENROU"}
    assert [v.name for v in search_dae_variables(variables, model="bus", kind="y", query="2")] == [
        "a Bus 2",
        "v Bus 2",
    ]


# ---- resolving a request ----------------------------------------------------------------


def test_resolve_keeps_the_order_asked_and_drops_repeats() -> None:
    got = resolve_dae_vars(_case(), ["omega GENROU 1", "v Bus 1", "omega GENROU 1"])
    assert [v.name for v in got] == ["omega GENROU 1", "v Bus 1"]


def test_resolve_refuses_a_name_that_is_not_a_variable() -> None:
    with pytest.raises(TdsRequestError, match=r"'omega GENROU 9'.*not ANDES variable"):
        resolve_dae_vars(_case(), ["omega GENROU 1", "omega GENROU 9"])


def test_resolve_says_why_a_replaced_devices_variable_is_refused() -> None:
    with pytest.raises(TdsRequestError, match=r"'q PV 2'.*replaces"):
        resolve_dae_vars(_case(), ["q PV 2"])


def test_resolve_refuses_more_variables_than_a_run_records() -> None:
    names = [f"x{i}" for i in range(MAX_DAE_VARS + 1)]
    with pytest.raises(TdsRequestError, match=str(MAX_DAE_VARS)):
        resolve_dae_vars(_case(), names)
