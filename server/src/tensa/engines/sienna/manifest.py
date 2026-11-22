"""The Sienna environment's package versions, read from its Manifest without Julia.

``GET /engines`` reports what a Sienna session would run with (spec section 7).
The answer is in the project folder's ``Manifest.toml``: one ``[[deps.<name>]]``
table per package with a ``version`` string, and the ``julia_version`` the
environment was resolved for near the top. Reading it costs nothing and never
starts Julia, which is what lets the endpoint stay instant.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from tensa.engines.sienna import environment

# The packages ``GET /engines`` reports, in the order the spec's example lists
# them after ``julia``. One the Manifest does not hold is left out.
REPORTED_PACKAGES = (
    "PowerSystems",
    "PowerFlows",
    "PowerNetworkMatrices",
    "PowerSimulationsDynamics",
    "PowerSimulations",
)


def sienna_versions(project: Path | None = None) -> dict[str, str]:
    """The versions of the Sienna environment at ``project`` (default:
    ``environment.sienna_project()``), by package, with ``julia`` first.

    An empty dict when the Manifest is missing, unreadable, or not TOML:
    ``GET /engines`` then reports no versions rather than failing.
    """
    if project is None:
        project = environment.sienna_project()
    try:
        data = tomllib.loads((project / "Manifest.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    versions: dict[str, str] = {}
    julia_version = data.get("julia_version")
    if isinstance(julia_version, str):
        versions["julia"] = julia_version
    deps = data.get("deps")
    if isinstance(deps, dict):
        for name in REPORTED_PACKAGES:
            entries = deps.get(name)
            # A Manifest holds each package as a list of one table.
            if (
                isinstance(entries, list)
                and entries
                and isinstance(entries[0], dict)
                and isinstance(entries[0].get("version"), str)
            ):
                versions[name] = entries[0]["version"]
    return versions
