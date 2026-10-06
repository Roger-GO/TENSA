"""``tensa.core.wrapper`` keeps the import surface it had as one module.

The ``Wrapper`` is put together from one mixin per routine, in the modules beside
it, and the helpers its routines share live there too. Callers (the worker, the
routes, the clone manager, scripts and tests) still reach every name through
``tensa.core.wrapper`` and every method through ``Wrapper``; these tests pin that.
"""

from __future__ import annotations

import importlib
import subprocess
import sys

import pytest

import tensa.core.wrapper as wrapper_pkg
from tensa.core.wrapper import Wrapper

# Every name the single-file module defined, and the module of the package that
# defines it now. ``tensa.core.wrapper`` must hand out that very object.
SURFACE: dict[str, str] = {
    "_PATH_PATTERN": "base",
    "_sanitize_message": "base",
    "_argmax": "cpf",
    "_build_cpf_result": "cpf",
    "_first_turn": "cpf",
    "_compute_damping_ratio": "eig",
    "_compute_frequency_hz": "eig",
    "_eig_state_names": "eig",
    "DELETE_DEPENDENTS_CAP": "elements",
    "EDIT_LOG_MAX": "elements",
    "_GENROU_REACTANCE_CHAINS": "elements",
    "_GENROU_REACTANCE_NAMES": "elements",
    "_edit_number": "elements",
    "_missing_mandatory": "elements",
    "_text_or_none": "elements",
    "_validate_genrou_reactance_edit": "elements",
    "_validate_genrou_reactances": "elements",
    "ParamKind": "params",
    "ParamMeta": "params",
    "_ALTERABLE_SERVICES": "params",
    "_CONTROLLER_MODEL_NAMES": "params",
    "_PARAMS_BY_MODEL": "params",
    "allowed_param_names": "params",
    "param_metadata_for_form": "params",
    "_extract_generator_outputs": "pflow_extract",
    "_extract_line_flows": "pflow_extract",
    "_extract_load_consumption": "pflow_extract",
    "_in_service_flags": "pflow_extract",
    "_is_zero": "pflow_extract",
    "_reference_angle_drift": "pflow_extract",
    "_safe_list": "pflow_extract",
    "_scaled": "pflow_extract",
    "_shunt_absorption": "pflow_extract",
    "_static_shunts": "pflow_extract",
    "_summarize_pflow": "pflow_extract",
    "DeleteResult": "results",
    "DeletedDisturbance": "results",
    "GeneratorOutput": "results",
    "LineFlow": "results",
    "LoadConsumption": "results",
    "ParamValue": "results",
    "PflowResult": "results",
    "PflowSummary": "results",
    "TdsBatchResult": "results",
    "TopologyEntry": "results",
    "TopologySnapshot": "results",
    "_SnapshotRecord": "snapshot",
    "_TDS_OVERRIDE_ALIASES": "tds",
    "_qndf_needs_init": "tds",
    "_tds_unstepped": "tds",
    "tds_fixed_step": "tds",
    "validate_step_size": "tds",
    "validate_tds_overrides": "tds",
    "_coerce_scalar": "topology",
    "_collect_models": "topology",
    "_extract_params": "topology",
    "_split_lines_transformers": "topology",
    "_system_base_mva": "topology",
    "_system_frequency_hz": "topology",
}

# The methods the session's worker, the routes and the tests call on a ``Wrapper``.
PUBLIC_METHODS: tuple[str, ...] = (
    "add_disturbance",
    "add_element",
    "add_pmu",
    "add_timeseries",
    "adopt_sweep_source",
    "alterable_params",
    "apply_clone_edit",
    "check_tds_request",
    "clear_disturbances",
    "clone_diff",
    "compute_connectivity",
    "create_blank",
    "delete_element",
    "delete_pmu",
    "delete_snapshot",
    "delete_timeseries",
    "edit_element",
    "eig_participation",
    "export_pmu_csv",
    "generate_measurements_from_pflow",
    "get_eig_state_matrix",
    "import_bundle",
    "init_clone",
    "list_disturbances",
    "list_pmus",
    "list_snapshots",
    "list_timeseries",
    "load_case",
    "operating_point",
    "redo_clone_edit",
    "redo_edit",
    "reload_case",
    "replay_disturbances",
    "reset_clone",
    "restore_snapshot",
    "run_cpf",
    "run_cpf_qv",
    "run_eig",
    "run_pflow",
    "run_se",
    "run_sweep",
    "run_sweep_iteration",
    "run_tds",
    "save_case",
    "save_clone_as",
    "save_snapshot",
    "sweep_plan",
    "sweep_source",
    "tds_controller_catalogue",
    "tds_controllers",
    "topology_snapshot",
    "undo_clone_edit",
    "undo_last_edit",
    "upload_profile",
)

# Private methods that code outside the module reaches for: the clone manager binds
# its System through one, and the tests build, patch and read through the others.
REACHED_BY_OTHERS: tuple[str, ...] = (
    "_bind_clone_system",
    "_build_system",
    "_clone_mgr",
    "_ensure_setup",
    "_load_system",
    "_require_loaded",
)


@pytest.mark.unit
@pytest.mark.parametrize(("name", "module"), sorted(SURFACE.items()))
def test_a_name_the_module_defined_is_the_object_its_new_module_defines(
    name: str, module: str
) -> None:
    home = importlib.import_module(f"tensa.core.wrapper.{module}")
    assert hasattr(wrapper_pkg, name)
    assert getattr(wrapper_pkg, name) is getattr(home, name)


@pytest.mark.unit
def test_the_package_exports_exactly_the_names_the_module_defined() -> None:
    assert set(wrapper_pkg.__all__) == {*SURFACE, "Wrapper"}


@pytest.mark.unit
def test_the_wrapper_is_still_defined_at_the_old_module_path() -> None:
    assert Wrapper.__module__ == "tensa.core.wrapper"
    assert wrapper_pkg.Wrapper is Wrapper


@pytest.mark.unit
@pytest.mark.parametrize("method", [*PUBLIC_METHODS, *REACHED_BY_OTHERS])
def test_the_wrapper_has_the_method(method: str) -> None:
    assert callable(getattr(Wrapper, method))


@pytest.mark.unit
def test_the_wrapper_has_no_public_method_beyond_the_pinned_ones() -> None:
    public = {n for n in dir(Wrapper) if not n.startswith("_") and callable(getattr(Wrapper, n))}
    assert public == set(PUBLIC_METHODS)


@pytest.mark.unit
def test_no_method_is_defined_by_two_of_the_mixins() -> None:
    # A name defined twice would be settled by the order the mixins are listed in,
    # which a later edit of that list could change without anyone noticing.
    defined_in: dict[str, str] = {}
    for klass in Wrapper.__mro__[:-1]:
        for name in vars(klass):
            if name.startswith("__") and name.endswith("__") and name != "__init__":
                continue
            assert name not in defined_in, (
                f"{name} is defined by {defined_in[name]} and by {klass.__name__}"
            )
            defined_in[name] = klass.__name__


@pytest.mark.integration
@pytest.mark.parametrize(
    "first",
    ["tensa.core.clone_manager", "tensa.core.wrapper.clone", "tensa.core.wrapper.params"],
)
def test_the_package_imports_whichever_module_a_fresh_interpreter_reaches_first(
    first: str,
) -> None:
    # The clone manager imports names from the wrapper, and the wrapper builds a clone
    # manager: whichever is imported first must not trip over the other.
    done = subprocess.run(
        [sys.executable, "-c", f"import {first}; import tensa.core.wrapper"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
