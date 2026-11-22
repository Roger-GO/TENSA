"""``write_dyr``: a case's dynamic models written as a PSS/E ``.dyr`` that ANDES
reads back into the same models with the same parameters.

Each example case is loaded from its ``.xlsx``, written as ``.raw`` (the
existing ``write_raw``) and ``.dyr`` (``write_dyr``), and read back by ANDES
with the column put-back TENSA's load applies (``put_back_dyr_columns``). The
two Systems must hold the same dynamic models with the same parameters, solve
the same power flow, and give the same time-domain run with a bus fault.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import pytest

andes = pytest.importorskip("andes")

from tensa.core.dyr_columns import put_back_dyr_columns  # noqa: E402
from tensa.core.dyr_writer import _dyr_yaml, _links_of, write_dyr  # noqa: E402
from tensa.core.examples import _andes_cases_dir  # noqa: E402
from tensa.core.psse_writer import raw_generator_ids, write_raw  # noqa: E402

andes.config_logger(stream_level=50)

_TENSA_CASES = Path(__file__).resolve().parents[2] / "src" / "tensa" / "examples" / "cases"

# The example cases, and the records each must give (counted from the models
# each case holds; TGOV1N is written as TGOV1).
_CASES: dict[str, tuple[Path, dict[str, int]]] = {
    "ieee14": (_andes_cases_dir() / "ieee14" / "ieee14_full.xlsx", {"GENROU": 5, "EXST1": 1, "ESST3A": 4, "TGOV1": 5}),
    "ieee39": (_andes_cases_dir() / "ieee39" / "ieee39_full.xlsx", {"GENROU": 10, "IEEEX1": 10, "TGOV1": 10, "IEEEST": 10}),
    "kundur": (_andes_cases_dir() / "kundur" / "kundur_full.xlsx", {"GENROU": 4, "EXDC2": 4, "TGOV1": 4}),
    "npcc": (_andes_cases_dir() / "npcc" / "npcc.xlsx", {"GENCLS": 21, "GENROU": 27, "IEEEX1": 24, "TGOV1": 29}),
    "wscc9": (_TENSA_CASES / "wscc9.xlsx", {"GENCLS": 3}),
}

# An ANDES model written as another PSS/E model reads back as that model.
_READ_BACK_AS = {"TGOV1N": "TGOV1"}

# Parameters a record does not carry: the links and the values the reader
# takes from another device through ``get`` (they travel in the .raw).
_NOT_IN_RECORD = {"idx", "u", "name", "bus", "gen", "syn", "avr", "reg", "Sn", "Vn", "ra", "xs", "Sg", "busr", "busr2"}


def _load(path: Path, addfile: Path | None = None) -> Any:
    ss = andes.load(
        str(path), addfile=str(addfile) if addfile else None, setup=False, no_output=True, default_config=True
    )
    assert ss is not None
    return ss


def _round_trip(case: Path, tmp_path: Path) -> tuple[Any, Any, Any]:
    """The System read from ``case``, the one read back from the .raw and .dyr
    written from it, and the writer's report."""
    original = _load(case)
    raw, dyr = tmp_path / "case.raw", tmp_path / "case.dyr"
    write_raw(original, raw)
    report = write_dyr(original, dyr)
    back = _load(raw, dyr)
    put_back_dyr_columns(back, [dyr], notify=False)
    return original, back, report


def _reader_destinations() -> set[str]:
    return {str(entry["destination"]) for entry in _dyr_yaml().values() if isinstance(entry, dict) and "destination" in entry}


def _written_params(model: str) -> list[str]:
    """The ANDES parameters of ``model`` a record carries: every target of
    the reader entry's ``outputs`` but the links and the values from ``get``."""
    psse_model = _READ_BACK_AS.get(model, model)
    entry = _dyr_yaml()[psse_model]
    links = _links_of(psse_model) | _NOT_IN_RECORD
    return sorted(str(target) for target in entry["outputs"] if str(target) not in links)


def _parameter_sets(ss: Any, model: str, params: list[str]) -> list[tuple[float, ...]]:
    """Every device of ``model`` as the tuple of ``params``, sorted, so two
    Systems compare without matching devices one by one."""
    obj = getattr(ss, model)
    rows = []
    for position in range(obj.n):
        row = []
        for name in params:
            value = getattr(obj, name).v[position]
            row.append(float("nan") if value is None else float(value))
        rows.append(tuple(row))
    return sorted(rows, key=lambda r: tuple(-1e300 if math.isnan(x) else x for x in r))


@pytest.mark.parametrize("name", sorted(_CASES))
def test_every_dynamic_model_reads_back_with_its_parameters(name: str, tmp_path: Path) -> None:
    case, expected = _CASES[name]
    original, back, report = _round_trip(case, tmp_path)
    assert report.records == expected
    assert report.skipped == []
    # The dynamic models the case holds (the reader also reads Toggle and
    # Fault records, which are events): the ones the case is expected to write.
    models = {m for m, obj in original.models.items() if obj.n and _READ_BACK_AS.get(m, m) in expected}
    assert models, name
    for model in models:
        target = _READ_BACK_AS.get(model, model)
        params = [p for p in _written_params(model) if hasattr(getattr(back, target), p)]
        left = _parameter_sets(original, model, params)
        right = _parameter_sets(back, target, params)
        assert len(left) == len(right), model
        for a, b in zip(left, right, strict=True):
            for x, y in zip(a, b, strict=True):
                assert (math.isnan(x) and math.isnan(y)) or math.isclose(x, y, rel_tol=1e-12, abs_tol=1e-12), (
                    model,
                    params,
                    a,
                    b,
                )


@pytest.mark.parametrize("name", ["ieee14", "kundur"])
def test_power_flow_and_a_faulted_run_agree(name: str, tmp_path: Path) -> None:
    """The .raw keeps the network to the precision it writes (voltages within
    1e-6 pu); a run of 1 s with a 0.1 s fault at a load bus then gives the same
    rotor speeds within 1e-5 pu."""
    case, _ = _CASES[name]
    original, back, _ = _round_trip(case, tmp_path)
    for ss in (original, back):
        for i in range(ss.Toggle.n):
            ss.Toggle.u.v[i] = 0
        ss.add("Fault", {"bus": ss.PQ.bus.v[0], "tf": 0.1, "tc": 0.2})
        ss.setup()
        assert ss.PFlow.run()
    v0 = dict(zip(original.Bus.idx.v, original.Bus.v.v, strict=True))
    v1 = dict(zip(back.Bus.idx.v, back.Bus.v.v, strict=True))
    assert set(v0) == set(v1)
    assert max(abs(v0[b] - v1[b]) for b in v0) <= 1e-6
    speeds = []
    for ss in (original, back):
        ss.TDS.config.tf = 1.0
        ss.TDS.config.no_tqdm = 1
        ss.TDS.run()
        speeds.append(ss.dae.ts.x[:, ss.GENROU.omega.a])
    assert speeds[0].shape == speeds[1].shape
    assert float(abs(speeds[0] - speeds[1]).max()) <= 1e-5


def test_h_is_written_as_m_over_2(tmp_path: Path) -> None:
    original = _load(_CASES["kundur"][0])
    dyr = tmp_path / "case.dyr"
    write_dyr(original, dyr)
    first = next(line for line in dyr.read_text(encoding="utf-8").splitlines() if "'GENROU'" in line)
    tokens = first.replace("/", " ").split()
    # BUS 'GENROU' ID Td10 Td20 Tq10 Tq20 H ...: H is the eighth token.
    assert float(tokens[7]) == float(original.GENROU.M.v[0]) / 2


def test_records_name_the_generator_ids_the_raw_writes(tmp_path: Path) -> None:
    """Every record's bus and id is a generator of the .raw: the two files
    name one machine."""
    original = _load(_CASES["npcc"][0])
    dyr = tmp_path / "case.dyr"
    write_dyr(original, dyr)
    ids = raw_generator_ids(original)
    pairs = {(int(original.StaticGen.get(src="bus", idx=idx, attr="v")), machine_id) for idx, machine_id in ids.items()}
    # A record ends at its "/"; a long one runs over several lines.
    records = [r.strip() for r in dyr.read_text(encoding="utf-8").split("/") if r.strip()]
    assert records
    for line in records:
        tokens = line.split()
        assert (int(tokens[0]), tokens[2]) in pairs, line


def test_tgov1n_is_written_as_tgov1_with_a_note(tmp_path: Path) -> None:
    original = _load(_CASES["ieee39"][0])
    report = write_dyr(original, tmp_path / "case.dyr")
    assert original.TGOV1N.n == 10
    assert report.records["TGOV1"] == 10
    assert any("TGOV1N" in note for note in report.notes)


def test_a_case_without_dynamics_writes_no_record(tmp_path: Path) -> None:
    original = _load(_andes_cases_dir() / "wscc9" / "wscc9.xlsx")
    report = write_dyr(original, tmp_path / "case.dyr")
    assert report.records == {}
    assert report.skipped == []
