"""Per-launch authentication token.

The token is 32 bytes of cryptographic randomness, hex-encoded (64 chars).
Generated at process start, written to a file with mode ``0600`` in a directory
created at mode ``0700`` (default ``~/.andes-app/run-<pid>.token``). Stderr
prints only the *path* to the token file — never the value. The token is
valid until process exit; daily rotation is deferred to the SaaS phase.

The token is required in the ``X-Andes-Token`` HTTP header for every request
(see ``api.auth``). For the WebSocket streaming channel, it is sent as the
first message (``{"type": "auth", "token": "..."}``) within the auth deadline.
"""

from __future__ import annotations

import contextlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

# 32 bytes = 256 bits of entropy, well above any reasonable brute-force budget
# for the lifetime of a single process.
TOKEN_NUM_BYTES = 32


@dataclass(frozen=True)
class TokenFile:
    """A live token + its on-disk file location.

    The path is what gets printed to stderr at startup. The value is what's
    written to the file (mode ``0600``) for the user (or the curl walkthrough)
    to read.
    """

    value: str
    path: Path


def _ensure_dir_mode_0700(directory: Path) -> None:
    """Create ``directory`` if missing with mode ``0700``. If it already
    exists with broader permissions, this is a no-op (we don't tighten user
    directories that already exist).

    The token file itself is always written ``0600`` regardless of dir mode.
    """
    if directory.exists():
        return
    # ``mkdir(mode=0o700)`` is umask-aware on POSIX — the actual mode is
    # ``mode & ~umask``. To be sure, follow with an explicit chmod.
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with contextlib.suppress(OSError):  # Windows / non-POSIX has no chmod equivalent
        os.chmod(directory, 0o700)


def generate_token() -> str:
    """Return a fresh hex-encoded random token of ``TOKEN_NUM_BYTES`` bytes."""
    return secrets.token_hex(TOKEN_NUM_BYTES)


def write_token_file(token: str, path: Path) -> Path:
    """Write ``token`` to ``path`` with mode ``0600``. Creates the parent
    directory at mode ``0700`` if missing. Returns the canonical path.
    """
    _ensure_dir_mode_0700(path.parent)
    # Use os.open with O_WRONLY|O_CREAT|O_TRUNC and mode 0600 directly so we
    # don't briefly expose a wider-mode file under any race condition.
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(str(path), flags, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    # Be explicit even if umask was permissive
    with contextlib.suppress(OSError):  # Windows / non-POSIX
        os.chmod(path, 0o600)
    return path


def default_token_path() -> Path:
    """Default location: ``~/.andes-app/run-<pid>.token``."""
    return Path.home() / ".andes-app" / f"run-{os.getpid()}.token"


def install_token(*, path: Path | None = None) -> TokenFile:
    """Generate a fresh token, write it to the chosen path, return the
    ``TokenFile`` so the CLI can print the path to stderr."""
    actual_path = path or default_token_path()
    token = generate_token()
    write_token_file(token, actual_path)
    return TokenFile(value=token, path=actual_path)


def constant_time_eq(a: str, b: str) -> bool:
    """Constant-time string comparison to defeat timing attacks on token
    validation."""
    return secrets.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
