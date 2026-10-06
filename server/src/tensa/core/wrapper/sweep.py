"""Sensitivity sweeps."""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from threading import Event
from typing import Any

from tensa.core.disturbance import DisturbanceSpec
from tensa.core.edit_log import ops_from_dicts, ops_to_dicts
from tensa.core.errors import NoCaseLoadedError
from tensa.core.wrapper.base import _sanitize_message
from tensa.core.wrapper.snapshot import SnapshotMixin
from tensa.core.wrapper.tds import TdsMixin, validate_step_size


class SweepMixin(SnapshotMixin, TdsMixin):
    """Sensitivity sweeps over a snapshot's disturbances, on this wrapper or
    spread over sub-workers."""

    def run_sweep(
        self,
        *,
        snapshot_name: str,
        parameter_kind: str,
        parameter_target: int,
        values: list[float],
        tf: float,
        h: float | None = None,
        on_iteration: Callable[[int, float, dict[str, Any]], None] | None = None,
        abort_flag: Event | None = None,
    ) -> dict[str, Any]:
        """Run a sensitivity sweep — Unit 18.

        The named snapshot's recorded ``disturbance_log`` is read once,
        before the loop; it cannot change while the sweep holds the
        session. For each value in ``values``:

        1. Reload the case. This sidesteps the ANDES post-iteration
           cleanup gap by always returning to a pre-setup System.
        2. Re-add the snapshot's disturbances with the target spec's
           field overridden by the current iteration's value.
        3. Run TDS with the requested ``tf`` / ``h``. ``run_tds`` commits
           setup and solves the power flow itself, so the iteration needs
           no restore of the snapshot's operating point.
        4. Record the iteration result.

        A snapshot that cannot be used (missing, corrupt, target index
        past its log, wrong disturbance kind) fails every iteration with
        the same ``error``; nothing is reloaded or run for them.

        Diverging or otherwise-failing iterations are recorded with
        ``error`` set and the sweep continues. Aborts (via
        ``abort_flag``) cause the loop to exit at the next iteration
        boundary; iterations completed so far are returned with
        ``truncated=True``.

        ``on_iteration`` is invoked AFTER each iteration with
        ``(iter_idx, parameter_value, result_dict)``. The worker uses
        this to ship per-iteration progress over the data_pipe.

        Returns a dict with ``iterations`` (list of per-iteration
        result dicts) and ``truncated`` (bool). The route layer is
        responsible for adding the sweep_id.

        This runs every iteration on this wrapper, one after another. A larger
        sweep is spread over sub-workers by the session manager instead, which
        asks this wrapper for :meth:`sweep_plan` and has each sub-worker call
        :meth:`run_sweep_iteration`.
        """
        # Lazy import keeps the module-level import graph free of the
        # sweep types (which import from this module's siblings).
        from tensa.core.sweep import parse_sweep_target

        if self._workspace is None:
            raise NoCaseLoadedError(
                "sweep requires a workspace; the substrate "
                "was launched without one"
            )

        expected_kind, spec_field = parse_sweep_target(parameter_kind)
        # A bad ``h`` would otherwise be recorded as a per-iteration error
        # N times over; refuse it before the snapshot is read.
        h = validate_step_size(h)

        log = logging.getLogger("tensa.wrapper.sweep")

        # The snapshot is read once, not per iteration. A failure here is kept
        # and recorded against every iteration (raised inside the per-iteration
        # ``try`` in ``_sweep_iteration``), so the sweep still reports one result
        # per value.
        snap_log: list[DisturbanceSpec] = []
        snapshot_error: Exception | None = None
        try:
            snap_log = self._read_sweep_log(
                snapshot_name, parameter_kind, expected_kind, parameter_target
            )
        except Exception as exc:  # noqa: BLE001
            snapshot_error = exc

        iterations_out: list[dict[str, Any]] = []
        truncated = False

        for idx, value in enumerate(values):
            # Honor abort BEFORE starting an expensive iteration. The
            # abort flag is also wired into ``run_tds`` via the
            # ``abort_flag`` parameter so a mid-iteration abort fires
            # at the next callpert tick.
            if abort_flag is not None and abort_flag.is_set():
                truncated = True
                break

            iter_dict = self._sweep_iteration(
                idx=idx,
                value=value,
                snap_log=snap_log,
                snapshot_error=snapshot_error,
                spec_field=spec_field,
                parameter_target=parameter_target,
                tf=tf,
                h=h,
                abort_flag=abort_flag,
                log=log,
            )
            iterations_out.append(iter_dict)

            if on_iteration is not None:
                try:
                    on_iteration(idx, float(value), iter_dict)
                except Exception:  # noqa: BLE001
                    # Progress callback failures must never crash the
                    # sweep; the data_pipe forwarding may have hit a
                    # broken pipe, in which case we just continue.
                    log.exception("sweep on_iteration callback raised")

            # Final post-iteration abort check — the run_tds may have
            # honoured the abort flag mid-integration (busted=True);
            # in that case ``converged`` is False and we should stop
            # the outer loop here.
            if abort_flag is not None and abort_flag.is_set():
                truncated = True
                break

        return {
            "iterations": iterations_out,
            "truncated": truncated,
            "total_requested": len(values),
        }

    def _read_sweep_log(
        self,
        snapshot_name: str,
        parameter_kind: str,
        expected_kind: str,
        parameter_target: int,
    ) -> list[DisturbanceSpec]:
        """The snapshot's disturbance log, checked against the sweep's target.

        Raises what :meth:`_read_snapshot_record` raises for a snapshot that is
        missing or corrupt, and ``SweepValidationError`` for a target index past
        the log or a disturbance of another kind than ``parameter_kind`` sweeps.
        """
        from tensa.core.sweep import SweepValidationError

        snap_log = self._read_snapshot_record(snapshot_name).specs
        if parameter_target >= len(snap_log):
            raise SweepValidationError(
                f"sweep target index {parameter_target} out of range; "
                f"snapshot recorded {len(snap_log)} disturbance(s)"
            )
        if snap_log[parameter_target].kind != expected_kind:
            raise SweepValidationError(
                f"sweep kind {parameter_kind!r} expects "
                f"{expected_kind!r} disturbance at target "
                f"{parameter_target}, found "
                f"{snap_log[parameter_target].kind!r}"
            )
        return snap_log

    def _sweep_iteration(
        self,
        *,
        idx: int,
        value: float,
        snap_log: list[DisturbanceSpec],
        snapshot_error: Exception | None,
        spec_field: str,
        parameter_target: int,
        tf: float,
        h: float | None,
        abort_flag: Event | None,
        log: logging.Logger,
    ) -> dict[str, Any]:
        """One sweep iteration: reload, add the log with the override, run TDS.

        Never raises for a failing iteration. The failure comes back as the
        result's ``error`` so a sweep shows which values failed instead of
        stopping at the first.
        """
        iter_error: str | None = None
        converged = False
        final_t = 0.0
        callpert_count = 0

        try:
            if snapshot_error is not None:
                raise snapshot_error

            # 1. reload_case() returns to a clean pre-setup System and
            #    clears the wrapper's log so we can re-add the mutated
            #    spec via ``add_disturbance`` (ANDES rejects post-setup
            #    add(); the only escape is reload).
            self.reload_case()
            # Build a new spec with the override applied via
            # Pydantic's ``model_copy`` — preserves the discriminator
            # and any unrelated fields, only the target field is
            # replaced. ``model_copy(update={...})`` is Pydantic v2's
            # immutable update API.
            mutated = snap_log[parameter_target].model_copy(
                update={spec_field: float(value)}
            )
            # 2. Re-add the snapshot's disturbances with the target
            #    replaced, onto the log the reload left empty.
            for j, spec in enumerate(snap_log):
                self.add_disturbance(mutated if j == parameter_target else spec)

            # 3. Run TDS. The wrapper's ``run_tds`` invokes
            #    ``_ensure_setup`` + ``ss.PFlow.run`` itself. The
            #    abort_flag is forwarded so an in-flight iteration
            #    can be terminated.
            tds_result = self.run_tds(
                tf=tf,
                h=h,
                abort_flag=abort_flag,
            )
            converged = bool(tds_result.converged)
            final_t = float(tds_result.final_t)
            callpert_count = int(tds_result.callpert_count)
        except Exception as exc:  # noqa: BLE001
            # Per-iteration failures are recorded but do NOT abort
            # the sweep — researchers want to see WHICH parameter
            # values diverged, not just "sweep died at iter N".
            iter_error = f"{type(exc).__name__}: {_sanitize_message(str(exc))}"
            log.warning(
                "sweep iteration %d (value=%g) failed: %s",
                idx,
                value,
                iter_error,
            )

        return {
            "iteration": idx,
            "parameter_value": float(value),
            "converged": converged,
            "final_t": final_t,
            "callpert_count": callpert_count,
            "error": iter_error,
        }

    # ----- parallel sweep support -----

    def sweep_plan(
        self,
        *,
        snapshot_name: str,
        parameter_kind: str,
        parameter_target: int,
    ) -> dict[str, Any]:
        """What a parallel sweep needs from this session before it can start.

        Reads and checks the snapshot the way :meth:`run_sweep` does, and
        returns it with the case this wrapper reloads at the start of every
        iteration: ``{"source": <sweep_source>, "specs": [<spec dict>, ...]}``.
        The session manager hands the source to each sub-worker
        (:meth:`adopt_sweep_source`) and the specs with each iteration
        (:meth:`run_sweep_iteration`).

        Raises for anything :meth:`run_sweep` would instead record against every
        iteration (a snapshot that cannot be used, a bad target, no case). The
        caller then runs the sweep here, where each iteration reports the same
        error, rather than starting workers that could do nothing.
        """
        from tensa.core.sweep import parse_sweep_target

        if self._workspace is None:
            raise NoCaseLoadedError(
                "sweep requires a workspace; the substrate "
                "was launched without one"
            )
        expected_kind, _ = parse_sweep_target(parameter_kind)
        specs = self._read_sweep_log(
            snapshot_name, parameter_kind, expected_kind, parameter_target
        )
        return {
            "source": self.sweep_source(),
            "specs": [spec.model_dump() for spec in specs],
        }

    def sweep_source(self) -> dict[str, Any]:
        """What :meth:`reload_case` reloads, in a form another wrapper can adopt.

        A case file session is its path and add-on files. A blank session has no
        file, so it is the recorded additions that rebuild it. Raises
        :class:`NoCaseLoadedError` when neither exists, as ``reload_case`` does.
        """
        if self._case_path is not None:
            return {
                "case_path": str(self._case_path),
                "addfiles": [str(a) for a in self._addfiles] if self._addfiles else None,
                "replay": [],
            }
        if not self._edit_log:
            raise NoCaseLoadedError(
                "no case has been loaded; call load_case() or create_blank() first"
            )
        return {
            "case_path": None,
            "addfiles": None,
            "replay": ops_to_dicts(self._edit_log),
        }

    def adopt_sweep_source(self, source: dict[str, Any]) -> None:
        """Make :meth:`reload_case` reload what another wrapper's does.

        ``source`` is that wrapper's :meth:`sweep_source`. Nothing is parsed
        here: the first ``reload_case`` loads the case, so a sub-worker that
        adopts a source costs nothing until its first iteration. Resets the
        wrapper's System, as a load would.
        """
        self._ss = None
        self._setup_failed = False
        self._disturbance_log = []
        self._client_events = []
        self._se_measurements = None
        self._redo_log = []
        case_path = source.get("case_path")
        if case_path is not None:
            addfiles = source.get("addfiles")
            self._case_path = Path(case_path)
            self._addfiles = [Path(a) for a in addfiles] if addfiles else None
            self._edit_log = []
        else:
            self._case_path = None
            self._addfiles = None
            self._edit_log = ops_from_dicts(source.get("replay") or [])

    def run_sweep_iteration(
        self,
        *,
        index: int,
        value: float,
        specs: list[DisturbanceSpec],
        parameter_kind: str,
        parameter_target: int,
        tf: float,
        h: float | None = None,
        abort_flag: Event | None = None,
    ) -> dict[str, Any]:
        """One iteration of a sweep, for a sub-worker of a parallel sweep.

        ``specs`` is the snapshot's disturbance log, already read and checked
        by :meth:`sweep_plan` on the session's worker, so nothing here touches
        the snapshot. The result is the dict :meth:`run_sweep` records for the
        iteration at ``index``. The wrapper must hold the sweep's case (see
        :meth:`adopt_sweep_source`); the iteration reloads it, as in
        :meth:`run_sweep`.
        """
        from tensa.core.sweep import parse_sweep_target

        _, spec_field = parse_sweep_target(parameter_kind)
        return self._sweep_iteration(
            idx=index,
            value=value,
            snap_log=specs,
            snapshot_error=None,
            spec_field=spec_field,
            parameter_target=parameter_target,
            tf=tf,
            h=validate_step_size(h),
            abort_flag=abort_flag,
            log=logging.getLogger("tensa.wrapper.sweep"),
        )
