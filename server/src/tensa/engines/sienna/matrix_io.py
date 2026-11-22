"""Reading a matrix the Julia side wrote to a file.

``TensaSiennaDyn`` writes a reduced state matrix as raw ``Float64`` in
column-major order (Julia's own order) to a file under the session's scratch
folder. This module reads such a file back, so every unit that takes a matrix
from Julia shares the one reader. Nothing here starts Julia or imports an
engine.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import numpy.typing as npt

from tensa.core.errors import EigComputationError


def read_matrix(path: Path, rows: int, cols: int) -> npt.NDArray[np.float64]:
    """The ``rows`` by ``cols`` matrix held by ``path`` as raw Float64,
    column-major.

    Raises :class:`EigComputationError` when the file is missing, not a whole
    number of Float64 values, or holds another count than ``rows * cols``: the
    file and the answer that named it disagree, which is a failure of the
    analysis that wrote them, not of the request.
    """
    try:
        data = np.fromfile(path, dtype=np.float64)
    except OSError as exc:
        raise EigComputationError(
            f"the state matrix file could not be read: {exc}"
        ) from exc
    expected = rows * cols
    if data.size != expected:
        raise EigComputationError(
            f"the state matrix file holds {data.size} values, expected {expected}"
        )
    return data.reshape((rows, cols), order="F")
