"""Unit coverage for the streaming / sweep driver terminal reconciliation.

Unit 5c wired the long-lived drivers' terminal paths into the registry:

  - ``_finish_streaming_job``: ``error`` → ``mark_failed('tds-stream')`` with a
    ``ProblemDetails`` synthesized from the driver's ``(category, detail)``;
    ``completed`` → ``mark_done``.
  - ``_finish_sweep_job``: ``error`` → ``mark_failed('sweep')``; ``aborted`` →
    ``mark_cancelled``; ``completed`` → ``mark_done``.

The job_id / sweep_id aliasing tests only cover the happy ``done`` path; these
assert the FAILURE / ABORT reconciliation (category + status), which was
otherwise untested.
"""

from __future__ import annotations

from typing import Any

from andes_app.core.session import (
    SessionManager,
    _RunBuffer,
    _Session,
)


class _FakeCtrl:
    def send(self, msg: dict[str, Any]) -> None:  # pragma: no cover - unused
        pass


def _mgr_with_session(session_id: str = "s1") -> tuple[SessionManager, _Session]:
    mgr = SessionManager()
    sess = _Session(
        session_id=session_id,
        process=None,
        ctrl=_FakeCtrl(),
        data=_FakeCtrl(),
        abort_event=None,
    )
    mgr._sessions[session_id] = sess
    return mgr, sess


def test_finish_streaming_job_error_marks_failed_with_category() -> None:
    mgr, sess = _mgr_with_session()
    run_id = mgr.register_streaming_job("s1", run_id="run-1", kind="tds-stream")
    sess.job_registry.mark_running(run_id)

    run_buf = _RunBuffer(run_id=run_id, session_id="s1")
    mgr._finish_streaming_job(
        run_buf, "error", error=("PFlowDivergence", "did not converge")
    )

    rec = sess.job_registry.get_job(run_id)
    assert rec is not None
    assert rec.status == "failed"
    assert rec.problem is not None
    assert rec.problem["category"] == "PFlowDivergence"
    assert rec.problem["detail"] == "did not converge"


def test_finish_sweep_job_error_marks_failed() -> None:
    mgr, sess = _mgr_with_session()
    sweep_id = mgr.register_sweep_job("s1", sweep_id="sweep-1", kind="sweep")
    sess.job_registry.mark_running(sweep_id)

    mgr._finish_sweep_job(
        sess, sweep_id, "error", error=("internal-error", "worker blew up")
    )

    rec = sess.job_registry.get_job(sweep_id)
    assert rec is not None
    assert rec.status == "failed"
    assert rec.problem is not None
    assert rec.problem["category"] == "internal-error"


def test_finish_sweep_job_aborted_marks_cancelled() -> None:
    mgr, sess = _mgr_with_session()
    sweep_id = mgr.register_sweep_job("s1", sweep_id="sweep-2", kind="sweep")
    sess.job_registry.mark_running(sweep_id)

    mgr._finish_sweep_job(
        sess, sweep_id, "aborted", error=("cancelled", "sweep cancelled")
    )

    rec = sess.job_registry.get_job(sweep_id)
    assert rec is not None
    assert rec.status == "cancelled"
