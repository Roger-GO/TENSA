"""For a test that runs the ``tensa`` command line and reads what it wrote.

Typer writes ``--help`` and its usage errors through Rich, which fits them to the
terminal it finds: the lines are wrapped at its width inside a box, so a sentence
or a path falls on two lines with a border between them, and with colour on, an
option name is cut in two by the codes around its dashes. A test that looks for
words in that output then passes or fails by where it runs: a CI runner asks for
colour, and a temporary path is longer on one system than on another.

``cli_runner`` gives the runner every such test uses, for which the terminal has
no colour, takes no codes at all (``TERM=dumb``) and is wide enough that nothing
is wrapped. ``tests/unit/test_cli_output.py`` holds the suite to it, and holds the
command itself to writing plain text to anything that is not a terminal.
"""

from __future__ import annotations

from typer.testing import CliRunner

# Wider than a usage error that names the longest temporary path twice.
WIDE = 1000

# The environment of a run: what makes the output plain, and without what a
# shell or a CI runner sets to have it styled.
PLAIN_TERMINAL: dict[str, str | None] = {
    "NO_COLOR": "1",
    "TERM": "dumb",
    "COLUMNS": str(WIDE),
    "FORCE_COLOR": None,
    "PY_COLORS": None,
    "TTY_COMPATIBLE": None,
}


def cli_runner(**environment: str | None) -> CliRunner:
    """A runner for ``tensa.cli.app`` on a plain, wide terminal.

    ``environment`` sets a variable of the run, or with ``None`` takes it out,
    over those of ``PLAIN_TERMINAL``: the tests of the styling itself ask for the
    terminal of a CI runner that way.
    """
    return CliRunner(env={**PLAIN_TERMINAL, **environment})
