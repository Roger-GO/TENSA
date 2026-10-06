"""Disturbances committed to the System, and the Alter sources of a model."""

from __future__ import annotations

import logging
from typing import Any

from tensa.core.disturbance import AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec
from tensa.core.errors import (
    DisturbanceCommitError,
    DisturbanceValidationError,
    ElementValidationError,
    NoCaseLoadedError,
)
from tensa.core.wrapper.base import WrapperBase, _sanitize_message
from tensa.core.wrapper.params import _ALTERABLE_SERVICES


class DisturbanceMixin(WrapperBase):
    """The disturbances committed to the System before ``setup()``, and the log
    of them that lets a reload add them again."""

    @staticmethod
    def _coerce_existing_idx(ss: Any, model_name: str, raw: int | str) -> int | str:
        """Resolve ``raw`` against a model's actual idx values, tolerating
        str/int representation differences.

        JSON clients (agents, curl) naturally send idx as strings while xlsx
        cases commonly carry integer idx — ANDES accepts the mismatched
        reference at ``add()`` time and only explodes later inside
        ``setup()`` ("device not exist with idx=7"). Returns the native idx
        when a stringwise match exists, else ``raw`` unchanged so ANDES
        produces its own error for genuinely unknown devices.
        """
        model = getattr(ss, model_name, None)
        idx_values = getattr(getattr(model, "idx", None), "v", None)
        if not idx_values:
            return raw
        try:
            if raw in idx_values:
                return raw
        except (TypeError, ValueError):  # pragma: no cover - exotic idx types
            pass
        raw_str = str(raw)
        for candidate in idx_values:
            if str(candidate) == raw_str:
                return candidate  # type: ignore[no-any-return]
        return raw

    def add_disturbance(self, spec: DisturbanceSpec) -> int | str:
        """Add a disturbance to the pre-setup System. Returns the assigned
        ANDES idx of the created device.

        On success the spec is appended to ``self._disturbance_log`` so that
        ``replay_disturbances()`` can replay them after a future
        ``reload_case()`` (the only escape from the post-setup ``add()``
        rejection ANDES enforces). Failures (``ANDES rejected …``) leave the
        log untouched — atomic from the caller's perspective.

        Raises ``DisturbanceCommitError`` if setup has been committed; the
        caller must call ``reload_case()`` to add more.
        """
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        if self._ss.is_setup:
            raise DisturbanceCommitError()

        if isinstance(spec, FaultSpec):
            kwargs = {
                "bus": self._coerce_existing_idx(self._ss, "Bus", spec.bus_idx),
                "tf": spec.tf,
                "tc": spec.tc,
                "xf": spec.xf,
                "rf": spec.rf,
            }
            model_name = "Fault"
        elif isinstance(spec, ToggleSpec):
            kwargs = {
                "model": spec.model,
                "dev": self._coerce_existing_idx(self._ss, spec.model, spec.dev_idx),
                "t": spec.t,
            }
            model_name = "Toggle"
        elif isinstance(spec, AlterSpec):
            # ANDES Alter has NO ``value`` param — the change is driven by
            # ``method`` (mandatory: one of + - * / =) applied with ``amount``
            # to the current value of ``src``. The old code passed ``value`` and
            # every Alter failed at add() with "Mandatory parameter method
            # missing", so load-increase / parameter-alter were 100% broken.
            kwargs = {
                "model": spec.model,
                "dev": self._coerce_existing_idx(self._ss, spec.model, spec.dev_idx),
                "src": spec.src,
                "t": spec.t,
                "method": spec.method,
                "amount": spec.amount,
            }
            model_name = "Alter"
        else:  # pragma: no cover — Pydantic discriminator should prevent this
            raise DisturbanceValidationError(
                f"unknown disturbance kind: {type(spec).__name__}"
            )

        try:
            idx: int | str = self._ss.add(model_name, kwargs)
        except Exception as exc:  # noqa: BLE001
            # Don't pollute the replay log on rejection — the caller saw
            # an exception, ``list_disturbances`` must reflect that.
            raise DisturbanceValidationError(
                f"ANDES rejected {model_name} spec: {_sanitize_message(str(exc))}"
            ) from exc
        self._disturbance_log.append(spec)
        self._client_events.append((model_name, idx))
        return idx

    def list_disturbances(self) -> list[DisturbanceSpec]:
        """Return a defensive copy of the currently-recorded disturbance specs.

        The list reflects every spec that was successfully accepted by
        ``add_disturbance`` since the most recent ``load_case`` /
        ``reload_case`` / ``clear_disturbances`` call. The route layer
        consumes this for the ``GET /sessions/{id}/disturbances`` sync
        endpoint.
        """
        return list(self._disturbance_log)

    def clear_disturbances(self) -> None:
        """Clear the disturbance log without touching the loaded System.

        Does NOT remove the actual ``Fault`` / ``Toggle`` / ``Alter`` devices
        that were already added to ``self._ss`` — only the replay log. The
        Wrapper has no public delete-disturbance API on the System (ANDES
        ``ss.add`` rejects post-setup; pre-setup it offers no removal hook
        either). To fully purge, callers must ``reload_case()`` and
        re-replay only what they want to keep.
        """
        self._disturbance_log = []

    def replay_disturbances(self) -> int:
        """Re-add every spec in ``self._disturbance_log`` to the current System.

        Intended use: ``reload_case()`` (which clears the log because
        it ``load_case``s a fresh System) → ``replay_disturbances()``
        (re-adds them on the new pre-setup System). Returns the number
        of specs replayed.

        No-op (returns 0, logs a warning) if the System is post-setup —
        ANDES rejects ``add()`` calls then. No-op if the log is empty.
        On individual replay failure raises ``DisturbanceValidationError``;
        already-replayed specs remain on the System and the log is rebuilt
        only for those entries that succeeded BEFORE the failure.
        """
        log = logging.getLogger("tensa.wrapper.disturbance-replay")
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        if self._ss.is_setup:
            log.warning(
                "replay_disturbances called post-setup; no-op. "
                "Call reload_case() first to return to pre-setup."
            )
            return 0
        # Snapshot before reset — re-calling ``add_disturbance`` re-appends to
        # ``self._disturbance_log``; without the snapshot the iteration would
        # double-count and grow without bound.
        pending = list(self._disturbance_log)
        self._disturbance_log = []
        for spec in pending:
            self.add_disturbance(spec)
        return len(pending)

    # ----- introspection (Unit 1b of v0.2) -----

    def alterable_params(self, model: str) -> list[str]:
        """Return the ordered list of parameter names that ANDES will accept
        as ``src`` for an ``Alter`` disturbance on the given model.

        The rule mirrors ANDES's ``alter()`` contract: a parameter is
        alterable iff it is a ``NumParam`` instance AND not an ``ExtParam``
        (which is a derived/external value sourced off another model).
        Topology refs (``IdxParam``: ``bus``, ``bus1``, ``area``, etc.) and
        string identifiers (``DataParam``: ``idx``, ``name``) are excluded.

        Raises ``NoCaseLoadedError`` if no case is loaded on the session.
        Raises ``ElementValidationError`` if the model name is not a known
        attribute on the loaded ``System`` (404 at the API layer).

        Works pre- or post-setup — ``model.params`` is populated at parse
        time.
        """
        from andes.core.param import ExtParam, NumParam

        ss = self._require_loaded()
        model_obj = getattr(ss, model, None)
        # ANDES populates a ``params`` OrderedDict on every Model instance at
        # ``__init__``. Reject not-a-model attributes like ``ss.config`` or
        # ``ss.dae`` (which exist on the System but aren't ANDES models) by
        # checking that ``params`` exists and is dict-shaped.
        params_dict: Any = (
            getattr(model_obj, "params", None) if model_obj is not None else None
        )
        if not isinstance(params_dict, dict):
            raise ElementValidationError(
                f"unknown model {model!r} on the loaded System"
            )
        out: list[str] = []
        for name, param in params_dict.items():
            if not isinstance(param, NumParam):
                continue
            if isinstance(param, ExtParam):
                continue
            out.append(str(name))
        # ANDES applies time-domain alterations to certain ConstService values,
        # NOT the NumParam set-points: a PQ load's TDS power is Ppf/Qpf, while
        # p0/q0 only feed power flow and are silent no-ops in TDS. Those services
        # are not NumParams so the loop above misses them — surface a small,
        # conservative whitelist of TDS-relevant services so "increase a load"
        # offers the source that actually moves the simulation.
        services: Any = getattr(model_obj, "services", None)
        if isinstance(services, dict):
            for svc_name in _ALTERABLE_SERVICES.get(model, ()):
                if svc_name in services and svc_name not in out:
                    out.append(svc_name)
        return out
