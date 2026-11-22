"""Write the failed tests of JUnit reports as GitHub error annotations.

    python scripts/junit_annotations.py <report.xml> [<report.xml> ...]

The log of a CI job cannot be read without signing in, but its annotations
can, so a step that runs after a failed test step calls this on the reports
pytest wrote (``--junitxml``). Each failed or erroring test case becomes one
``::error`` annotation titled with its name, holding the message, the lines
pytest marks with ``E`` (the assertion), the end of the traceback and the end
of what the test wrote to stderr. A report that is missing is named in an
annotation of its own. GitHub shows at most ten error annotations of a step,
so the first ten failures are written in full and the rest are counted in
one more line. The exit status is always 0: the test step has failed already.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

LIMIT = 1500
SHOWN = 10


def _data(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _prop(text: str) -> str:
    return _data(text).replace(":", "%3A").replace(",", "%2C")


def annotation(level: str, title: str, text: str) -> str:
    """One workflow command, the text cut to ``LIMIT`` characters."""
    if len(text) > LIMIT:
        text = text[: LIMIT - 4] + "\n..."
    return f"::{level} title={_prop(title)}::{_data(text)}"


def failure_text(element: ET.Element, case: ET.Element) -> str:
    """What an annotation of one failed test case says."""
    lines = (element.text or "").splitlines()
    marked = [line for line in lines if line.startswith("E ")]
    parts = [element.get("message") or element.tag]
    if marked:
        parts += ["", *marked[:12]]
    parts += ["", *lines[-8:]]
    stderr = case.find("system-err")
    if stderr is not None and (stderr.text or "").strip():
        parts += ["", "stderr:", *(stderr.text or "").strip().splitlines()[-6:]]
    return "\n".join(parts)


def annotations(paths: list[Path]) -> list[str]:
    """The annotations of the failed test cases of every report, in order."""
    out: list[str] = []
    failed: list[tuple[str, str]] = []
    for path in paths:
        if not path.is_file():
            out.append(annotation("error", "pytest", f"no report at {path.name}"))
            continue
        for case in ET.parse(path).iter("testcase"):
            test = f"{case.get('classname')}.{case.get('name')}"
            for tag in ("failure", "error"):
                for element in case.findall(tag):
                    failed.append((test, failure_text(element, case)))
    for test, text in failed[:SHOWN]:
        out.append(annotation("error", test, text))
    if len(failed) > SHOWN:
        rest = [test for test, _ in failed[SHOWN:]]
        out.append(
            annotation(
                "error",
                f"{len(rest)} more failed tests",
                "\n".join(rest[:40]),
            )
        )
    return out


def main(argv: list[str]) -> int:
    for line in annotations([Path(arg) for arg in argv]):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
