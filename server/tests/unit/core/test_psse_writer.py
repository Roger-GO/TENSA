"""Unit tests for the PSS/E ``.raw`` writer: its text encoding, and what it
writes of a case that has dynamic models.

``write_raw`` used to call ``Path.write_text`` with no ``encoding`` or
``newline``, so the file's bytes depended on the platform: cp1252 with CRLF
line endings on Windows (and a ``UnicodeEncodeError`` for a bus name outside
cp1252), UTF-8 with LF elsewhere. The writer now pins UTF-8 and LF.

It also wrote a dynamic model as a device of its own: a ``ZIP`` load as a
second load beside the ``PQ`` it stands on, and a ``GENROU`` as a second
generator beside its ``PV`` or ``Slack``. The last tests hold it to the
power-flow data alone.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from tensa.core.psse_writer import write_raw

# A name with a cp1252 letter (n with tilde) and one cp1252 cannot hold (omega).
_NON_ASCII_NAME = "Peña Ω"


def _ieee14_raw() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14" / "ieee14.raw"


def _load_ieee14(name: str | None = None):  # type: ignore[no-untyped-def]
    import andes

    ss = andes.load(str(_ieee14_raw()), setup=True, no_output=True, default_config=True)
    if name is not None:
        ss.Bus.name.v[0] = name
    return ss


def test_write_raw_is_utf8_with_lf_line_endings(tmp_path: Path) -> None:
    target = tmp_path / "out.raw"
    write_raw(_load_ieee14(_NON_ASCII_NAME), target)

    data = target.read_bytes()
    assert _NON_ASCII_NAME in data.decode("utf-8")
    assert b"\r" not in data
    assert data.endswith(b"\n")


def test_write_raw_pins_encoding_and_newline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CRLF translation only happens on Windows, so pin the call itself: the
    guard is the explicit ``newline="\\n"`` (and ``encoding``) on the write."""
    seen: dict[str, object] = {}
    real_write_text = Path.write_text

    def spy(self: Path, data: str, *args: object, **kwargs: object) -> int:
        seen.update(kwargs)
        return real_write_text(self, data, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "write_text", spy)
    write_raw(_load_ieee14(), tmp_path / "out.raw")

    assert seen.get("encoding") == "utf-8"
    assert seen.get("newline") == "\n"


def test_write_raw_ignores_the_platform_default_encoding(tmp_path: Path) -> None:
    """Run the writer in a process whose default text encoding is ASCII (the
    stand-in for cp1252 on Windows, which also cannot hold omega). The old
    unqualified ``write_text`` raised ``UnicodeEncodeError`` here. The script is
    passed with ``ascii()`` escapes so the command line itself survives."""
    target = tmp_path / "out.raw"
    script = textwrap.dedent(
        f"""
        import andes
        from tensa.core.psse_writer import write_raw

        ss = andes.load({ascii(str(_ieee14_raw()))}, setup=True, no_output=True,
                        default_config=True)
        ss.Bus.name.v[0] = {ascii(_NON_ASCII_NAME)}
        write_raw(ss, {ascii(str(target))})
        """
    )
    env = {
        **os.environ,
        "PYTHONUTF8": "0",
        "PYTHONCOERCECLOCALE": "0",
        "PYTHONIOENCODING": "ascii:backslashreplace",
        "LC_ALL": "C",
        "LANG": "C",
    }
    proc = subprocess.run(
        [sys.executable, "-c", script],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert _NON_ASCII_NAME in target.read_bytes().decode("utf-8")


# One non-ASCII character is the hard case for chardet: before version 6 it took
# a UTF-8 file with a single accented letter for Latin-1 or MacRoman. The two
# multibyte characters in ``_NON_ASCII_NAME`` were enough to hide that.
@pytest.mark.parametrize(
    "name",
    ["Peña", "Müller", "São Paulo", "Ω", "東京", _NON_ASCII_NAME],
)
def test_write_raw_non_ascii_bus_name_round_trips_through_andes(
    tmp_path: Path, name: str
) -> None:
    """ANDES sniffs the encoding with chardet; the UTF-8 file must read back
    with the name intact. A failure with a single accented letter means the
    installed chardet is older than the ``chardet>=6`` the package requires."""
    import andes

    target = tmp_path / "out.raw"
    write_raw(_load_ieee14(name), target)

    ss = andes.load(str(target), setup=True, no_output=True, default_config=True)
    assert ss.Bus.name.v[0].strip() == name


# ---- a case with dynamic models ---------------------------------------------------

_MW_TOLERANCE = 1e-4  # the writer keeps five decimals of a MW


def _zip_case() -> str:
    """ANDES's IEEE 14 with a ``ZIP`` load on ``PQ_1`` and a ``GENROU`` on each of its
    five static generators."""
    pytest.importorskip("andes")
    import andes

    path = Path(andes.__file__).parent / "cases" / "ieee14" / "ieee14_zip.json"
    if not path.is_file():
        pytest.skip("this ANDES does not ship ieee14_zip.json")
    return str(path)


def _load_zip_case(*, setup: bool = True):  # type: ignore[no-untyped-def]
    import andes

    return andes.load(_zip_case(), setup=setup, no_output=True, default_config=True)


def _records(path: Path, section: str) -> list[list[str]]:
    """The records of one section of a ``.raw`` file, each split into its fields."""
    lines = path.read_text(encoding="utf-8").splitlines()
    # The bus section comes first, straight after the three lines of the header.
    start = (
        2
        if section == "BUS"
        else next(i for i, line in enumerate(lines) if f"BEGIN {section} DATA" in line)
    )
    end = next(i for i, line in enumerate(lines) if f"END OF {section} DATA" in line)
    return [[field.strip() for field in line.split(",")] for line in lines[start + 1 : end]]


def _megawatts(records: list[list[str]], column: int) -> float:
    return sum(float(record[column]) for record in records)


def test_a_dynamic_model_is_not_written_as_a_device_of_its_own(tmp_path: Path) -> None:
    ss = _load_zip_case()
    ss.PFlow.run()
    # What the case is for: a dynamic load and machines, each on a static device.
    assert ss.ZIP.n == 1 and ss.GENROU.n == ss.PV.n + ss.Slack.n == 5
    target = write_raw(ss, tmp_path / "out.raw")

    loads, generators = _records(target, "LOAD"), _records(target, "GENERATOR")
    assert len(loads) == ss.PQ.n
    assert len(generators) == ss.PV.n + ss.Slack.n
    # One of each on a bus: the second would carry the id ' 2'.
    assert {record[1] for record in loads + generators} == {"' 1'"}
    mva = float(ss.config.mva)
    assert _megawatts(loads, 5) == pytest.approx(mva * float(sum(ss.PQ.p0.v)), abs=_MW_TOLERANCE)
    # A bus with a machine is typed by the static generator under it, as before.
    types = {record[0]: record[3] for record in _records(target, "BUS")}
    assert sorted(types.values()).count("3") == ss.Slack.n
    assert sorted(types.values()).count("2") == ss.PV.n


def test_a_time_domain_run_does_not_double_the_load_or_the_generation(tmp_path: Path) -> None:
    ss = _load_zip_case()
    ss.PFlow.run()
    before = write_raw(ss, tmp_path / "before.raw")
    ss.TDS.config.tf = 0.1
    ss.TDS.run()
    # What doubled them: the run fills each dynamic model's own ``p0`` from the device it
    # stands on, and switches that device off.
    assert float(ss.ZIP.p0.v[0]) == pytest.approx(float(ss.PQ.p0.v[0]))
    assert float(ss.GENROU.p0.v[0]) > 0.0
    assert float(ss.Slack.u.v[0]) == 0.0
    after = write_raw(ss, tmp_path / "after.raw")

    assert _records(after, "LOAD") == _records(before, "LOAD")
    generators = _records(after, "GENERATOR")
    assert len(generators) == len(_records(before, "GENERATOR")) == ss.PV.n + ss.Slack.n
    # A generator the run switched off has no output of its own left to read (ANDES
    # zeroes it), so its record takes the dispatch the case holds, not a zero.
    mva = float(ss.config.mva)
    dispatch = mva * float(sum(ss.PV.p0.v) + sum(ss.Slack.p0.v))
    assert _megawatts(generators, 2) == pytest.approx(dispatch, abs=_MW_TOLERANCE)
    slack_bus = str(ss.Slack.bus.v[0])
    (slack,) = [record for record in generators if record[0] == slack_bus]
    assert float(slack[2]) == pytest.approx(mva * float(ss.Slack.p0.v[0]), abs=_MW_TOLERANCE)
    assert float(slack[3]) == pytest.approx(mva * float(ss.Slack.q0.v[0]), abs=_MW_TOLERANCE)


def test_the_solved_output_of_a_generator_is_written_while_it_stands(tmp_path: Path) -> None:
    ss = _load_zip_case()
    # Before a power flow there is nothing solved, and ``p`` and ``q`` are zero.
    unsolved = _records(write_raw(ss, tmp_path / "unsolved.raw"), "GENERATOR")
    mva = float(ss.config.mva)
    assert _megawatts(unsolved, 2) == pytest.approx(
        mva * float(sum(ss.PV.p0.v) + sum(ss.Slack.p0.v)), abs=_MW_TOLERANCE
    )
    ss.PFlow.run()
    solved = _records(write_raw(ss, tmp_path / "solved.raw"), "GENERATOR")
    slack_bus = str(ss.Slack.bus.v[0])
    (slack,) = [record for record in solved if record[0] == slack_bus]
    assert float(slack[2]) == pytest.approx(mva * float(ss.Slack.p.v[0]), abs=_MW_TOLERANCE)
    assert float(slack[3]) == pytest.approx(mva * float(ss.Slack.q.v[0]), abs=_MW_TOLERANCE)


@pytest.mark.parametrize("state", ["before a run", "after a power flow", "after a time-domain run"])
def test_the_file_of_a_dynamic_case_reads_back_as_the_same_power_flow(
    tmp_path: Path, state: str
) -> None:
    """With a second generator on every generator bus, the power flow of the file read
    back did not converge at all, whatever state the case was saved in."""
    import andes

    reference = _load_zip_case()
    reference.PFlow.run()
    assert reference.PFlow.converged
    expected = dict(zip(reference.Bus.idx.v, reference.Bus.v.v, strict=True))

    ss = _load_zip_case(setup=state != "before a run")
    if state != "before a run":
        ss.PFlow.run()
    if state == "after a time-domain run":
        ss.TDS.config.tf = 0.1
        ss.TDS.run()
    target = write_raw(ss, tmp_path / "out.raw")

    back = andes.load(str(target), setup=True, no_output=True, default_config=True)
    assert (back.PQ.n, back.PV.n, back.Slack.n) == (reference.PQ.n, reference.PV.n, 1)
    assert float(sum(back.PQ.p0.v)) == pytest.approx(float(sum(reference.PQ.p0.v)), abs=1e-6)
    back.PFlow.run()
    assert back.PFlow.converged
    solved = dict(zip(back.Bus.idx.v, back.Bus.v.v, strict=True))
    assert solved.keys() == expected.keys()
    for idx, voltage in expected.items():
        assert float(solved[idx]) == pytest.approx(float(voltage), abs=1e-3), idx
