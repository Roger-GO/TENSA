"""PSS/E ``.raw`` steady-state clone writer (Unit 21 / KTD-9).

The ``.raw`` file holds **no** dynamic-controller params — those live in the
paired ``.dyr``. A clone edit for a controller param therefore never routes to
``.raw``; if this writer is ever invoked it raises :class:`CloneEditError`
with a "use edit-element" recovery hint, directing the user to the existing
``PUT /sessions/{id}/elements/{model}/{idx}`` route for static-topology edits
(bus Vn, line impedance, …).

Per the spike: ``recovery.ui_hint: 'use-edit-element'``. The orthogonal
``ui_hint`` axis is not yet a structured field on ``RecoveryDescriptor``
(KTD-3 models only ``kind`` + ``label``), so the hint rides in the detail
string.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tensa.core.errors import CloneEditError


def apply_edit(
    file_path: str | Path,
    model: str,
    idx: str,
    param: str,
    value: Any,
) -> None:
    """Always raise — controllers never live in ``.raw``.

    The ``value`` / ``idx`` arguments exist only to satisfy the uniform
    writer signature; no edit is ever applied here.
    """
    name = Path(file_path).name
    raise CloneEditError(
        f"controller param {model}.{param} cannot be edited in the .raw clone "
        f"{name!r}: dynamic-controller params live in the paired .dyr file, "
        "and static-topology edits (bus Vn, line impedance) go through the "
        "edit-element route. recovery.ui_hint=use-edit-element"
    )
