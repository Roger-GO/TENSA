"""tensa — web-based GUI substrate for the ANDES power-system simulator.

This is Phase A: the Python wrapper around ANDES + FastAPI HTTP/WebSocket
surface. The substrate is independently usable — agents, SDKs, and curl can
drive ANDES through it without any UI. v0.1+ adds a React UI in a separate
plan; this package is the foundation it sits on.

Trust model (canonical statement; AGENTS.md links here)
-------------------------------------------------------
v0.1 trust model:

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
  Landlock) are required and are deferred to the SaaS phase.
* On Windows, path canonicalization is best-effort: the workspace boundary is
  not enforced for ANDES-internal reads, and a stderr warning is emitted at
  startup.

See ``AGENTS.md`` and ``docs/plans/2026-05-07-001-feat-tensa-phase-a-substrate-plan.md``
for the full design.
"""

__version__ = "0.1.0.dev0"
