"""Per-format clone-on-write file editors (Unit 21 / KTD-9).

Each writer takes a ``(file_path, model, idx, param, value)`` edit and modifies
the clone file **in place**, using the machine-readable edit-op index produced
by the Unit-0 spike (``clone_write_index.json``, shipped alongside this
package). Writers never hardcode field positions — every column / field offset
is read from the index.

Three formats:

- :func:`tensa.core.clone_writers.xlsx_writer.apply_edit` — ANDES-native
  ``.xlsx`` (one sheet per model, one row per device, columns are param names).
- :func:`tensa.core.clone_writers.dyr_writer.apply_edit` — PSS/E ``.dyr``
  dynamics. Edits the target token *in place* preserving every sibling record
  (see the spike's CRITICAL writer requirement).
- :func:`tensa.core.clone_writers.raw_writer.apply_edit` — PSS/E ``.raw``
  steady-state. Controllers never live in ``.raw``; invoking it for a
  controller param raises :class:`CloneEditError` with a "use edit-element"
  hint.

The public dispatch entry point is :func:`apply_edit`, which routes by the
clone file's extension. The :class:`DyrLocator` carries the ``(bus, id)``
resolved by the :class:`~tensa.core.clone_manager.CloneManager` from the
loaded System so the ``.dyr`` writer can find the right record.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any

from tensa.core.errors import CloneEditError

__all__ = [
    "CLONE_WRITE_INDEX_FILENAME",
    "DyrLocator",
    "apply_edit",
    "index_entry_for",
    "load_clone_write_index",
]


CLONE_WRITE_INDEX_FILENAME = "clone_write_index.json"


@dataclass(frozen=True)
class DyrLocator:
    """Locator the ``.dyr`` writer matches a record on.

    The clone manager resolves ``bus`` (and, where available, the PSS/E
    circuit ``id``) from the loaded System before dispatching to the ``.dyr``
    writer. ANDES does not retain the PSS/E circuit ID for most controller
    models, so ``id`` defaults to ``"1"`` (the dominant case); the BUS field
    disambiguates sibling devices of the same model in every bundled case.
    """

    bus: str
    id: str = "1"


@lru_cache(maxsize=1)
def load_clone_write_index() -> dict[str, Any]:
    """Load + cache the ``(model, param) -> {xlsx, dyr}`` edit-op index.

    The index ships inside this package (a copy of the Unit-0 spike's
    ``docs/spikes/2026-05-29-clone-write-index.json``) so the writers are
    self-contained and wheel-safe — no dependency on the repo's ``docs/``
    tree at runtime.
    """
    try:
        text = (
            resources.files("tensa.core.clone_writers")
            .joinpath(CLONE_WRITE_INDEX_FILENAME)
            .read_text(encoding="utf-8")
        )
    except (OSError, ModuleNotFoundError) as exc:  # pragma: no cover — packaging guard
        raise CloneEditError(
            f"clone-write index {CLONE_WRITE_INDEX_FILENAME!r} is missing from "
            "the package; cannot resolve edit-op positions"
        ) from exc
    data: dict[str, Any] = json.loads(text)
    return data


def index_entry_for(model: str, param: str) -> dict[str, Any]:
    """Return the ``params[param]`` index entry for ``(model, param)``.

    Raises :class:`CloneEditError` when the model or param is absent from the
    index — the route layer has already whitelist-validated ``(model, param)``,
    so a miss here means a drift between the live whitelist and the spike index
    (a packaging / regeneration bug), surfaced as a clean 422 rather than a
    KeyError.
    """
    index = load_clone_write_index()
    models = index.get("models", {})
    model_entry = models.get(model)
    if not isinstance(model_entry, dict):
        raise CloneEditError(
            f"model {model!r} is not in the clone-write index; the param is "
            "read-only for clone editing (load the case as .xlsx to edit it)"
        )
    params = model_entry.get("params", {})
    param_entry = params.get(param)
    if not isinstance(param_entry, dict):
        raise CloneEditError(
            f"param {param!r} on model {model!r} is not in the clone-write "
            "index; the param is read-only for clone editing"
        )
    return param_entry


def apply_edit(
    file_path: str | Path,
    model: str,
    idx: str,
    param: str,
    value: Any,
    *,
    locator: DyrLocator | None = None,
) -> None:
    """Dispatch a clone edit to the right format writer by file extension.

    ``.xlsx`` → the openpyxl writer; ``.dyr`` → the in-place PSS/E-dynamics
    writer (requires ``locator``); ``.raw`` → the writer that rejects
    controller params with a "use edit-element" hint. An unrecognised
    extension raises :class:`CloneEditError`.
    """
    # Local imports avoid a circular import at package-init time (each writer
    # module imports helpers from this ``__init__``).
    from tensa.core.clone_writers import dyr_writer, raw_writer, xlsx_writer

    suffix = Path(file_path).suffix.lower()
    if suffix == ".xlsx":
        xlsx_writer.apply_edit(file_path, model, idx, param, value)
    elif suffix == ".dyr":
        dyr_writer.apply_edit(file_path, model, idx, param, value, locator=locator)
    elif suffix == ".raw":
        raw_writer.apply_edit(file_path, model, idx, param, value)
    else:
        raise CloneEditError(
            f"unsupported clone file format {suffix!r}; supported: "
            ".xlsx, .dyr, .raw"
        )
