"""Unit tests for ``tensa.engines.sienna.matrix_io.read_matrix``."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from tensa.core.errors import EigComputationError
from tensa.engines.sienna.matrix_io import read_matrix


def test_reads_a_column_major_matrix(tmp_path: Path) -> None:
    # The matrix [[1, 3], [2, 4]] written as Julia writes it, column by column.
    matrix = np.array([[1.0, 3.0], [2.0, 4.0]])
    path = tmp_path / "m.bin"
    path.write_bytes(np.asarray(matrix, dtype=np.float64).tobytes(order="F"))
    read = read_matrix(path, 2, 2)
    assert read.dtype == np.float64
    assert read.tolist() == [[1.0, 3.0], [2.0, 4.0]]


def test_a_rectangular_matrix(tmp_path: Path) -> None:
    matrix = np.arange(6, dtype=np.float64).reshape((2, 3), order="F")
    path = tmp_path / "m.bin"
    path.write_bytes(matrix.tobytes(order="F"))
    assert read_matrix(path, 2, 3).tolist() == matrix.tolist()


def test_a_wrong_length_is_a_clear_error(tmp_path: Path) -> None:
    path = tmp_path / "m.bin"
    path.write_bytes(np.arange(5, dtype=np.float64).tobytes())
    with pytest.raises(EigComputationError, match="holds 5 values, expected 4"):
        read_matrix(path, 2, 2)


def test_a_missing_file_is_a_clear_error(tmp_path: Path) -> None:
    with pytest.raises(EigComputationError, match="could not be read"):
        read_matrix(tmp_path / "missing.bin", 2, 2)
