"""Ending a process the way a native crash does, without leaving a crash report.

Two tests send SIGSEGV to a real process, to see that the worker's ``faulthandler``
prints the Python stack of a process that dies in native code. Nothing else shows
that: a signal the handler does not catch (SIGKILL) ends the process without a word.

A process that dies of SIGSEGV dumps core, and a desktop Linux pipes the dump to a
crash reporter (apport on Ubuntu, ``systemd-coredump`` elsewhere), which files a
report of a crash that never happened: one more file in ``/var/crash`` for every
run of the suite. The kernel dumps nothing for a process whose core size limit is
one byte: that value is how it marks a process whose dump must not be piped, and a
core file of one byte is smaller than any it writes. The process still dies of the
signal, with the handler's output on its stderr, so the tests see what they look
for.

Elsewhere the limit is set to zero, which is what keeps macOS from writing a core
file. Windows has no such limit, and neither test runs there.
"""

from __future__ import annotations

import contextlib
import sys

# The soft limit to give ``RLIMIT_CORE``: see the module docstring.
_NO_DUMP = 1 if sys.platform == "linux" else 0

# Lines for the code of a ``python -c`` child that is about to kill itself: after
# them the kernel writes no core dump for it.
NO_CORE_DUMP_CODE = (
    "try:\n"
    "    import resource\n"
    "    _hard = resource.getrlimit(resource.RLIMIT_CORE)[1]\n"
    f"    resource.setrlimit(resource.RLIMIT_CORE, ({_NO_DUMP}, _hard))\n"
    "except (ImportError, ValueError, OSError):\n"
    "    pass\n"
)


def without_core_dump(pid: int) -> None:
    """Have the kernel write no core dump when the process ``pid`` dies of a signal.

    For a process that is already running and whose code the test does not write (a
    session's worker). Linux only: nowhere else can the limit of another process be
    set, and there the process is left as it is. Best effort as well where the limit
    cannot be changed (a hard limit of zero, a process of another user).
    """
    try:
        import resource
    except ImportError:  # Windows
        return
    prlimit = getattr(resource, "prlimit", None)
    if prlimit is None:
        return
    with contextlib.suppress(ValueError, OSError):
        _soft, hard = prlimit(pid, resource.RLIMIT_CORE)
        prlimit(pid, resource.RLIMIT_CORE, (_NO_DUMP, hard))
