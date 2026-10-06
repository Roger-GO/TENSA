"""Unit tests for the worker-side hygiene helpers in ``tensa.core.worker``:
the path test behind the ``sys.audit`` hook, SIGINT handling and ``faulthandler``.
"""

from __future__ import annotations

import faulthandler
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

from tensa.core import worker

# ---- the open() audit hook's path test --------------------------------------


def _root(path: Path) -> str:
    return worker._normalized_path(str(path))


def _verdict(
    path: Any, workspace: Path, interpreter_roots: tuple[str, ...] = ()
) -> str | None:
    return worker._out_of_workspace_open(path, _root(workspace), interpreter_roots)


@pytest.fixture
def layout(tmp_path: Path) -> dict[str, Path]:
    """``cases`` is the workspace; ``cases2`` shares its name as a prefix."""
    dirs = {name: tmp_path / name for name in ("cases", "cases2", "venv", "venv2", "other")}
    for path in dirs.values():
        path.mkdir()
    return dirs


def test_a_file_inside_the_workspace_is_fine(layout: dict[str, Path]) -> None:
    assert _verdict(layout["cases"] / "ieee14.raw", layout["cases"]) is None
    assert _verdict(layout["cases"] / "deep" / "er" / "x.dat", layout["cases"]) is None
    assert _verdict(layout["cases"], layout["cases"]) is None


def test_a_sibling_that_shares_the_workspace_name_as_a_prefix_is_outside(
    layout: dict[str, Path],
) -> None:
    """``startswith`` called ``cases2`` part of ``cases``."""
    target = layout["cases2"] / "secret.dat"
    assert _verdict(target, layout["cases"]) == os.path.realpath(target)


def test_dot_dot_out_of_the_workspace_is_outside(layout: dict[str, Path]) -> None:
    target = layout["cases"] / ".." / "other" / "x.dat"
    assert _verdict(target, layout["cases"]) == os.path.realpath(target)


@pytest.mark.skipif(sys.platform == "win32", reason="creating symlinks needs privileges there")
def test_a_symlink_that_leaves_the_workspace_is_outside(layout: dict[str, Path]) -> None:
    secret = layout["other"] / "secret.dat"
    secret.write_text("x", encoding="utf-8")
    link = layout["cases"] / "innocent.dat"
    link.symlink_to(secret)
    assert _verdict(link, layout["cases"]) == os.path.realpath(secret)


def test_case_differences_do_not_matter_where_the_platform_ignores_case(
    layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(os.path, "normcase", str.lower)
    opened = Path(str(layout["cases"] / "X.RAW").upper())
    assert _verdict(opened, layout["cases"]) is None


def test_is_within_compares_whole_components_of_normalized_paths(
    layout: dict[str, Path],
) -> None:
    root = _root(layout["cases"])
    assert worker._is_within(_root(layout["cases"] / "x"), root) is True
    assert worker._is_within(_root(layout["cases2"]), root) is False
    assert worker._is_within(root, root) is True
    assert worker._is_within(_root(layout["other"]), _root(Path(layout["other"].anchor))) is True
    assert worker._is_within("relative/x", root) is False


@pytest.mark.skipif(sys.platform != "win32", reason="drive letters exist only on Windows")
def test_a_path_on_another_drive_is_not_inside(layout: dict[str, Path]) -> None:
    here = _root(layout["cases"])
    other_drive = "z:" if not here.lower().startswith("z:") else "y:"
    assert worker._is_within(other_drive + "\\cases\\x", here) is False


def test_the_interpreters_own_tree_is_fine_but_not_its_neighbours(
    layout: dict[str, Path],
) -> None:
    roots = (_root(layout["venv"]),)
    assert _verdict(layout["venv"] / "lib" / "andes" / "data.json", layout["cases"], roots) is None
    target = layout["venv2"] / "data.json"
    assert _verdict(target, layout["cases"], roots) == os.path.realpath(target)


def test_python_code_is_never_worth_a_warning(layout: dict[str, Path]) -> None:
    for name in ("mod.py", "mod.pyc", "ext.so", "ext.pyd", "x.pth"):
        assert _verdict(layout["other"] / name, layout["cases"]) is None
    assert _verdict(layout["other"] / "mod.json", layout["cases"]) is not None


def test_an_fd_or_a_non_path_is_ignored(layout: dict[str, Path]) -> None:
    assert _verdict(3, layout["cases"]) is None
    assert _verdict(None, layout["cases"]) is None
    assert _verdict(1.5, layout["cases"]) is None


def test_a_bytes_path_is_checked_like_a_str_path(layout: dict[str, Path]) -> None:
    target = layout["other"] / "x.dat"
    assert _verdict(os.fsencode(target), layout["cases"]) == os.path.realpath(target)
    assert _verdict(os.fsencode(layout["cases"] / "x.dat"), layout["cases"]) is None


def test_a_path_that_cannot_be_resolved_is_ignored(layout: dict[str, Path]) -> None:
    assert _verdict("bad\0path", layout["cases"]) is None
    assert _verdict(b"bad\0path", layout["cases"]) is None
    assert _verdict(layout["other"] / "bad\0path", layout["cases"]) is None


def test_a_nul_is_refused_before_resolving_the_path(
    layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows' ``realpath`` keeps an embedded NUL where POSIX raises, so the
    check cannot rely on the platform to reject it."""

    def keep_the_nul(path: str) -> str:
        return path

    monkeypatch.setattr(os.path, "realpath", keep_the_nul)
    assert _verdict("bad\0path", layout["cases"]) is None
    assert _verdict(layout["other"] / "ok.dat", layout["cases"]) is not None


def test_the_interpreter_roots_cover_this_interpreter() -> None:
    import sysconfig

    roots = worker._interpreter_roots()
    prefix = worker._normalized_path(sys.prefix)
    assert any(worker._is_within(prefix, root) for root in roots)
    purelib = worker._normalized_path(sysconfig.get_paths()["purelib"])
    assert any(worker._is_within(purelib, root) for root in roots)
    assert roots == tuple(sorted(set(roots)))


def test_a_filesystem_root_is_never_a_trusted_root(monkeypatch: pytest.MonkeyPatch) -> None:
    anchor = Path(sys.prefix).anchor
    monkeypatch.setattr(sys, "prefix", anchor)
    monkeypatch.setattr(sys, "exec_prefix", anchor)
    monkeypatch.setattr(sys, "base_prefix", anchor)
    monkeypatch.setattr(sys, "base_exec_prefix", anchor)
    roots = worker._interpreter_roots()
    assert worker._normalized_path(anchor) not in roots
    assert all(os.path.dirname(r) != r for r in roots)


def test_the_installed_hook_logs_only_opens_outside_the_workspace(
    layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Wire the real installer to a captured hook (a real one cannot be removed)."""
    hooks: list[Any] = []
    monkeypatch.setattr(sys, "addaudithook", hooks.append)
    caplog.set_level("WARNING", logger="tensa.worker.audit")

    worker._install_strict_fs_audit_hook(None)
    assert hooks == []

    worker._install_strict_fs_audit_hook(str(layout["cases"]))
    assert len(hooks) == 1
    hook = hooks[0]

    hook("open", (str(layout["cases"] / "ieee14.raw"), "r", 0))
    hook("open", (str(layout["cases2"] / "stolen.dat"), "r", 0))
    hook("socket.connect", (str(layout["cases2"] / "ignored.dat"),))
    hook("open", ())

    messages = [r.getMessage() for r in caplog.records]
    assert len(messages) == 1
    assert "stolen.dat" in messages[0]


# ---- SIGINT -----------------------------------------------------------------


@pytest.fixture
def restore_sigint() -> Any:
    previous = signal.getsignal(signal.SIGINT)
    yield
    signal.signal(signal.SIGINT, previous)


def test_ctrl_c_is_ignored(restore_sigint: None) -> None:
    signal.signal(signal.SIGINT, signal.default_int_handler)
    worker._ignore_sigint()
    assert signal.getsignal(signal.SIGINT) == signal.SIG_IGN


def test_ignoring_ctrl_c_off_the_main_thread_is_harmless(restore_sigint: None) -> None:
    """``signal.signal`` raises ``ValueError`` outside the main thread."""
    errors: list[BaseException] = []

    def run() -> None:
        try:
            worker._ignore_sigint()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    thread = threading.Thread(target=run)
    thread.start()
    thread.join()
    assert errors == []


# ---- faulthandler -----------------------------------------------------------


@pytest.fixture
def fault_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Stand-ins for ``faulthandler``, so no test changes what the interpreter's
    crash handler does. Starts as if none were installed."""
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(faulthandler, "is_enabled", lambda: False)
    monkeypatch.setattr(faulthandler, "enable", lambda **kw: calls.append(kw))
    return calls


def test_the_worker_asks_for_the_stacks_of_every_thread(
    fault_calls: list[dict[str, Any]],
) -> None:
    worker._enable_faulthandler()
    assert fault_calls == [{"all_threads": True}]


def test_a_handler_that_is_already_installed_is_left_alone(
    fault_calls: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """pytest installs its own, and a test may run the worker in its process."""
    monkeypatch.setattr(faulthandler, "is_enabled", lambda: True)
    worker._enable_faulthandler()
    assert fault_calls == []


@pytest.mark.parametrize(
    "error",
    [RuntimeError("sys.stderr is None"), ValueError("closed"), OSError("no fileno")],
)
def test_a_worker_with_no_usable_stderr_runs_without_it(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    def refuse(**kwargs: Any) -> None:
        raise error

    monkeypatch.setattr(faulthandler, "is_enabled", lambda: False)
    monkeypatch.setattr(faulthandler, "enable", refuse)
    worker._enable_faulthandler()  # does not raise


@pytest.mark.skipif(sys.platform == "win32", reason="os.kill cannot deliver SIGSEGV on Windows")
def test_a_native_crash_prints_the_python_stack() -> None:
    """A real process killed the way a crashing C extension dies: without the
    handler the interpreter says nothing at all."""
    code = (
        "import os, signal\n"
        "from tensa.core import worker\n"
        "worker._enable_faulthandler()\n"
        "os.kill(os.getpid(), signal.SIGSEGV)\n"
    )
    env = {k: v for k, v in os.environ.items() if k != "PYTHONFAULTHANDLER"}
    proc = subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert proc.returncode == -signal.SIGSEGV
    assert "Fatal Python error: Segmentation fault" in proc.stderr
    assert "most recent call first" in proc.stderr
