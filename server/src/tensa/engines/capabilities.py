"""What ``GET /engines`` reports for each engine.

The shapes of section 7 of ``design/multiengine/spec.md``, first scope: name,
availability, versions, the formats it reads and writes, its routines, the ops its
worker answers, and whether it edits a case. This module imports only
``importlib.metadata`` for the ANDES version, never ``andes`` itself, so the server
process does not load ANDES to answer.
"""

from __future__ import annotations

import importlib.metadata
from typing import Any

from tensa.engines.ops import ENGINE_NAMES, ENGINE_OPS
from tensa.engines.registry import engine_unavailable_reason


def engine_capabilities(name: str) -> dict[str, Any]:
    """The capability block of one engine. An unknown name raises ``ValueError``."""
    reason = engine_unavailable_reason(name)
    if reason is not None:
        return {
            "name": name,
            "available": False,
            "unavailable_reason": reason,
            "versions": {},
            "formats": {"read": [], "write": []},
            "routines": [],
            "ops": [],
            "editing": False,
        }
    if name == "sienna":
        return {
            "name": name,
            "available": True,
            "unavailable_reason": None,
            "versions": {},
            "formats": {"read": ["psse-raw", "psse-dyr", "matpower"], "write": []},
            "routines": ["pflow"],
            "ops": sorted(ENGINE_OPS[name]),
            "editing": False,
        }
    return {
        "name": name,
        "available": True,
        "unavailable_reason": None,
        "versions": {"andes": importlib.metadata.version("andes")},
        "formats": {
            "read": ["xlsx", "json", "psse-raw", "psse-dyr", "matpower"],
            "write": ["xlsx", "json", "psse-raw", "matpower"],
        },
        "routines": ["pflow", "tds", "eig", "cpf", "se"],
        "ops": sorted(ENGINE_OPS[name]),
        "editing": True,
    }


def all_engine_capabilities() -> list[dict[str, Any]]:
    """Every engine's capability block, in ``ENGINE_NAMES`` order."""
    return [engine_capabilities(name) for name in ENGINE_NAMES]
