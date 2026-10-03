"""Unit tests for the portable file-name validator (``tensa.security.names``)."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from tensa.security.names import is_windows_reserved_name, portable_name_problem

_DEVICE_NAMES = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{n}" for n in range(1, 10)),
    *(f"LPT{n}" for n in range(1, 10)),
]


@pytest.mark.unit
@pytest.mark.parametrize("device", _DEVICE_NAMES)
@pytest.mark.parametrize(
    "shape",
    [
        "{}",  # bare
        "{}.raw",  # any extension
        "{}.tar.gz",  # only the part before the FIRST dot counts
        "{}.",  # trailing dot (also rejected on its own)
        "{} .raw",  # trailing space before the dot is ignored by Windows
    ],
)
@pytest.mark.parametrize("case", [str.upper, str.lower, str.title])
def test_reserved_device_names_are_reserved_in_any_case_and_extension(
    device: str, shape: str, case: Callable[[str], str]
) -> None:
    name = shape.format(case(device))
    assert is_windows_reserved_name(name), name
    assert portable_name_problem(name) is not None, name


@pytest.mark.unit
@pytest.mark.parametrize("name", ["COM¹", "com².txt", "LPT³", "CONIN$", "conout$.log", "COM0", "lpt0"])
def test_extended_reserved_names(name: str) -> None:
    assert is_windows_reserved_name(name)
    assert portable_name_problem(name) is not None


@pytest.mark.unit
@pytest.mark.parametrize(
    "name",
    [
        "ieee14.raw",
        "ieee14.dyr",
        "Kundur two-area (v2).xlsx",
        "console.raw",  # device name is only a prefix
        "nullable.json",
        "com10.raw",  # COM10 is not reserved
        "lpt1x.raw",
        "aux_1.raw",
        "my.con.raw",  # CON is not the part before the first dot
        "scenario-A",
        "a.b.c",
        "x" * 64,
        "naïve-case.raw",
    ],
)
def test_ordinary_names_are_accepted(name: str) -> None:
    assert portable_name_problem(name) is None


@pytest.mark.unit
@pytest.mark.parametrize(
    ("name", "fragment"),
    [
        ("", "empty"),
        ("C:evil.raw", "':'"),  # drive-relative
        ("case.raw:stream", "':'"),  # NTFS alternate data stream
        ("ieee14.raw.", "ends with a dot or space"),
        ("ieee14.raw ", "ends with a dot or space"),
        ("..", "ends with a dot or space"),
        (".", "ends with a dot or space"),
        ("a/b", "'/'"),
        ("a\\b", "'\\\\'"),
        ('a"b', "'\"'"),
        ("a<b", "'<'"),
        ("a>b", "'>'"),
        ("a|b", "'|'"),
        ("a?b", "'?'"),
        ("a*b", "'*'"),
        ("a\x00b", "control"),
        ("a\nb", "control"),
        ("snap\n", "control"),
        ("tab\there", "control"),
        ("CON", "reserved"),
        ("nul.txt", "reserved"),
    ],
)
def test_unportable_names_are_rejected_with_a_reason(name: str, fragment: str) -> None:
    problem = portable_name_problem(name)
    assert problem is not None, name
    assert fragment in problem
