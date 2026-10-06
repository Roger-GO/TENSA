"""``configure_logging``: level, plain or JSON lines, and the rotating log file.

Every test leaves the root logger as it found it (``_clean_root``), because the
handlers sit on the one logger pytest's own capture also uses.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tensa.core import logging_setup
from tensa.core.logging_setup import (
    JsonFormatter,
    configure_logging,
    log_dir,
    reset_logging,
    resolve_log_file,
)

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _clean_root() -> Iterator[None]:
    root = logging.getLogger()
    level = root.level
    yield
    reset_logging()
    root.setLevel(level)


def _ours() -> list[logging.Handler]:
    return [h for h in logging.getLogger().handlers if getattr(h, "_tensa_logging_handler", False)]


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "home"
    monkeypatch.setenv("HOME", str(directory))
    monkeypatch.setenv("USERPROFILE", str(directory))
    return directory


# ---- where --log-file writes ----------------------------------------------------


def test_the_log_directory_is_under_the_tensa_directory_of_the_home(home: Path) -> None:
    assert log_dir() == home / ".tensa" / "logs"


def test_a_bare_name_is_written_in_the_log_directory(home: Path) -> None:
    assert resolve_log_file("tensa.log") == home / ".tensa" / "logs" / "tensa.log"


@pytest.mark.parametrize(
    "value",
    [
        os.path.join(".", "tensa.log"),
        os.path.join("logs", "tensa.log"),
        os.path.join("..", "tensa.log"),
    ],
)
def test_a_path_with_a_directory_part_is_taken_from_the_current_directory(
    home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.chdir(tmp_path)
    assert resolve_log_file(value) == (tmp_path / value).absolute()
    assert log_dir() not in resolve_log_file(value).parents


def test_an_absolute_path_is_used_as_it_is(tmp_path: Path) -> None:
    target = tmp_path / "somewhere" / "tensa.log"
    assert resolve_log_file(str(target)) == target


def test_a_path_starting_with_a_tilde_is_expanded(home: Path) -> None:
    assert resolve_log_file(os.path.join("~", "x", "tensa.log")) == home / "x" / "tensa.log"


# ---- the JSON format ------------------------------------------------------------


def _record(message: str, *args: object, exc_info: Any = None) -> logging.LogRecord:
    return logging.LogRecord("tensa.test", logging.WARNING, __file__, 1, message, args, exc_info)


def test_a_json_line_has_the_time_level_logger_and_message() -> None:
    line = JsonFormatter().format(_record("loaded %s in %.1f s", "ieee14", 1.5))
    entry = json.loads(line)
    assert entry.keys() == {"time", "level", "logger", "message"}
    assert entry["level"] == "WARNING"
    assert entry["logger"] == "tensa.test"
    assert entry["message"] == "loaded ieee14 in 1.5 s"
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", entry["time"])


def test_a_json_line_is_one_line_whatever_the_message() -> None:
    line = JsonFormatter().format(_record("first\nsecond\r\nthird\t\u00e9 \u4e2d"))
    assert "\n" not in line
    assert line.isascii()
    assert json.loads(line)["message"] == "first\nsecond\r\nthird\t\u00e9 \u4e2d"


def test_a_traceback_is_a_field_of_the_line() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        record = _record("it failed", exc_info=sys.exc_info())
    line = JsonFormatter().format(record)
    assert "\n" not in line
    entry = json.loads(line)
    assert entry["exception"].startswith("Traceback (most recent call last):")
    assert entry["exception"].endswith("ValueError: boom")


# ---- configure_logging ------------------------------------------------------------


def test_text_lines_go_to_stderr_in_the_default_format(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(level="INFO")
    logging.getLogger("tensa.test").info("hello %s", "there")
    err = capsys.readouterr().err
    assert re.fullmatch(
        r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} \[INFO\] tensa\.test: hello there\n", err
    )


def test_json_lines_go_to_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(level="INFO", json_lines=True)
    logging.getLogger("tensa.test").info("hello")
    (line,) = capsys.readouterr().err.splitlines()
    assert json.loads(line)["message"] == "hello"


@pytest.mark.parametrize(
    ("level", "shown"),
    [
        ("DEBUG", ["debug", "info", "warning", "error"]),
        ("INFO", ["info", "warning", "error"]),
        ("WARNING", ["warning", "error"]),
        ("ERROR", ["error"]),
        ("CRITICAL", []),
    ],
)
def test_the_level_is_the_threshold(
    capsys: pytest.CaptureFixture[str], level: str, shown: list[str]
) -> None:
    configure_logging(level=level, json_lines=True)
    log = logging.getLogger("tensa.test")
    for name in ("debug", "info", "warning", "error"):
        getattr(log, name)(name)
    messages = [json.loads(line)["message"] for line in capsys.readouterr().err.splitlines()]
    assert messages == shown


def test_the_file_gets_what_stderr_gets(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    target = tmp_path / "tensa.log"
    configure_logging(level="INFO", log_file=target)
    logging.getLogger("tensa.test").warning("to both")
    assert capsys.readouterr().err.endswith("[WARNING] tensa.test: to both\n")
    (line,) = _lines(target)
    assert line.endswith("[WARNING] tensa.test: to both")


def test_the_file_takes_the_json_format_too(tmp_path: Path) -> None:
    target = tmp_path / "tensa.log"
    configure_logging(level="INFO", json_lines=True, log_file=target)
    logging.getLogger("tensa.test").info("hello")
    (line,) = _lines(target)
    assert json.loads(line)["message"] == "hello"


def test_the_file_is_created_with_its_directories(tmp_path: Path) -> None:
    target = tmp_path / "a" / "b" / "tensa.log"
    configure_logging(log_file=target)
    assert target.is_file()


def test_the_file_is_appended_to_across_runs(tmp_path: Path) -> None:
    target = tmp_path / "tensa.log"
    for run in ("first", "second"):
        configure_logging(log_file=target)
        logging.getLogger("tensa.test").info(run)
        reset_logging()
    first, second = _lines(target)
    assert first.endswith("first")
    assert second.endswith("second")


def test_a_second_call_replaces_the_handlers_instead_of_adding_to_them(tmp_path: Path) -> None:
    configure_logging(log_file=tmp_path / "one.log")
    configure_logging(log_file=tmp_path / "two.log")
    assert len(_ours()) == 2  # stderr and the second file
    logging.getLogger("tensa.test").info("once")
    assert not _lines(tmp_path / "one.log")
    assert len(_lines(tmp_path / "two.log")) == 1


def test_reset_takes_the_handlers_off_and_leaves_the_others(tmp_path: Path) -> None:
    root = logging.getLogger()
    foreign = logging.NullHandler()
    root.addHandler(foreign)
    try:
        configure_logging(log_file=tmp_path / "tensa.log")
        assert _ours()
        reset_logging()
        assert not _ours()
        assert foreign in root.handlers
    finally:
        root.removeHandler(foreign)


def test_a_file_that_cannot_be_opened_raises_and_changes_nothing(tmp_path: Path) -> None:
    blocker = tmp_path / "plain-file"
    blocker.write_text("not a directory", encoding="utf-8")
    configure_logging(level="ERROR")
    before = list(logging.getLogger().handlers)
    with pytest.raises(OSError):
        configure_logging(level="DEBUG", log_file=blocker / "tensa.log")
    assert logging.getLogger().handlers == before
    assert logging.getLogger().level == logging.ERROR


def test_the_stream_follows_a_swapped_stderr(monkeypatch: pytest.MonkeyPatch) -> None:
    """The handler is built once and must not keep writing to a stderr that has been
    replaced since (a test's capture, closed when the test ends)."""
    configure_logging()
    replacement = io.StringIO()
    monkeypatch.setattr(sys, "stderr", replacement)
    logging.getLogger("tensa.test").info("seen")
    assert "seen" in replacement.getvalue()


def test_the_log_rotates_and_keeps_a_few_old_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(logging_setup, "MAX_LOG_BYTES", 300)
    target = tmp_path / "tensa.log"
    configure_logging(log_file=target)
    log = logging.getLogger("tensa.test")
    for i in range(200):
        log.info("line %03d with a little padding to fill the file", i)
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == ["tensa.log", "tensa.log.1", "tensa.log.2", "tensa.log.3"]
    assert all(p.stat().st_size <= 400 for p in tmp_path.iterdir())
    # The newest lines are in the live file, the oldest are gone.
    assert _lines(target)[-1].endswith("line 199 with a little padding to fill the file")
    assert not any("line 000" in p.read_text(encoding="utf-8") for p in tmp_path.iterdir())
