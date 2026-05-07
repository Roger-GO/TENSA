"""Unit tests for the per-launch token + token-file primitives."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from andes_app.security.token import (
    TOKEN_NUM_BYTES,
    constant_time_eq,
    generate_token,
    install_token,
    write_token_file,
)


@pytest.mark.unit
def test_generate_token_returns_hex_string_of_expected_length() -> None:
    token = generate_token()
    assert isinstance(token, str)
    assert len(token) == TOKEN_NUM_BYTES * 2  # 32 bytes → 64 hex chars
    int(token, 16)  # must parse as hex


@pytest.mark.unit
def test_generate_token_is_unique_per_call() -> None:
    a = generate_token()
    b = generate_token()
    assert a != b


@pytest.mark.unit
def test_write_token_file_creates_file_with_mode_0600(tmp_path: Path) -> None:
    target = tmp_path / "subdir" / "run-123.token"
    written_path = write_token_file("deadbeef", target)
    assert written_path == target
    assert target.read_text() == "deadbeef"
    # File mode is 0600
    file_mode = stat.S_IMODE(os.stat(target).st_mode)
    assert file_mode == 0o600, f"expected 0600, got {oct(file_mode)}"


@pytest.mark.unit
def test_write_token_file_creates_parent_dir_mode_0700(tmp_path: Path) -> None:
    target = tmp_path / "fresh-dir" / "run-1.token"
    write_token_file("x" * 64, target)
    parent = target.parent
    assert parent.is_dir()
    dir_mode = stat.S_IMODE(os.stat(parent).st_mode)
    assert dir_mode == 0o700, f"expected dir mode 0700, got {oct(dir_mode)}"


@pytest.mark.unit
def test_install_token_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "fresh" / "run.token"
    handle = install_token(path=target)
    assert handle.path == target
    assert target.read_text() == handle.value
    assert len(handle.value) == TOKEN_NUM_BYTES * 2


@pytest.mark.unit
def test_constant_time_eq_returns_true_for_equal_strings() -> None:
    assert constant_time_eq("abc", "abc")


@pytest.mark.unit
def test_constant_time_eq_returns_false_for_different_strings() -> None:
    assert not constant_time_eq("abc", "abd")
    # Different lengths
    assert not constant_time_eq("abc", "abcd")
