"""``tensa.api.schemas`` keeps the import surface it had as one module.

The request and response models live in one module per domain, beside the package's
``__init__``. The routes, the tests and scripts still import every name from
``tensa.api.schemas``; these tests pin that, and that a model a module of the package
defines is exported from it.
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest
from pydantic import BaseModel

import tensa.api.schemas as schemas_pkg
import tensa.core.disturbance as disturbance

# Every name the single-file module defined, and the module of the package that
# defines it now. ``tensa.api.schemas`` must hand out that very object.
SURFACE: dict[str, str] = {
    "AbortResponse": "tds",
    "AddDisturbancesRequest": "disturbances",
    "AddDisturbancesResponse": "disturbances",
    "AddElementRequest": "elements",
    "AlterableParamsResponse": "cases",
    "BlankSystemResponse": "cases",
    "BusCoord": "workspace",
    "CaseEvent": "topology",
    "CloneDiffPair": "clone",
    "CloneDiffResponse": "clone",
    "CloneEditRequest": "clone",
    "CloneEditResponse": "clone",
    "CloneInitResponse": "clone",
    "CloneResetResponse": "clone",
    "CloneSaveAsRequest": "clone",
    "CloneSaveAsResponse": "clone",
    "ComtradeChannelSeries": "comtrade",
    "ComtradeExportRequest": "comtrade",
    "CreateSessionRequest": "sessions",
    "DaeVariableInfo": "tds",
    "DaeVariableList": "tds",
    "DampingEstimate": "metrics",
    "DeleteBlockedResponse": "elements",
    "DeleteElementResponse": "elements",
    "DeletedDisturbance": "elements",
    "DisturbanceAck": "disturbances",
    "EditElementRequest": "elements",
    "EditStep": "topology",
    "ElementCreated": "elements",
    "GeneratorOutput": "pflow",
    "JobKindSchema": "jobs",
    "JobRecordSchema": "jobs",
    "JobStatusSchema": "jobs",
    "LineFlow": "pflow",
    "LoadCaseRequest": "cases",
    "LoadConsumption": "pflow",
    "MAX_COMTRADE_VALUES": "comtrade",
    "MAX_METRIC_SAMPLES": "metrics",
    "MAX_METRIC_SAMPLES_TOTAL": "metrics",
    "MAX_METRIC_SERIES": "metrics",
    "MessageLevelSchema": "messages",
    "MetricExtremum": "metrics",
    "MetricsSeries": "metrics",
    "PflowResult": "pflow",
    "PflowRunRequest": "pflow",
    "PflowSettings": "pflow",
    "PflowSummary": "pflow",
    "ProblemDetails": "errors",
    "RECOVERY_DEFAULT_LABELS": "errors",
    "RecoveryDescriptor": "errors",
    "RecoveryKind": "errors",
    "ResponseMetricsRequest": "metrics",
    "ResponseMetricsResponse": "metrics",
    "SaveCaseRequest": "cases",
    "SaveCaseResponse": "cases",
    "SeriesMetrics": "metrics",
    "SessionDescriptor": "sessions",
    "SessionList": "sessions",
    "SessionMessageSchema": "messages",
    "SessionMessages": "messages",
    "SidecarLayout": "workspace",
    "TdsBatchResult": "tds",
    "TdsControllerCatalogue": "tds",
    "TdsControllerResult": "tds",
    "TdsControllerTarget": "tds",
    "TdsControllerTrace": "tds",
    "TdsControllerVariables": "tds",
    "TdsRunRequest": "tds",
    "TdsTraceSeries": "tds",
    "TdsTraces": "tds",
    "TopologyEntry": "topology",
    "TopologyParamMeta": "elements",
    "TopologySchema": "elements",
    "TopologySummary": "topology",
    "UploadedWorkspaceFile": "workspace",
    "VersionInfo": "version",
    "WorkspaceFile": "workspace",
    "WorkspaceFileList": "workspace",
}

# The discriminated-union specs the one-file module imported for its request body and
# so exposed; they belong to ``tensa.core.disturbance``.
RE_EXPORTED = ("AlterSpec", "FaultSpec", "ToggleSpec")


def _modules() -> list[str]:
    return sorted(m.name for m in pkgutil.iter_modules(schemas_pkg.__path__))


def _models_defined_by(module: str) -> list[type[BaseModel]]:
    home = importlib.import_module(f"tensa.api.schemas.{module}")
    return [
        obj
        for obj in vars(home).values()
        if isinstance(obj, type)
        and issubclass(obj, BaseModel)
        and obj.__module__ == home.__name__
    ]


@pytest.mark.unit
@pytest.mark.parametrize(("name", "module"), sorted(SURFACE.items()))
def test_a_name_the_module_defined_is_the_object_its_new_module_defines(
    name: str, module: str
) -> None:
    home = importlib.import_module(f"tensa.api.schemas.{module}")
    assert hasattr(schemas_pkg, name)
    assert getattr(schemas_pkg, name) is getattr(home, name)
    assert name in schemas_pkg.__all__


@pytest.mark.unit
@pytest.mark.parametrize("name", RE_EXPORTED)
def test_the_disturbance_specs_are_still_reachable_from_the_package(name: str) -> None:
    assert getattr(schemas_pkg, name) is getattr(disturbance, name)
    assert name in schemas_pkg.__all__


@pytest.mark.unit
def test_every_name_in_all_is_there() -> None:
    assert len(set(schemas_pkg.__all__)) == len(schemas_pkg.__all__)
    for name in schemas_pkg.__all__:
        assert hasattr(schemas_pkg, name), name


@pytest.mark.unit
@pytest.mark.parametrize("module", _modules())
def test_a_model_a_module_defines_is_exported_from_the_package(module: str) -> None:
    # A model added to a module has to be added to ``__init__`` too, or a caller that
    # imports it from ``tensa.api.schemas`` finds nothing.
    for model in _models_defined_by(module):
        assert getattr(schemas_pkg, model.__name__) is model
        assert model.__name__ in schemas_pkg.__all__


@pytest.mark.unit
def test_no_two_modules_define_a_model_of_the_same_name() -> None:
    # OpenAPI names a component after its class; a second class of the same name would
    # be given a qualified name and change the generated client types.
    names = [model.__name__ for module in _modules() for model in _models_defined_by(module)]
    assert len(names) == len(set(names))

