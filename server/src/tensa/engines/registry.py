"""Engine name to runtime factory, and why an engine is not available.

The registry holds a module path string per engine, not the runtime itself, so the
server process never imports an engine: a worker imports the module lazily when it
starts. An engine with no entry is declared but not part of this build.
"""

from __future__ import annotations

import importlib

from tensa.core.errors import EngineUnavailableError
from tensa.engines.base import EngineRuntime
from tensa.engines.ops import ENGINE_NAMES

_RUNTIME_PATHS = {
    "andes": "tensa.core.worker:andes_runtime",
    "sienna": "tensa.engines.sienna.runtime:sienna_runtime",
}


def load_runtime(name: str) -> EngineRuntime:
    """Import the module the registry names for ``name`` and call its factory.

    An engine with no entry, or one whose environment says it cannot start,
    raises :class:`EngineUnavailableError` with the environment's reason.
    """
    path = _RUNTIME_PATHS.get(name)
    if path is None:
        reason = engine_unavailable_reason(name)
        if reason is None:
            raise EngineUnavailableError(name, "no runtime is registered for it")
        raise EngineUnavailableError(name, reason)
    reason = engine_unavailable_reason(name)
    if reason is not None:
        raise EngineUnavailableError(name, reason)
    module_name, _, factory_name = path.partition(":")
    module = importlib.import_module(module_name)
    factory = getattr(module, factory_name)
    runtime = factory()
    if not isinstance(runtime, EngineRuntime):
        raise TypeError(f"{path} returned {type(runtime).__name__}, not an EngineRuntime")
    return runtime


def engine_unavailable_reason(name: str) -> str | None:
    """Why the engine ``name`` cannot start a session, or ``None`` when it can.

    An unknown name raises ``ValueError``.
    """
    if name not in ENGINE_NAMES:
        raise ValueError(f"unknown engine: {name!r}")
    if name == "sienna":
        from tensa.engines.sienna.environment import sienna_unavailable_reason

        return sienna_unavailable_reason()
    return None
