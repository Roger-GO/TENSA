"""The helpers of ``tests/_crash.py``: a process that a test kills with SIGSEGV
on purpose is given a core size limit the kernel writes no dump for, so the suite
leaves no crash report on the machine that runs it.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from tests._crash import NO_CORE_DUMP_CODE, without_core_dump

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Windows has no core size limit and no SIGSEGV to send"
)

# One byte on Linux, where that is the limit the kernel pipes no dump at; none elsewhere.
EXPECTED = 1 if sys.platform == "linux" else 0


# Lines that raise the soft limit of a child as far as its hard limit allows, so
# that what lowers it afterwards is seen to have done so.
UNLIMITED_CODE = (
    "import resource\n"
    "_hard = resource.getrlimit(resource.RLIMIT_CORE)[1]\n"
    "resource.setrlimit(resource.RLIMIT_CORE, (_hard, _hard))\n"
)


def test_the_lines_for_a_child_set_its_core_limit() -> None:
    code = (
        f"{UNLIMITED_CODE}{NO_CORE_DUMP_CODE}"
        "print(resource.getrlimit(resource.RLIMIT_CORE)[0])\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=60, check=True
    )
    # With a hard limit of zero nothing can be set, and nothing is dumped anyway.
    assert proc.stdout.strip() in {str(EXPECTED), "0"}


@pytest.mark.skipif(sys.platform != "linux", reason="only Linux sets the limit of another process")
def test_the_limit_of_a_running_process_is_set_from_outside() -> None:
    import resource

    # The child says when its limit is raised, and stays until its stdin closes.
    code = f"{UNLIMITED_CODE}import sys\nprint('ready', flush=True)\nsys.stdin.read()\n"
    proc = subprocess.Popen(
        [sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
    )
    try:
        assert proc.stdout is not None
        assert proc.stdout.readline().strip() == "ready"
        soft, hard = resource.prlimit(proc.pid, resource.RLIMIT_CORE)
        assert soft == hard
        if hard == 0:
            pytest.skip("the hard core limit here is zero: there is nothing to lower")
        without_core_dump(proc.pid)
        assert resource.prlimit(proc.pid, resource.RLIMIT_CORE) == (1, hard)
    finally:
        proc.communicate("", timeout=60)


def test_a_process_that_is_gone_is_left_alone() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait(timeout=60)
    # No such process any more: nothing to set, and nothing raised.
    without_core_dump(proc.pid)


def test_a_child_killed_by_sigsegv_after_them_leaves_no_core_file(tmp_path: Path) -> None:
    """Where the kernel writes core files beside the process (``core_pattern`` is a
    file name), none is written; where it pipes them to a crash reporter, the
    reporter is not started, which cannot be seen from here."""
    code = (
        f"{UNLIMITED_CODE}{NO_CORE_DUMP_CODE}"
        "import os, signal\n"
        "os.kill(os.getpid(), signal.SIGSEGV)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, timeout=60, check=False
    )
    assert proc.returncode == -signal.SIGSEGV
    assert os.listdir(tmp_path) == []
