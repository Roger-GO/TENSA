"""Portable file-name validation.

Workspaces, reproducibility bundles and snapshots move between Linux, macOS and
Windows, and a name that is an ordinary file on one OS can be something else on
another: ``CON`` and ``nul.txt`` are DOS devices, ``C:evil.raw`` switches drive,
``case.raw:stream`` addresses an NTFS alternate data stream, and Windows strips a
trailing dot or space so ``case.raw.`` silently aliases ``case.raw``.

``portable_name_problem`` applies the Windows rules on every platform, so a name
accepted here is a plain file name wherever the file ends up. It checks ONE path
component; separators are rejected, not interpreted, and containment inside the
workspace is the job of ``security.paths``.
"""

from __future__ import annotations

# Characters Windows refuses in a file name (``/`` and ``\`` are separators).
_WINDOWS_INVALID_CHARS = frozenset('<>:"/\\|?*')

# Legacy DOS device names, as listed in Microsoft's "Naming Files, Paths, and
# Namespaces" (including the superscript digits and COM0/LPT0 that newer Windows
# releases also reserve).
_WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"{device}{digit}" for device in ("COM", "LPT") for digit in "0123456789¹²³"}
)


def is_windows_reserved_name(name: str) -> bool:
    """True when Windows resolves ``name`` to a DOS device, whatever its extension.

    The device name is everything before the first dot, trailing spaces ignored
    and case folded, so ``CON``, ``con.txt``, ``Nul.tar.gz`` and ``COM1 .raw``
    all name a device rather than a file.
    """
    stem = name.split(".", 1)[0].rstrip(" ")
    return stem.upper() in _WINDOWS_RESERVED_NAMES


def portable_name_problem(name: str) -> str | None:
    """Why ``name`` is not a safe single file name on every platform, or ``None``.

    The return value is a predicate that reads after "name ", for example
    ``"ends with a dot or space"``, so callers can embed it in their own error.
    """
    if not name:
        return "is empty"
    for ch in name:
        if ord(ch) < 0x20:
            return "contains a control character"
        if ch == ":":
            return "contains ':' (a Windows drive prefix or alternate data stream)"
        if ch in _WINDOWS_INVALID_CHARS:
            return f"contains {ch!r}, which Windows file names cannot hold"
    if name[-1] in ". ":
        return "ends with a dot or space, which Windows strips"
    if is_windows_reserved_name(name):
        return "is a reserved Windows device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9)"
    return None
