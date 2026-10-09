"""What ``tensa`` writes is styled on a terminal and plain text everywhere else.

Typer styles ``--help`` and its usage errors with Rich, and takes ``GITHUB_ACTIONS``,
``FORCE_COLOR`` or ``PY_COLORS`` in the environment as a reason to do so whatever the
output goes to. A CI runner sets the first, so the help read there, by a test or by
a script, was full of escape codes, with ``--log-file`` cut in two by the codes
around its dashes. The command now lets the stream decide (``_style_only_on_a_terminal``
in ``cli.py``); the first section holds it to that.

The second section is about the tests themselves: one that reads the command's
output takes its runner from ``tests/_cli.py``, where the terminal is plain and
wide, so that what it finds does not depend on the terminal of the machine.
"""

from __future__ import annotations

import os
import select
import subprocess
import sys
import time
from pathlib import Path

import pytest
from typer import rich_utils

from tensa import cli
from tests._cli import WIDE, cli_runner

pytestmark = pytest.mark.unit

ESCAPE = "\x1b"

# What a shell or a CI runner sets to have every program write colour, with a
# terminal that could show it and as narrow as a pipe is taken to be.
STYLING_ASKED_FOR: dict[str, str | None] = {
    "FORCE_COLOR": "1",
    "PY_COLORS": "1",
    "GITHUB_ACTIONS": "true",
    "TERM": "xterm-256color",
    "COLUMNS": "80",
    "NO_COLOR": None,
}


def _one_line(text: str) -> str:
    """``text`` as single-spaced words, whatever the width it was wrapped at."""
    return " ".join(text.split())


# ------------------------------------------------- the command off a terminal


@pytest.fixture
def typer_forces_styling(monkeypatch: pytest.MonkeyPatch) -> None:
    """Typer reads the environment once, when it is first asked for help, so in a
    process that began on a CI runner this is set for good."""
    monkeypatch.setattr(rich_utils, "FORCE_TERMINAL", True)


@pytest.mark.parametrize(
    ("arguments", "said"),
    [
        (["--help"], "--version"),
        (["serve", "--help"], "--log-file"),
        (["desktop", "--help"], "--system-site-packages"),
        (["mcp", "--help"], "--workspace"),
        (["warm-cache", "--help"], "--incremental"),
    ],
    ids=lambda value: " ".join(value) if isinstance(value, list) else None,
)
@pytest.mark.usefixtures("typer_forces_styling")
def test_help_that_is_not_read_on_a_terminal_is_plain_text(arguments: list[str], said: str) -> None:
    result = cli_runner(**STYLING_ASKED_FOR).invoke(cli.app, arguments)
    assert result.exit_code == 0, result.output
    assert ESCAPE not in result.output
    # An option can be searched for and copied: no code stands inside its name.
    assert said in _one_line(result.output)


@pytest.mark.usefixtures("typer_forces_styling")
def test_a_usage_error_that_is_not_read_on_a_terminal_is_plain_text() -> None:
    result = cli_runner(**STYLING_ASKED_FOR).invoke(cli.app, ["serve", "--no-such-option"])
    assert result.exit_code == 2
    assert ESCAPE not in result.output
    assert "No such option: --no-such-option" in _one_line(result.output)


def _environment(**changes: str | None) -> dict[str, str]:
    """This process's environment with ``changes`` made to it (``None`` takes a
    variable out), read and written as UTF-8 on every system."""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    for name, value in changes.items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
    return env


def test_the_installed_command_writes_plain_help_into_a_pipe() -> None:
    """The whole way, from the environment Typer reads as it is imported."""
    done = subprocess.run(
        [sys.executable, "-m", "tensa", "desktop", "--help"],
        env=_environment(**STYLING_ASKED_FOR),
        capture_output=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert ESCAPE not in done.stdout and ESCAPE not in done.stderr
    assert "--system-site-packages" in _one_line(done.stdout)


@pytest.mark.skipif(sys.platform == "win32", reason="no pseudo-terminal there")
def test_the_installed_command_still_styles_its_help_on_a_terminal() -> None:
    import pty

    reads, writes = pty.openpty()
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "tensa", "serve", "--help"],
            env=_environment(TERM="xterm-256color", NO_COLOR=None, FORCE_COLOR=None),
            stdin=subprocess.DEVNULL,
            stdout=writes,
            stderr=writes,
        )
    finally:
        os.close(writes)
    chunks: list[bytes] = []
    deadline = time.monotonic() + 120
    try:
        # Until the command has gone, and no longer than a command that hangs.
        while select.select([reads], [], [], max(0.0, deadline - time.monotonic()))[0]:
            try:
                chunk = os.read(reads, 4096)
            except OSError:  # Linux says so when the other end has gone
                break
            if not chunk:
                break
            chunks.append(chunk)
        assert proc.wait(timeout=30) == 0
    finally:
        os.close(reads)
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    assert ESCAPE + "[" in b"".join(chunks).decode("utf-8", errors="replace")


class _Stream:
    def __init__(self, terminal: bool, *, closed: bool = False) -> None:
        self._terminal = terminal
        self._closed = closed

    def isatty(self) -> bool:
        if self._closed:
            raise ValueError("I/O operation on closed file")
        return self._terminal


@pytest.mark.parametrize(
    ("stdout", "stderr", "expected"),
    [
        # Rich finds out what the terminal takes; nothing is forced on it.
        (_Stream(True), _Stream(True), None),
        # ``tensa serve --help | less`` and ``tensa serve --oops 2> errors.txt``.
        (_Stream(False), _Stream(True), False),
        (_Stream(True), _Stream(False), False),
        (_Stream(False), _Stream(False), False),
        # A windowed program has no streams, and a closed one cannot be asked.
        (None, None, False),
        (_Stream(True, closed=True), _Stream(True), False),
    ],
    ids=["terminal", "piped", "errors-to-a-file", "both-piped", "no-streams", "closed"],
)
def test_the_streams_decide_and_the_environment_does_not(
    monkeypatch: pytest.MonkeyPatch,
    stdout: _Stream | None,
    stderr: _Stream | None,
    expected: bool | None,
) -> None:
    for name, value in STYLING_ASKED_FOR.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    monkeypatch.setattr(rich_utils, "FORCE_TERMINAL", True)
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    cli._style_only_on_a_terminal()
    assert rich_utils.FORCE_TERMINAL is expected


# ------------------------------------------------------ the tests' own runner


def test_the_shared_runner_wraps_nothing_and_styles_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("FORCE_COLOR", "PY_COLORS", "GITHUB_ACTIONS"):
        monkeypatch.setenv(name, "1")
    monkeypatch.setenv("COLUMNS", "40")
    # A sentence several times as long as a terminal is wide.
    words = " ".join(f"word{i}" for i in range(60))
    assert 80 < len(words) < WIDE / 2
    result = cli_runner().invoke(cli.app, ["serve", "--log-level", words])
    assert result.exit_code == 2
    assert ESCAPE not in result.output
    assert words in result.output


def test_every_test_takes_its_runner_from_the_shared_helper() -> None:
    """A runner made anywhere else has the terminal of whoever runs the suite."""
    tests_dir = Path(__file__).resolve().parents[1]
    own = {tests_dir / "_cli.py", Path(__file__).resolve()}
    strays = [
        path.relative_to(tests_dir).as_posix()
        for path in sorted(tests_dir.rglob("*.py"))
        if path not in own and "CliRunner" in path.read_text(encoding="utf-8")
    ]
    assert strays == []
