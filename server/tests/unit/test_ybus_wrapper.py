"""Unit tests for ``Wrapper.bus_admittance_matrix``.

The matrix is held to one built by hand from the pi model of a branch: a series
admittance ``y = 1 / (r + jx)``, half the charging ``jb / 2`` at each end, and an
off-nominal tap ``t`` on the side of ``bus1``, which gives

    Y11 = (y + jb/2) / t**2,   Y12 = Y21 = -y / t,   Y22 = y + jb/2

plus a shunt's ``g + jb`` on the diagonal of its bus.
"""

from __future__ import annotations

import cmath
from typing import Any

import pytest

import tensa.core.wrapper.ybus as ybus_module
from tensa.api.error_mapping import map_worker_error
from tensa.core.errors import NoCaseLoadedError, YbusTooLargeError
from tensa.core.session import WorkerError
from tensa.core.wrapper import Wrapper, YbusResult

R, X, B = 0.01, 0.1, 0.02
TAP = 1.05
G_SH, B_SH = 0.003, 0.2


def _matrix(result: YbusResult) -> dict[tuple[str, str], complex]:
    """The entries keyed by the buses of their row and column."""
    return {
        (result.bus_idx[e.row], result.bus_idx[e.col]): complex(e.re, e.im)
        for e in result.entries
    }


def _two_buses(**line: Any) -> Wrapper:
    wrapper = Wrapper()
    wrapper.create_blank()
    wrapper.add_element("Bus", {"idx": 10, "name": "b10"})
    wrapper.add_element("Bus", {"idx": 20, "name": "b20"})
    wrapper.add_element(
        "Line",
        {"idx": "Line_1", "bus1": 10, "bus2": 20, "r": R, "x": X, "b": B, **line},
    )
    return wrapper


@pytest.mark.unit
def test_no_case_loaded_raises() -> None:
    with pytest.raises(NoCaseLoadedError):
        Wrapper().bus_admittance_matrix()


@pytest.mark.unit
def test_a_line_gives_the_pi_model_by_hand() -> None:
    result = _two_buses().bus_admittance_matrix()
    assert result.n_bus == 2
    assert result.bus_idx == ["10", "20"]
    assert result.base_mva == pytest.approx(100.0)
    y = 1 / complex(R, X)
    expected = {
        ("10", "10"): y + 0.5j * B,
        ("10", "20"): -y,
        ("20", "10"): -y,
        ("20", "20"): y + 0.5j * B,
    }
    got = _matrix(result)
    assert got.keys() == expected.keys()
    for at, value in expected.items():
        assert got[at] == pytest.approx(value, rel=1e-12), at
    for entry in result.entries:
        assert type(entry.row) is int and type(entry.col) is int
        assert type(entry.re) is float and type(entry.im) is float


@pytest.mark.unit
def test_a_transformer_tap_and_a_shunt_by_hand() -> None:
    wrapper = _two_buses(tap=TAP)
    wrapper.add_element("Shunt", {"idx": "Sh_1", "bus": 20, "g": G_SH, "b": B_SH})
    got = _matrix(wrapper.bus_admittance_matrix())
    y = 1 / complex(R, X)
    assert got[("10", "10")] == pytest.approx((y + 0.5j * B) / TAP**2, rel=1e-12)
    assert got[("10", "20")] == pytest.approx(-y / TAP, rel=1e-12)
    assert got[("20", "10")] == pytest.approx(-y / TAP, rel=1e-12)
    assert got[("20", "20")] == pytest.approx(y + 0.5j * B + complex(G_SH, B_SH), rel=1e-12)


@pytest.mark.unit
def test_a_phase_shifter_makes_the_matrix_unsymmetric() -> None:
    phi = 0.1
    got = _matrix(_two_buses(phi=phi).bus_admittance_matrix())
    y = 1 / complex(R, X)
    m = cmath.exp(1j * phi)
    assert got[("10", "20")] == pytest.approx(-y / m.conjugate(), rel=1e-12)
    assert got[("20", "10")] == pytest.approx(-y / m, rel=1e-12)
    assert got[("10", "20")] != pytest.approx(got[("20", "10")])


@pytest.mark.unit
def test_the_bus_order_is_the_order_of_bus_idx_whatever_the_numbers() -> None:
    wrapper = Wrapper()
    wrapper.create_blank()
    for idx in (30, 5, 17):
        wrapper.add_element("Bus", {"idx": idx, "name": f"b{idx}"})
    wrapper.add_element("Line", {"idx": "L", "bus1": 17, "bus2": 30, "r": R, "x": X})
    result = wrapper.bus_admittance_matrix()
    assert result.bus_idx == ["30", "5", "17"]
    rows = {(e.row, e.col) for e in result.entries}
    assert rows == {(0, 0), (0, 2), (2, 0), (2, 2)}


@pytest.mark.unit
def test_every_bus_carries_its_key() -> None:
    wrapper = _two_buses()
    result = wrapper.bus_admittance_matrix()
    book = wrapper.keys()
    assert result.bus_key == [book.key_of("Bus", idx) for idx in result.bus_idx]
    assert all(key is not None for key in result.bus_key)


@pytest.mark.unit
def test_a_line_switched_off_is_absent_not_a_stored_zero() -> None:
    wrapper = _two_buses()
    wrapper.add_element("Shunt", {"idx": "Sh_1", "bus": 20, "g": G_SH, "b": B_SH})
    wrapper.bus_admittance_matrix()
    ss = wrapper._require_loaded()
    ss.Line.u.v[:] = 0
    got = _matrix(wrapper.bus_admittance_matrix())
    # ANDES still stores the line's four entries as zeros; none is answered.
    assert got == {("20", "20"): pytest.approx(complex(G_SH, B_SH))}


@pytest.mark.unit
def test_the_call_sets_the_system_up() -> None:
    wrapper = _two_buses()
    assert not wrapper._require_loaded().is_setup
    assert wrapper.bus_admittance_matrix().entries
    assert wrapper._require_loaded().is_setup


@pytest.mark.unit
def test_buses_only_system_has_no_entries() -> None:
    wrapper = Wrapper()
    wrapper.create_blank()
    wrapper.add_element("Bus", {"idx": 1, "name": "b1"})
    wrapper.add_element("Bus", {"idx": 2, "name": "b2"})
    result = wrapper.bus_admittance_matrix()
    assert result.n_bus == 2
    assert result.bus_idx == ["1", "2"]
    assert result.entries == []


@pytest.mark.unit
def test_past_the_cap_it_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    wrapper = _two_buses()
    monkeypatch.setattr(ybus_module, "MAX_YBUS_ENTRIES", 4)
    assert len(wrapper.bus_admittance_matrix().entries) == 4
    monkeypatch.setattr(ybus_module, "MAX_YBUS_ENTRIES", 3)
    with pytest.raises(YbusTooLargeError, match="4 nonzero entries"):
        wrapper.bus_admittance_matrix()


@pytest.mark.unit
def test_too_large_maps_to_422_with_no_recovery() -> None:
    http = map_worker_error(WorkerError("YbusTooLargeError", str(YbusTooLargeError(9, 3))))
    assert http.status_code == 422
    assert isinstance(http.detail, dict)
    assert http.detail["recovery"] is None
