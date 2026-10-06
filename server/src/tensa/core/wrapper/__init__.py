"""In-process ANDES wrapper.

Owns a long-lived ``andes.System`` instance for a single session. This class
runs inside a per-session subprocess (spawned by ``tensa.core.session.SessionManager``)
and is never invoked from the FastAPI event loop directly.

Lifecycle:
    1. ``load_case(path, addfiles=...)`` — calls ``andes.load(setup=False)``.
    2. ``add_disturbance(spec)`` — accepts FaultSpec / ToggleSpec / AlterSpec
       while the System is still pre-setup. Raises ``DisturbanceCommitError``
       once setup has been committed.
    3. ``run_pflow()`` — calls ``ss.setup()`` first if ``not ss.is_setup``
       (verified against ANDES 2.0.0: ``PFlow.run`` does NOT auto-call setup;
       it raises ``IndexError`` on a non-setup System), then ``ss.PFlow.run()``.
    4. ``run_tds(spec, on_step, abort_flag)`` — same setup contract; sets
       ``ss.TDS.callpert`` to a wrapper that emits per-step snapshots and
       checks the abort flag.
    5. ``reload_case()`` — re-runs ``andes.load(setup=False)`` to return to
       editable state. This is the only escape hatch from a committed System;
       it is honest about cost (full re-parse via ``andes.load``).

Thread-safety: This class is NOT thread-safe. It is invoked from a single
thread (the worker subprocess's main thread). The abort flag is set from a
separate worker-side thread that owns the control Pipe (see ``worker.py``).

Layout: ``Wrapper`` is put together here from one mixin per group of routines,
each in its own module of this package over the shared state in
``base.WrapperBase`` (a mixin that calls another's methods inherits from it):

- ``case``, ``topology``, ``disturbances``: load, reload, rebuild and save the
  case, read it as a topology, commit disturbances to it.
- ``elements``, ``pmu``, ``timeseries``: add, edit, delete, undo and redo
  elements; PMU and TimeSeries devices.
- ``pflow``, ``tds``, ``eig``, ``cpf``, ``se``, ``connectivity``: the routines.
- ``snapshot``, ``sweep``, ``bundle``: save and restore a session, sweep over a
  snapshot, import a bundle.
- ``clone``: clone-on-write editing.

``results`` holds the records the methods return, ``params`` the models and
parameters a client may touch, and ``pflow_extract`` the readers of a solved
power flow. Every name the single-file module defined is importable from here.
"""

from __future__ import annotations

from tensa.core.wrapper.base import _PATH_PATTERN, _sanitize_message
from tensa.core.wrapper.bundle import BundleMixin
from tensa.core.wrapper.clone import CloneMixin
from tensa.core.wrapper.connectivity import ConnectivityMixin
from tensa.core.wrapper.cpf import CpfMixin, _argmax, _build_cpf_result, _first_turn
from tensa.core.wrapper.eig import (
    EigMixin,
    _compute_damping_ratio,
    _compute_frequency_hz,
    _eig_state_names,
)
from tensa.core.wrapper.elements import (
    _GENROU_REACTANCE_CHAINS,
    _GENROU_REACTANCE_NAMES,
    DELETE_DEPENDENTS_CAP,
    EDIT_LOG_MAX,
    _edit_number,
    _missing_mandatory,
    _text_or_none,
    _validate_genrou_reactance_edit,
    _validate_genrou_reactances,
)
from tensa.core.wrapper.params import (
    _ALTERABLE_SERVICES,
    _CONTROLLER_MODEL_NAMES,
    _PARAMS_BY_MODEL,
    ParamKind,
    ParamMeta,
    allowed_param_names,
    param_metadata_for_form,
)
from tensa.core.wrapper.pflow import PflowMixin
from tensa.core.wrapper.pflow_extract import (
    _extract_generator_outputs,
    _extract_line_flows,
    _extract_load_consumption,
    _in_service_flags,
    _is_zero,
    _reference_angle_drift,
    _safe_list,
    _scaled,
    _shunt_absorption,
    _static_shunts,
    _summarize_pflow,
)
from tensa.core.wrapper.pmu import PmuMixin
from tensa.core.wrapper.results import (
    DeletedDisturbance,
    DeleteResult,
    GeneratorOutput,
    LineFlow,
    LoadConsumption,
    ParamValue,
    PflowResult,
    PflowSummary,
    TdsBatchResult,
    TopologyEntry,
    TopologySnapshot,
)
from tensa.core.wrapper.se import SeMixin
from tensa.core.wrapper.snapshot import _SnapshotRecord
from tensa.core.wrapper.sweep import SweepMixin
from tensa.core.wrapper.tds import (
    _TDS_OVERRIDE_ALIASES,
    _qndf_needs_init,
    _tds_unstepped,
    tds_fixed_step,
    validate_step_size,
    validate_tds_overrides,
)
from tensa.core.wrapper.timeseries import TimeseriesMixin
from tensa.core.wrapper.topology import (
    _coerce_scalar,
    _collect_models,
    _extract_params,
    _split_lines_transformers,
    _system_base_mva,
    _system_frequency_hz,
)


class Wrapper(
    PmuMixin,
    TimeseriesMixin,
    SweepMixin,
    BundleMixin,
    CloneMixin,
    PflowMixin,
    EigMixin,
    CpfMixin,
    SeMixin,
    ConnectivityMixin,
):
    """Synchronous wrapper around a single ``andes.System`` instance.

    Public methods are the substrate's domain API. Each invocation runs to
    completion before the next can start (single-threaded contract). The
    caller (the worker subprocess's main loop) is responsible for serializing
    invocations.
    """


# Every name the single-file module defined, kept importable from here; the private
# ones are what the tests and the clone manager reach for.
__all__ = [
    "DELETE_DEPENDENTS_CAP",
    "DeleteResult",
    "DeletedDisturbance",
    "EDIT_LOG_MAX",
    "GeneratorOutput",
    "LineFlow",
    "LoadConsumption",
    "ParamKind",
    "ParamMeta",
    "ParamValue",
    "PflowResult",
    "PflowSummary",
    "TdsBatchResult",
    "TopologyEntry",
    "TopologySnapshot",
    "Wrapper",
    "_ALTERABLE_SERVICES",
    "_CONTROLLER_MODEL_NAMES",
    "_GENROU_REACTANCE_CHAINS",
    "_GENROU_REACTANCE_NAMES",
    "_PARAMS_BY_MODEL",
    "_PATH_PATTERN",
    "_SnapshotRecord",
    "_TDS_OVERRIDE_ALIASES",
    "_argmax",
    "_build_cpf_result",
    "_coerce_scalar",
    "_collect_models",
    "_compute_damping_ratio",
    "_compute_frequency_hz",
    "_edit_number",
    "_eig_state_names",
    "_extract_generator_outputs",
    "_extract_line_flows",
    "_extract_load_consumption",
    "_extract_params",
    "_first_turn",
    "_in_service_flags",
    "_is_zero",
    "_missing_mandatory",
    "_qndf_needs_init",
    "_reference_angle_drift",
    "_safe_list",
    "_sanitize_message",
    "_scaled",
    "_shunt_absorption",
    "_split_lines_transformers",
    "_static_shunts",
    "_summarize_pflow",
    "_system_base_mva",
    "_system_frequency_hz",
    "_tds_unstepped",
    "_text_or_none",
    "_validate_genrou_reactance_edit",
    "_validate_genrou_reactances",
    "allowed_param_names",
    "param_metadata_for_form",
    "tds_fixed_step",
    "validate_step_size",
    "validate_tds_overrides",
]
