"""Hatch build hook: bundle the built web UI into the wheel and the sdist.

The single-page app is built into ``web/dist``, outside this package's root, so
hatch's static ``force-include`` table cannot serve every build. It would also
break the wheel built from an sdist, which has no ``../web/dist`` next to it.
This hook picks the source per build:

* **wheel, from the repository**: ``../web/dist`` is copied to ``tensa/static``.
* **sdist, from the repository**: ``../web/dist`` is copied to
  ``src/tensa/static``, inside the archive, so the sdist carries the UI.
* **wheel, from an sdist**: ``src/tensa/static`` is already there and ships as
  part of the package, so there is nothing to add.
* **editable install**: nothing is added. ``tensa.api.app`` serves ``../web/dist``
  straight from the checkout when ``tensa/static`` is absent, and a copy made at
  install time would only go stale after the next ``pnpm build``.

Source maps (``*.map``) are left out of both archives. They are about 10 MB of
debugging aid the served page does not need.

A build that cannot find the UI fails loudly: it never produces a package that
serves a blank page. Run ``pnpm build`` in ``web/`` first.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.config import BuilderConfig
from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# Where the UI lands, relative to the root of each archive.
SDIST_TARGET = "src/tensa/static"
WHEEL_TARGET = "tensa/static"

# Not shipped: the browser only fetches a source map when dev tools are open.
SKIPPED_SUFFIXES = (".map",)


def bundled_ui_files(dist: Path, target: str) -> dict[str, str]:
    """Map each file of the built UI under ``dist`` to its path inside the archive.

    Files are listed one by one (not as a directory) so that source maps can be
    skipped and so that hatch treats each target as taken, which keeps a stray
    copy of the UI in the source tree from landing in the archive twice.
    """
    return {
        str(path): f"{target}/{path.relative_to(dist).as_posix()}"
        for path in sorted(dist.rglob("*"))
        if path.is_file() and path.suffix not in SKIPPED_SUFFIXES
    }


class UiBundleHook(BuildHookInterface[BuilderConfig]):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if self.target_name == "wheel" and version == "editable":
            return

        root = Path(self.root)
        dist = root.parent / "web" / "dist"
        if (dist / "index.html").is_file():
            target = SDIST_TARGET if self.target_name == "sdist" else WHEEL_TARGET
            build_data["force_include"].update(bundled_ui_files(dist, target))
            return

        # Building from an sdist: the UI came along as part of the package.
        if (root / SDIST_TARGET / "index.html").is_file():
            return

        msg = (
            f"The web UI is not built: {dist / 'index.html'} does not exist and the "
            f"source tree has no {SDIST_TARGET}/. Run `pnpm install && pnpm build` in "
            "web/ and build again."
        )
        raise FileNotFoundError(msg)
