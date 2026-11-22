"""Tests of ``scripts/junit_annotations.py``, which writes the failed tests of a
CI job's JUnit reports as annotations (readable without signing in)."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import pytest

from tests._repo import SCRIPTS_DIR, load_module

pytestmark = pytest.mark.unit

_REPORT = """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="3" failures="1" errors="1">
<testcase classname="tests.unit.test_a" name="test_passes" time="0.1"/>
<testcase classname="tests.unit.test_a" name="test_fails" time="0.1">
<failure message="AssertionError: assert 1 == 2">def test_fails():
&gt;       assert 1 == 2
E       assert 1 == 2

tests/unit/test_a.py:5: AssertionError</failure>
<system-err>a line on stderr</system-err>
</testcase>
<testcase classname="tests.unit.test_b" name="test_errs[a,b: c]" time="0.1">
<error message="failed on setup">fixture 'nope' not found</error>
</testcase>
</testsuite></testsuites>
"""


def _script() -> ModuleType:
    return load_module("junit_annotations", SCRIPTS_DIR / "junit_annotations.py")


def test_each_failed_or_erroring_test_is_one_error_annotation(tmp_path: Path) -> None:
    report = tmp_path / "junit-unit.xml"
    report.write_text(_REPORT, encoding="utf-8")
    lines = _script().annotations([report])
    assert len(lines) == 2
    failed, errored = lines
    assert failed.startswith("::error title=tests.unit.test_a.test_fails::")
    assert "AssertionError: assert 1 == 2%0A%0AE       assert 1 == 2" in failed
    assert "stderr:%0Aa line on stderr" in failed
    # A comma and a colon in a title are escaped, so the title is not cut there.
    assert errored.startswith("::error title=tests.unit.test_b.test_errs[a%2Cb%3A c]::")
    assert "failed on setup" in errored


def test_a_missing_report_is_named(tmp_path: Path) -> None:
    assert _script().annotations([tmp_path / "junit-full.xml"]) == [
        "::error title=pytest::no report at junit-full.xml"
    ]


def test_past_ten_failures_the_rest_are_listed_in_one_more(tmp_path: Path) -> None:
    cases = "".join(
        f'<testcase classname="t" name="test_{i}"><failure message="m{i}">x</failure></testcase>'
        for i in range(13)
    )
    report = tmp_path / "junit.xml"
    report.write_text(f"<testsuites><testsuite>{cases}</testsuite></testsuites>", encoding="utf-8")
    lines = _script().annotations([report])
    assert len(lines) == 11
    assert lines[-1].startswith("::error title=3 more failed tests::")
    assert "t.test_10%0At.test_11%0At.test_12" in lines[-1]


def test_a_long_text_is_cut(tmp_path: Path) -> None:
    script = _script()
    line = script.annotation("error", "t", "x" * 5000)
    assert line.endswith("x%0A...")
    assert len(line) < script.LIMIT + 40
