"""The runtime a worker loads for its engine.

The unit of an engine is a handler table, not a class (``design/multiengine/spec.md``,
section 9): a factory for its per-session state, a dispatch over the ops it has with
the wire shapes the worker already uses, and a warm-up function. The existing
handlers of ``tensa.core.worker`` become the ANDES runtime without being rewritten;
``tensa.core.wrapper.Wrapper`` is its state.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class EngineRuntime:
    """What a worker needs to serve one engine.

    ``make_state`` builds the per-session state from the worker's ``workspace``,
    ``session_id`` and ``owner_pid``. ``dispatch`` answers one op on that state:
    ``(state, op, args, abort_event, data connection, seq)`` and returns the reply
    payload. ``warm_up`` imports what the first command would otherwise import,
    while the worker has nothing else to do.
    """

    name: str
    make_state: Callable[[str | None, str | None, int | None], Any]
    dispatch: Callable[[Any, str, dict[str, Any], Any, Any, Any], Any]
    warm_up: Callable[[], None]
