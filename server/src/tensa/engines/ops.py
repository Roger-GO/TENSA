"""Which ops each engine's worker answers, as data.

The table of section 13 of ``design/multiengine/spec.md``: every worker op against
the engines that have it. It imports nothing from ANDES or any engine, so the
server process can read it without loading one. The ``"andes"`` set is the keys of
``HANDLERS`` in ``tensa.core.worker`` plus the three ops the dispatch special-cases;
a unit test holds the literal set to that, so the two cannot drift.
"""

from typing import Final

DEFAULT_ENGINE: Final = "andes"

ENGINE_NAMES: tuple[str, ...] = ("andes", "sienna")

ENGINE_OPS: dict[str, frozenset[str]] = {
    "andes": frozenset(
        {
            "load_case",
            "reload_case",
            "topology",
            "list_keys",
            "operating_point",
            "add_disturbance",
            "list_disturbances",
            "replay_disturbances",
            "clear_disturbances",
            "add_element",
            "edit_element",
            "create_blank",
            "save_case",
            "undo_last_edit",
            "redo_edit",
            "delete_element",
            "run_pflow",
            "init_tds",
            "alterable_params",
            "supported_models",
            "model_doc",
            "list_dae_variables",
            "list_tds_controllers",
            "init_clone",
            "apply_clone_edit",
            "undo_clone_edit",
            "redo_clone_edit",
            "save_clone_as",
            "reset_clone",
            "clone_diff",
            "export_bundle",
            "import_bundle",
            "generate_report",
            "run_eig",
            "run_eig_sweep",
            "eig_participation",
            "eig_state_matrix",
            "run_cpf",
            "run_cpf_qv",
            "generate_measurements_from_pflow",
            "run_se",
            "add_pmu",
            "list_pmus",
            "delete_pmu",
            "export_pmu_csv",
            "upload_profile",
            "add_timeseries",
            "list_timeseries",
            "delete_timeseries",
            "compute_connectivity",
            "bus_admittance_matrix",
            "save_snapshot",
            "restore_snapshot",
            "list_snapshots",
            "delete_snapshot",
            "sweep_plan",
            "adopt_sweep_source",
            # Special-cased by the dispatch (they need the abort event and the data pipe).
            "run_tds",
            "run_sweep",
            "run_sweep_iteration",
        }
    ),
    "sienna": frozenset(
        {
            "load_case",
            "reload_case",
            "topology",
            "operating_point",
            "run_pflow",
            "list_keys",
            "run_eig",
            "eig_participation",
            "add_disturbance",
            "list_disturbances",
            "clear_disturbances",
            "init_tds",
            # Special-cased by the dispatch (it needs the abort event).
            "run_tds",
        }
    ),
}


def engines_with_op(op: str) -> list[str]:
    """The engine names whose set holds ``op``, in ``ENGINE_NAMES`` order."""
    return [name for name in ENGINE_NAMES if op in ENGINE_OPS[name]]


def is_engine(name: str) -> bool:
    """Whether ``name`` is an engine the server knows, available or not."""
    return name in ENGINE_OPS
