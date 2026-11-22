"""The engine seam: which engines a session can be created for, and what each can do.

A session is created for one engine and keeps it (``design/multiengine/spec.md``,
section 2). This package holds the data and the registry behind that: the engine
names, the ops each engine's worker answers, the runtime a worker loads for its
engine, and the capabilities ``GET /engines`` reports. Nothing here imports ANDES
or an engine: the registry reaches a runtime through a module path string, so the
server process never loads one.
"""

from tensa.engines.base import EngineRuntime
from tensa.engines.capabilities import all_engine_capabilities, engine_capabilities
from tensa.engines.ops import DEFAULT_ENGINE, ENGINE_NAMES, ENGINE_OPS, engines_with_op, is_engine
from tensa.engines.registry import engine_unavailable_reason, load_runtime

__all__ = [
    "DEFAULT_ENGINE",
    "ENGINE_NAMES",
    "ENGINE_OPS",
    "EngineRuntime",
    "all_engine_capabilities",
    "engine_capabilities",
    "engine_unavailable_reason",
    "engines_with_op",
    "is_engine",
    "load_runtime",
]
