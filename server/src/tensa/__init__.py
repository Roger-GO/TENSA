"""tensa — web-based GUI substrate for the ANDES power-system simulator.

The package is a Python wrapper around ANDES plus the FastAPI HTTP/WebSocket
surface and the React UI it serves. The substrate is independently usable:
agents, SDKs, and curl can drive ANDES through it without any UI.

Trust model (canonical statement; AGENTS.md links here)
-------------------------------------------------------

* The local OS user is trusted to execute arbitrary code. Case files contain
  Python expressions evaluated by ANDES at parse time, and the local user is
  the only authorized actor.
* Loopback web origins from random browser tabs are NOT trusted. Defended via
  Host/Origin pure-ASGI middleware + precise CORS allow-list (no wildcards,
  no ``null``, no extension origins).
* There is NO authentication. The server binds to loopback by default; any
  process on the local machine can reach the API. Binding to a non-loopback
  interface exposes the API to the whole network and emits a stderr warning.
* Third-party case files are NOT trusted by the system but ARE trusted by the
  user when they choose to load them — analogous to opening an .xlsx in
  Excel. ANDES's secondary file-read machinery (``addfile=``, dynamic-model
  ``path=``) is logged via ``sys.audit`` as best-effort visibility (Python-level
  only — does not catch C-extension reads from numpy/pandas/openpyxl). For
  actual workspace enforcement, kernel-level controls (Linux seccomp,
  Landlock) are required, and they are not implemented.
* On Windows, path canonicalization is best-effort: the workspace boundary is
  not enforced for ANDES-internal reads, and a stderr warning is emitted at
  startup.

See ``AGENTS.md`` and ``SECURITY.md``.
"""

from importlib import metadata as _metadata

# Reported when tensa is not installed (e.g. run from a bare source tree with
# ``PYTHONPATH``): a valid PEP 440 local version that sorts below any release.
_FALLBACK_VERSION = "0+unknown"


def _resolve_version() -> str:
    """The installed distribution's version, or ``_FALLBACK_VERSION``.

    ``server/pyproject.toml`` is the single source of the version; the
    package metadata written at install time carries it here. An editable
    install keeps the version it was installed with, so re-run
    ``pip install -e ./server`` after a version bump.
    """
    try:
        return _metadata.version("tensa") or _FALLBACK_VERSION
    except _metadata.PackageNotFoundError:
        return _FALLBACK_VERSION


# Feeds the OpenAPI ``info.version`` and the ``tensa_version`` stamp on
# bundle manifests and snapshot sidecars.
__version__ = _resolve_version()


def andes_version() -> str:
    """Installed ANDES version from package metadata, or ``"unknown"``.

    Deliberately avoids ``import andes`` (seconds of import time), so
    ``tensa --version`` and the version route stay instant.
    """
    try:
        return _metadata.version("andes")
    except _metadata.PackageNotFoundError:
        return "unknown"
