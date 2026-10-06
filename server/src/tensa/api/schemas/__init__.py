"""Pydantic v2 request / response models for the HTTP API.

Every field has an explicit ``description`` (R25 acceptance: the
OpenAPI-to-MCP audit asserts no field has an empty description). Every error
response is shaped as ``ProblemDetails`` per RFC 7807.

The models live in one module per domain, beside this file and named for the
routes that use them where there is one: ``errors``, ``jobs``, ``messages``,
``sessions``, ``topology``, ``cases``, ``elements``, ``pflow``, ``disturbances``,
``clone``, ``tds``, ``metrics``, ``comtrade``, ``workspace`` and ``version``. A model
that another domain builds on (``TopologySummary``, ``ProblemDetails``) is imported
from the module that defines it. Every name the single-file module defined is
importable from here.
"""

from __future__ import annotations

from tensa.api.schemas.cases import (
    AlterableParamsResponse,
    BlankSystemResponse,
    LoadCaseRequest,
    SaveCaseRequest,
    SaveCaseResponse,
)
from tensa.api.schemas.clone import (
    CloneDiffPair,
    CloneDiffResponse,
    CloneEditRequest,
    CloneEditResponse,
    CloneInitResponse,
    CloneResetResponse,
    CloneSaveAsRequest,
    CloneSaveAsResponse,
)
from tensa.api.schemas.comtrade import (
    MAX_COMTRADE_VALUES,
    ComtradeChannelSeries,
    ComtradeExportRequest,
)
from tensa.api.schemas.disturbances import (
    AddDisturbancesRequest,
    AddDisturbancesResponse,
    DisturbanceAck,
)
from tensa.api.schemas.elements import (
    AddElementRequest,
    DeleteBlockedResponse,
    DeletedDisturbance,
    DeleteElementResponse,
    EditElementRequest,
    ElementCreated,
    TopologyParamMeta,
    TopologySchema,
)
from tensa.api.schemas.errors import (
    RECOVERY_DEFAULT_LABELS,
    ProblemDetails,
    RecoveryDescriptor,
    RecoveryKind,
)
from tensa.api.schemas.jobs import (
    JobKindSchema,
    JobRecordSchema,
    JobStatusSchema,
)
from tensa.api.schemas.messages import (
    MessageLevelSchema,
    SessionMessages,
    SessionMessageSchema,
)
from tensa.api.schemas.metrics import (
    MAX_METRIC_SAMPLES,
    MAX_METRIC_SAMPLES_TOTAL,
    MAX_METRIC_SERIES,
    DampingEstimate,
    MetricExtremum,
    MetricsSeries,
    ResponseMetricsRequest,
    ResponseMetricsResponse,
    SeriesMetrics,
)
from tensa.api.schemas.pflow import (
    GeneratorOutput,
    LineFlow,
    LoadConsumption,
    PflowResult,
    PflowRunRequest,
    PflowSettings,
    PflowSummary,
)
from tensa.api.schemas.sessions import (
    CreateSessionRequest,
    SessionDescriptor,
    SessionList,
)
from tensa.api.schemas.tds import (
    AbortResponse,
    DaeVariableInfo,
    DaeVariableList,
    TdsBatchResult,
    TdsControllerCatalogue,
    TdsControllerResult,
    TdsControllerTarget,
    TdsControllerTrace,
    TdsControllerVariables,
    TdsRunRequest,
    TdsTraces,
    TdsTraceSeries,
)
from tensa.api.schemas.topology import (
    CaseEvent,
    EditStep,
    TopologyEntry,
    TopologySummary,
)
from tensa.api.schemas.version import (
    VersionInfo,
)
from tensa.api.schemas.workspace import (
    BusCoord,
    SidecarLayout,
    UploadedWorkspaceFile,
    WorkspaceFile,
    WorkspaceFileList,
)
from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec

# Every name the single-file module defined, kept importable from here (the three
# disturbance specs were re-exported by it, for the request bodies built on them).
__all__ = [
    "AbortResponse",
    "AddDisturbancesRequest",
    "AddDisturbancesResponse",
    "AddElementRequest",
    "AlterSpec",
    "AlterableParamsResponse",
    "BlankSystemResponse",
    "BusCoord",
    "CaseEvent",
    "CloneDiffPair",
    "CloneDiffResponse",
    "CloneEditRequest",
    "CloneEditResponse",
    "CloneInitResponse",
    "CloneResetResponse",
    "CloneSaveAsRequest",
    "CloneSaveAsResponse",
    "ComtradeChannelSeries",
    "ComtradeExportRequest",
    "CreateSessionRequest",
    "DaeVariableInfo",
    "DaeVariableList",
    "DampingEstimate",
    "DeleteBlockedResponse",
    "DeleteElementResponse",
    "DeletedDisturbance",
    "DisturbanceAck",
    "EditElementRequest",
    "EditStep",
    "ElementCreated",
    "FaultSpec",
    "GeneratorOutput",
    "JobKindSchema",
    "JobRecordSchema",
    "JobStatusSchema",
    "LineFlow",
    "LoadCaseRequest",
    "LoadConsumption",
    "MAX_COMTRADE_VALUES",
    "MAX_METRIC_SAMPLES",
    "MAX_METRIC_SAMPLES_TOTAL",
    "MAX_METRIC_SERIES",
    "MessageLevelSchema",
    "MetricExtremum",
    "MetricsSeries",
    "PflowResult",
    "PflowRunRequest",
    "PflowSettings",
    "PflowSummary",
    "ProblemDetails",
    "RECOVERY_DEFAULT_LABELS",
    "RecoveryDescriptor",
    "RecoveryKind",
    "ResponseMetricsRequest",
    "ResponseMetricsResponse",
    "SaveCaseRequest",
    "SaveCaseResponse",
    "SeriesMetrics",
    "SessionDescriptor",
    "SessionList",
    "SessionMessageSchema",
    "SessionMessages",
    "SidecarLayout",
    "TdsBatchResult",
    "TdsControllerCatalogue",
    "TdsControllerResult",
    "TdsControllerTarget",
    "TdsControllerTrace",
    "TdsControllerVariables",
    "TdsRunRequest",
    "TdsTraceSeries",
    "TdsTraces",
    "ToggleSpec",
    "TopologyEntry",
    "TopologyParamMeta",
    "TopologySchema",
    "TopologySummary",
    "UploadedWorkspaceFile",
    "VersionInfo",
    "WorkspaceFile",
    "WorkspaceFileList",
]
