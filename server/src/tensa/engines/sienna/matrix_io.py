"""Reading a matrix the Julia side wrote to a file.

The Julia modules (``TensaSiennaDyn`` for a reduced state matrix,
``TensaSiennaNet`` for the network matrices) write a dense matrix as raw
``Float64`` in column-major order (Julia's own order, ``write(io, matrix)``,
no header) to a file under the session's scratch folder. This module reads
such a file back, so every unit that takes a matrix from Julia shares the one
reader. Nothing here starts Julia or imports an engine.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import numpy.typing as npt

from tensa.core.errors import AndesAppError, EigComputationError


def read_matrix(
    path: Path,
    rows: int,
    cols: int,
    *,
    what: str = "state matrix",
    error: type[AndesAppError] = EigComputationError,
) -> npt.NDArray[np.float64]:
    """The ``rows`` by ``cols`` matrix held by ``path`` as raw Float64,
    column-major.

    Raises ``error`` (by default :class:`EigComputationError`, the failure of
    the analysis that wrote the file) naming ``what`` when the file is missing,
    not a whole number of Float64 values, or holds another count than
    ``rows * cols``: the file and the answer that named it disagree, so a
    truncated or swapped file is a clear error and not a mis-shaped answer.
    """
    try:
        data = np.fromfile(path, dtype=np.float64)
    except (OSError, ValueError) as exc:
        raise error(f"the {what} file could not be read: {exc}") from exc
    expected = rows * cols
    if data.size != expected:
        raise error(f"the {what} file holds {data.size} values, expected {expected}")
    return data.reshape((rows, cols), order="F")
