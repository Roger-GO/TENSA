"""Part B regression — dill fast-path failures fall back, never crash.

The dill fast-path in ``Wrapper.restore_snapshot`` has been observed to
destabilise the worker: ANDES's ``andes.utils.snapshot.load_ss`` either raises
mid-load (e.g. ``IndexError: index 0 is out of bounds`` on a case with dynamic
models — reproduced live on kundur) or, worse, the old System being GC'd closes
a file descriptor that collides with the worker's multiprocessing pipe.

The hardened fast path wraps ``load_ss`` + the System swap + a post-load sanity
access in a single try/except that, on ANY exception, restores the previous
System and falls back to the always-works replay+PF slow path. These tests pin
that behaviour:

- A ``load_ss`` that raises does NOT propagate; restore returns ``used_dill``
  False with a ``fallback_reason``, and the wrapper's System stays usable.
- A ``load_ss`` that succeeds but yields a structurally broken System (the
  sanity-touch raises) ALSO falls back rather than leaving the wrapper holding
  a half-restored object.

The residual case — a true fd-level crash from ``load_ss`` that is NOT a
catchable Python exception — is NOT covered here; Part A (``WorkerDiedError``)
is the guarantee for that, verified in ``test_session_lifecycle.py`` and
``test_snapshot_api.py``.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from andes_app.core.wrapper import Wrapper

pytestmark = pytest.mark.integration


def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
def ieee14_wrapper(tmp_path: Path) -> tuple[Wrapper, Path]:
    """Static-only IEEE 14 (no .dyr) where ``load_ss`` round-trips cleanly, so a
    forced ``load_ss`` failure isolates the fallback path under test."""
    cases = _bundled_cases_dir()
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    case = workspace / "ieee14.raw"
    shutil.copy2(cases / "ieee14" / "ieee14.raw", case)
    w = Wrapper(workspace=workspace, session_id="dill-fallback")
    w.load_case(case)
    return w, workspace


def test_load_ss_raising_falls_back_cleanly(
    ieee14_wrapper: tuple[Wrapper, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``load_ss`` that raises must NOT propagate or crash: restore falls back
    to replay+PF, the System the wrapper holds stays usable, and a
    ``fallback_reason`` is recorded."""
    w, _ = ieee14_wrapper
    w.run_pflow()
    w.save_snapshot("snap")

    ss_before = w._ss  # the live, converged System

    def _boom(_path: str) -> object:
        # Simulate the kundur IndexError observed live inside load_ss.
        raise IndexError("index 0 is out of bounds for axis 0 with size 0")

    monkeypatch.setattr("andes.utils.snapshot.load_ss", _boom)

    result = w.restore_snapshot("snap", use_dill_optimization=True)

    assert result["used_dill"] is False
    assert result["fallback_reason"] is not None
    assert "dill load failed" in result["fallback_reason"]
    # The wrapper still holds a usable System (the slow path re-ran setup+PF) —
    # NOT None and NOT the torn half-restored object. Re-running PF proves it.
    assert w._ss is not None
    assert w._ss is not ss_before  # reload_case built a fresh System
    pf = w.run_pflow()
    assert pf.converged is True


def test_load_ss_success_but_broken_system_falls_back(
    ieee14_wrapper: tuple[Wrapper, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``load_ss`` returns an object, but the post-load sanity access blows up
    (a structurally broken restore). The hardened guard — which spans the swap
    AND the sanity-touch — must still fall back and restore a usable System,
    rather than leaving the wrapper holding the broken object."""
    w, _ = ieee14_wrapper
    w.run_pflow()
    w.save_snapshot("snap")

    class _Broken:
        @property
        def is_setup(self) -> bool:
            # The sanity-touch (``getattr(ss_loaded, "is_setup", None)``) walks
            # the object graph; raising here mimics a dill blob whose internals
            # are present but unusable.
            raise RuntimeError("torn object graph")

    monkeypatch.setattr(
        "andes.utils.snapshot.load_ss", lambda _path: _Broken()
    )

    result = w.restore_snapshot("snap", use_dill_optimization=True)

    assert result["used_dill"] is False
    assert result["fallback_reason"] is not None
    # The broken object was NOT retained; the slow path left a usable System.
    assert w._ss is not None
    assert not isinstance(w._ss, _Broken)
    pf = w.run_pflow()
    assert pf.converged is True
