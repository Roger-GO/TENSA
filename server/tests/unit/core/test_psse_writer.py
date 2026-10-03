"""Unit tests for the PSS/E ``.raw`` writer's text encoding.

``write_raw`` used to call ``Path.write_text`` with no ``encoding`` or
``newline``, so the file's bytes depended on the platform: cp1252 with CRLF
line endings on Windows (and a ``UnicodeEncodeError`` for a bus name outside
cp1252), UTF-8 with LF elsewhere. The writer now pins UTF-8 and LF.
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


def test_write_raw_non_ascii_bus_name_round_trips_through_andes(tmp_path: Path) -> None:
    """ANDES sniffs the encoding with chardet; the UTF-8 file must read back
    with the name intact."""
    import andes

    target = tmp_path / "out.raw"
    write_raw(_load_ieee14(_NON_ASCII_NAME), target)

    ss = andes.load(str(target), setup=True, no_output=True, default_config=True)
    assert ss.Bus.name.v[0].strip() == _NON_ASCII_NAME
