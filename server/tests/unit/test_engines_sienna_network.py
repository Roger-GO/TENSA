"""Unit tests of ``SiennaState.network_matrix`` with a fake bridge.

No Julia is started: the fake bridge writes a recorded matrix to the file it
is given (and ``.re`` / ``.im`` for ybus) and answers a recorded descriptor,
the way the Julia module answers. The recorded case is the three-bus triangle
of the unit: buses 1, 2, 3, lines 1-2, 1-3 and 2-3, each r = 0 and x = 0.1,
bus 1 the reference. The PTDF is worked by hand in the comment of
``_ptdf_descriptor``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy
import pytest

from tensa.core.errors import NoCaseLoadedError, SiennaError
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.state import (
    NetworkMatrixKindError,
    NetworkMatrixTooLargeError,
    SiennaState,
)


def _topology() -> dict[str, Any]:
    return {
        "base_mva": 100.0,
        "buses": [
            {"number": 1, "type": "ref"},
            {"number": 2, "type": "pv"},
            {"number": 3, "type": "pq"},
        ],
        "branches": [
            {"name": "1-2-i_1", "from": 1, "to": 2, "ckt": "1"},
            {"name": "2-3-i_1", "from": 2, "to": 3, "ckt": "1"},
            {"name": "1-3-i_1", "from": 1, "to": 3, "ckt": "1"},
        ],
        "generators": [],
        "loads": [],
        "shunts": [],
        "dynamics": [],
    }


def _book() -> KeyBook:
    book = KeyBook()
    for number in (1, 2, 3):
        book.assign(KeyEntry(f"bus:{number}", "bus", "Bus", number, "engine"))
    for from_bus, to_bus in ((1, 2), (2, 3), (1, 3)):
        name = f"{from_bus}-{to_bus}-i_1"
        book.assign(
            KeyEntry(f"branch:{from_bus}-{to_bus}-1", "line", "Line", name, "file")
        )
    return book


def _ptdf_descriptor() -> dict[str, Any]:
    # Hand computation of the PTDF of the triangle. With an injection at a
    # bus withdrawn at the reference (bus 1), the reduced susceptance matrix
    # over buses 2 and 3 is [[20, -10], [-10, 20]] (each line adds 1/x = 10 to
    # the two diagonals and -10 to the off-diagonal), whose inverse is
    # [[1/15, 1/30], [1/30, 1/15]]. The flow on line i-j is
    # (theta_i - theta_j) / x. So, for an injection at bus 2
    # (theta_2 = 1/15, theta_3 = 1/30): line 1-2 carries -2/3, line 1-3 -1/3,
    # line 2-3 +1/3; for an injection at bus 3 (theta_2 = 1/30,
    # theta_3 = 1/15): line 1-2 carries -1/3, line 1-3 -2/3, line 2-3 -1/3.
    # The reference bus's column is zero. Rows are the arcs in the order
    # (1,2), (2,3), (1,3); columns the buses 1, 2, 3.
    return {
        "kind": "ptdf",
        "n_rows": 3,
        "n_cols": 3,
        "complex": False,
        "file": "ptdf.bin",
        "files": ["ptdf.bin"],
        "rows": [{"from": 1, "to": 2}, {"from": 2, "to": 3}, {"from": 1, "to": 3}],
        "cols": [1, 2, 3],
        "ref_buses": [1],
        "distributed_slack": False,
    }


_PTDF_VALUES = [
    [0.0, -2.0 / 3.0, -1.0 / 3.0],
    [0.0, 1.0 / 3.0, -1.0 / 3.0],
    [0.0, -1.0 / 3.0, -2.0 / 3.0],
]

_LODF_VALUES = [
    [-1.0, 1.0, 1.0],
    [1.0, -1.0, -1.0],
    [1.0, -1.0, -1.0],
]

_INCIDENCE_VALUES = [
    [1.0, -1.0, 0.0],
    [0.0, 1.0, -1.0],
    [1.0, 0.0, -1.0],
]

# A 3 by 3 complex ybus with seven nonzeros: the diagonal and the four
# off-diagonal entries of lines 1-2 and 2-3 (line 1-3 left at zero so the
# count is seven, not nine).
_YBUS_RE = [
    [2.0, -1.0, 0.0],
    [-1.0, 3.0, -1.0],
    [0.0, -1.0, 2.0],
]
_YBUS_IM = [
    [-20.0, 10.0, 0.0],
    [10.0, -30.0, 10.0],
    [0.0, 10.0, -20.0],
]


class _FakeBridge:
    """Writes the recorded matrix and answers the recorded descriptor."""

    def __init__(self, kind: str = "ptdf") -> None:
        self.started = True
        self.calls: list[tuple[str, Path]] = []
        self._kind = kind

    def start(self) -> None:
        return None

    def network_matrix(self, session: Any, kind: str, file: Path) -> dict[str, Any]:
        self.calls.append((kind, file))
        if self._kind == "raise":
            raise SiennaError(
                "Singular value in factorization. Possibly there is an islanded bus"
            )
        if self._kind == "ybus":
            # tofile writes C order, so the transpose is written: the file then
            # holds the matrix column-major, as the Julia side writes it.
            numpy.asarray(_YBUS_RE, dtype=numpy.float64).T.tofile(str(file) + ".re")
            numpy.asarray(_YBUS_IM, dtype=numpy.float64).T.tofile(str(file) + ".im")
            return {
                "kind": "ybus",
                "n_rows": 3,
                "n_cols": 3,
                "complex": True,
                "file": "ybus.bin.re",
                "files": ["ybus.bin.re", "ybus.bin.im"],
                "rows": [1, 2, 3],
                "cols": [1, 2, 3],
                "distributed_slack": False,
            }
        values = {
            "ptdf": _PTDF_VALUES,
            "lodf": _LODF_VALUES,
            "incidence": _INCIDENCE_VALUES,
        }[self._kind]
        numpy.asarray(values, dtype=numpy.float64).T.tofile(file)
        descriptor = _ptdf_descriptor()
        descriptor["kind"] = self._kind
        descriptor["file"] = f"{self._kind}.bin"
        descriptor["files"] = [f"{self._kind}.bin"]
        if self._kind == "lodf":
            descriptor["cols"] = descriptor["rows"]
        return descriptor


def _state(tmp_path: Path, bridge: _FakeBridge) -> SiennaState:
    state = SiennaState(
        workspace=str(tmp_path), session_id="s1", owner_pid=None, bridge=bridge
    )
    state._session = object()
    state._case_path = tmp_path / "case.raw"
    state._topology_json = _topology()
    state._key_book = _book()
    return state


def test_ptdf_axes_and_values(tmp_path: Path) -> None:
    answer = _state(tmp_path, _FakeBridge()).network_matrix("ptdf")
    assert answer["kind"] == "ptdf"
    assert answer["n_rows"] == 3
    assert answer["n_cols"] == 3
    assert answer["n_entries"] == 9
    assert answer["complex"] is False
    assert answer["base_mva"] == 100.0
    assert answer["rows"] == [
        {"from": 1, "to": 2, "keys": ["branch:1-2-1"]},
        {"from": 2, "to": 3, "keys": ["branch:2-3-1"]},
        {"from": 1, "to": 3, "keys": ["branch:1-3-1"]},
    ]
    assert answer["cols"] == [
        {"bus": 1, "key": "bus:1"},
        {"bus": 2, "key": "bus:2"},
        {"bus": 3, "key": "bus:3"},
    ]
    assert answer["ref_buses"] == ["bus:1"]
    assert answer["distributed_slack"] is False
    assert "entries" not in answer
    assert answer["values"][0] == pytest.approx([0.0, -2.0 / 3.0, -1.0 / 3.0], abs=1e-12)
    assert answer["values"][1] == pytest.approx([0.0, 1.0 / 3.0, -1.0 / 3.0], abs=1e-12)
    assert answer["values"][2] == pytest.approx([0.0, -1.0 / 3.0, -2.0 / 3.0], abs=1e-12)


def test_ptdf_reference_column_zero(tmp_path: Path) -> None:
    answer = _state(tmp_path, _FakeBridge()).network_matrix("ptdf")
    for row in answer["values"]:
        assert row[0] == 0.0


def test_lodf_diagonal(tmp_path: Path) -> None:
    answer = _state(tmp_path, _FakeBridge("lodf")).network_matrix("lodf")
    for i in range(3):
        assert answer["values"][i][i] == pytest.approx(-1.0, abs=1e-12)
    assert answer["rows"] == answer["cols"]


def test_ybus_sparse_triplets(tmp_path: Path) -> None:
    answer = _state(tmp_path, _FakeBridge("ybus")).network_matrix("ybus")
    assert answer["complex"] is True
    assert "values" not in answer
    assert "ref_buses" not in answer
    assert answer["rows"] == [
        {"bus": 1, "key": "bus:1"},
        {"bus": 2, "key": "bus:2"},
        {"bus": 3, "key": "bus:3"},
    ]
    assert answer["cols"] == answer["rows"]
    entries = answer["entries"]
    assert answer["n_entries"] == 7
    assert len(entries) == 7
    assert entries[0] == {"row": 0, "col": 0, "re": 2.0, "im": -20.0}
    assert entries[1] == {"row": 0, "col": 1, "re": -1.0, "im": 10.0}
    # Row-major order, and the zero entries of the missing line are not listed.
    assert [(e["row"], e["col"]) for e in entries] == [
        (0, 0),
        (0, 1),
        (1, 0),
        (1, 1),
        (1, 2),
        (2, 1),
        (2, 2),
    ]


def test_incidence(tmp_path: Path) -> None:
    answer = _state(tmp_path, _FakeBridge("incidence")).network_matrix("incidence")
    assert answer["n_entries"] == 9
    assert answer["values"] == _INCIDENCE_VALUES
    for row in answer["values"]:
        assert sum(row) == 0.0
        assert sorted(row) == [-1.0, 0.0, 1.0]


def test_unknown_kind(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    state = _state(tmp_path, bridge)
    with pytest.raises(
        NetworkMatrixKindError,
        match=r"unknown network matrix kind: 'modf'; the kinds are ptdf, lodf, ybus, incidence",
    ):
        state.network_matrix("modf")
    assert bridge.calls == []


def test_no_case(tmp_path: Path) -> None:
    state = SiennaState(
        workspace=str(tmp_path), session_id="s1", owner_pid=None, bridge=_FakeBridge()
    )
    with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
        state.network_matrix("ptdf")


def test_too_large(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _FakeBridge()
    state = _state(tmp_path, bridge)
    monkeypatch.setattr("tensa.engines.sienna.state.MAX_YBUS_ENTRIES", 4)
    with pytest.raises(NetworkMatrixTooLargeError) as excinfo:
        state.network_matrix("ptdf")
    assert "9" in str(excinfo.value)
    assert "4" in str(excinfo.value)
    # The cap refuses the answer, not the build; the file it wrote is removed.
    assert not bridge.calls[0][1].exists()


def test_too_large_dense_is_refused_before_the_file_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _never(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the file was read")

    monkeypatch.setattr("tensa.engines.sienna.state.MAX_YBUS_ENTRIES", 4)
    monkeypatch.setattr("tensa.engines.sienna.state.read_matrix", _never)
    with pytest.raises(NetworkMatrixTooLargeError):
        _state(tmp_path, _FakeBridge()).network_matrix("ptdf")


def test_too_many_ybus_nonzeros(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The Ybus cap counts the nonzeros the answer would list (seven), not the
    nine cells of the dense file."""
    monkeypatch.setattr("tensa.engines.sienna.state.MAX_YBUS_ENTRIES", 7)
    assert _state(tmp_path, _FakeBridge("ybus")).network_matrix("ybus")["n_entries"] == 7
    monkeypatch.setattr("tensa.engines.sienna.state.MAX_YBUS_ENTRIES", 6)
    bridge = _FakeBridge("ybus")
    with pytest.raises(NetworkMatrixTooLargeError, match="7"):
        _state(tmp_path, bridge).network_matrix("ybus")
    file = bridge.calls[0][1]
    assert not Path(str(file) + ".re").exists()
    assert not Path(str(file) + ".im").exists()


@pytest.mark.parametrize("kind", ["ptdf", "ybus"])
def test_the_matrix_files_are_removed_once_read(tmp_path: Path, kind: str) -> None:
    bridge = _FakeBridge(kind)
    _state(tmp_path, bridge).network_matrix(kind)
    file = bridge.calls[0][1]
    assert list(file.parent.glob(f"{file.name}*")) == []


def test_a_missing_matrix_file_is_a_sienna_error(tmp_path: Path) -> None:
    class _WritesNothing(_FakeBridge):
        def network_matrix(self, session: Any, kind: str, file: Path) -> dict[str, Any]:
            descriptor = super().network_matrix(session, kind, file)
            file.unlink()
            return descriptor

    with pytest.raises(SiennaError, match="the ptdf matrix file could not be read"):
        _state(tmp_path, _WritesNothing()).network_matrix("ptdf")


def test_julia_error_passes_through(tmp_path: Path) -> None:
    state = _state(tmp_path, _FakeBridge("raise"))
    with pytest.raises(SiennaError, match="Singular value in factorization"):
        state.network_matrix("ptdf")


def test_parallel_arc_keys(tmp_path: Path) -> None:
    state = _state(tmp_path, _FakeBridge())
    topology = _topology()
    topology["branches"].append(
        {"name": "1-2-i_2", "from": 1, "to": 2, "ckt": "2"}
    )
    state._topology_json = topology
    state._key_book.assign(
        KeyEntry("branch:1-2-2", "line", "Line", "1-2-i_2", "file")
    )
    answer = state.network_matrix("ptdf")
    assert answer["rows"][0] == {
        "from": 1,
        "to": 2,
        "keys": ["branch:1-2-1", "branch:1-2-2"],
    }


def test_file_in_scratch(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    state = _state(tmp_path, bridge)
    state.network_matrix("ptdf")
    assert bridge.calls == [
        ("ptdf", tmp_path / ".sessions" / "s1" / "sienna" / "ptdf.bin")
    ]
