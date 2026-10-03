"""The source uses the current names of the HTTP status codes Starlette renamed.

Starlette 1.x answers a read of ``status.HTTP_422_UNPROCESSABLE_ENTITY`` (or any
of the other renamed constants) with a ``StarletteDeprecationWarning``, which
Python shows by default, so every ``tensa`` command printed it on start-up. The
numeric codes did not change, and the new names exist at the Starlette floor. A
later release is free to drop the old names, so this scans the package rather
than waiting for an import to fail.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette import status

import tensa

pytestmark = pytest.mark.unit

_RENAMED = {
    "HTTP_413_REQUEST_ENTITY_TOO_LARGE",
    "HTTP_414_REQUEST_URI_TOO_LONG",
    "HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE",
    "HTTP_422_UNPROCESSABLE_ENTITY",
}


def test_source_uses_no_renamed_status_constant() -> None:
    # Starlette keeps its own list of the names it deprecates; adding it means a
    # name retired by a later release is caught the same way.
    renamed = _RENAMED | set(getattr(status, "__deprecated__", {}))
    package = Path(tensa.__file__).resolve().parent
    offenders = [
        f"{path.relative_to(package).as_posix()}:{number}: {name}"
        for path in sorted(package.rglob("*.py"))
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        for name in sorted(renamed)
        if name in line
    ]
    assert not offenders, "renamed Starlette status constants in use:\n" + "\n".join(offenders)
