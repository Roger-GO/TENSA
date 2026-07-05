"""Unit-level tests for ``Wrapper`` disturbance-replay infrastructure (Unit 6.5).

These tests exercise the small surface around ``_disturbance_log``:

- A fresh ``Wrapper`` exposes an empty disturbance log.
- ``clear_disturbances`` zeroes the log.
- ``replay_disturbances`` no-ops when there is no System loaded — well, it
  raises ``NoCaseLoadedError`` (the documented contract) — and no-ops when
  the log is empty on a fresh blank session.
- ``list_disturbances`` returns a defensive copy (mutating the result must
  not mutate internal state).

These do not import ANDES — they construct a ``Wrapper`` and operate on
``_disturbance_log`` / ``_ss`` directly. The integration-side tests
(``tests/integration/test_disturbances_replay_api.py`` and the new
wrapper-level ones in ``tests/integration/test_wrapper.py``) cover the
ANDES-touching code paths.
"""

from __future__ import annotations

import pytest

from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from tensa.core.errors import NoCaseLoadedError
from tensa.core.wrapper import Wrapper


@pytest.mark.unit
def test_fresh_wrapper_has_empty_disturbance_log() -> None:
    """Sanity: ``Wrapper.__init__`` sets up the disturbance log slot."""
    w = Wrapper()
    assert w.list_disturbances() == []
    # Hidden field is the same value (defensive copy semantics).
    assert w._disturbance_log == []  # noqa: SLF001 — internal state check


@pytest.mark.unit
def test_list_disturbances_returns_defensive_copy() -> None:
    """Mutating the returned list must not affect the wrapper's state."""
    w = Wrapper()
    # Hand-seed without touching ANDES — the list shape is what the test
    # cares about. Use a synthesizable spec.
    seeded = [
        FaultSpec(bus_idx=4, tf=1.0, tc=1.1),
        ToggleSpec(model="Line", dev_idx="L1", t=1.5),
    ]
    w._disturbance_log = list(seeded)  # noqa: SLF001
    snapshot = w.list_disturbances()
    snapshot.clear()
    assert w.list_disturbances() == seeded


@pytest.mark.unit
def test_clear_disturbances_empties_the_log() -> None:
    w = Wrapper()
    w._disturbance_log = [FaultSpec(bus_idx=4, tf=1.0, tc=1.1)]  # noqa: SLF001
    w.clear_disturbances()
    assert w.list_disturbances() == []


@pytest.mark.unit
def test_replay_disturbances_without_load_raises_no_case_loaded() -> None:
    """Replay needs a System to add against; without one, the contract is
    the same as every other ``ss``-touching API: ``NoCaseLoadedError``."""
    w = Wrapper()
    with pytest.raises(NoCaseLoadedError):
        w.replay_disturbances()


@pytest.mark.unit
def test_disturbance_specs_are_json_round_trippable() -> None:
    """Snapshot metadata (Unit 7) will JSON-serialize specs via
    ``model_dump()`` and reconstruct them via the discriminated union.
    Verify the round-trip preserves every field for each spec type."""
    specs = [
        FaultSpec(bus_idx=4, tf=1.0, tc=1.1, xf=0.0001, rf=0.0),
        ToggleSpec(model="Line", dev_idx="Line_2", t=1.5),
        AlterSpec(model="GENROU", dev_idx=1, src="p0", t=2.0, value=0.5),
    ]
    for spec in specs:
        as_dict = spec.model_dump()
        # Discriminator field must always be present.
        assert "kind" in as_dict
        # Reconstructable via the same constructor.
        cls = type(spec)
        rebuilt = cls(**as_dict)
        assert rebuilt == spec


# ---- idx representation coercion (agent-facing robustness) ------------------


class _FakeIdx:
    def __init__(self, values: list[object]) -> None:
        self.v = values


class _FakeModel:
    def __init__(self, values: list[object]) -> None:
        self.idx = _FakeIdx(values)


class _FakeSystem:
    def __init__(self, **models: _FakeModel) -> None:
        for name, model in models.items():
            setattr(self, name, model)


@pytest.mark.unit
def test_coerce_existing_idx_matches_string_to_native_int() -> None:
    """JSON clients send "7"; xlsx cases store 7 — resolve to the native int."""
    ss = _FakeSystem(Bus=_FakeModel([1, 2, 7, 14]))
    assert Wrapper._coerce_existing_idx(ss, "Bus", "7") == 7


@pytest.mark.unit
def test_coerce_existing_idx_keeps_exact_match_untouched() -> None:
    ss = _FakeSystem(Bus=_FakeModel(["B1", "B2"]))
    assert Wrapper._coerce_existing_idx(ss, "Bus", "B2") == "B2"
    ss_int = _FakeSystem(Bus=_FakeModel([1, 2]))
    assert Wrapper._coerce_existing_idx(ss_int, "Bus", 2) == 2


@pytest.mark.unit
def test_coerce_existing_idx_passes_unknown_through() -> None:
    """Unknown idx stays as-is so ANDES raises its own descriptive error."""
    ss = _FakeSystem(Bus=_FakeModel([1, 2]))
    assert Wrapper._coerce_existing_idx(ss, "Bus", "99") == "99"
    # Unknown model name → unchanged.
    assert Wrapper._coerce_existing_idx(ss, "Line", "1") == "1"
