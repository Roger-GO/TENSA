#!/usr/bin/env python3
"""GUI-parity ledger + fail-closed CI check (v3.1 Unit 16, KTD-12).

The overhaul's "parity" pillar promises that no substrate capability is
CLI-only: every route is reachable from *some* GUI surface, or is explicitly
deferred with a written reason. This script is the enforcement mechanism.

It does two passes:

1. **OpenAPI surface.** Build the app, call ``app.openapi()``, and walk
   ``schema["paths"][path][method]``. Every operation MUST carry
   ``x-andes-app-gui-location`` (injected per-route via ``openapi_extra`` on
   the ``@router.<verb>`` decorator). An operation tagged ``"none"`` MUST also
   carry ``x-andes-app-parity-deferred`` with a non-empty reason. A missing
   tag — or a ``"none"`` with no deferral — fails the check (exit 1). This is
   what catches a *new* route that lands untagged.

2. **Non-OpenAPI surface (adversarial F7 — fail-closed).** The OpenAPI spec
   only captures ``@router.get/.post/.put/.delete`` operations. Raw Starlette
   constructs — ``@router.websocket(...)`` routes and ``app.mount(...)`` static
   mounts — are invisible to ``app.openapi()``. Those are enumerated directly
   off ``app.router.routes`` and each MUST carry a ``# parity-reviewed: <date>``
   marker in its defining source file. A WS route or mount with no such marker
   fails the check. This prevents fail-OPEN on capabilities that live outside
   the documented HTTP surface (the TDS / jobs / sweep WS channels + the SPA
   mount).

On success: prints a one-line ledger summary for CI logs, writes the full
ledger to ``docs/gui-parity-ledger.md``, and exits 0.

The script imports the app with a dummy token; it never binds a socket or
spawns a worker, so it is safe to run in CI alongside (not inside) the
server-spawning acceptance suite.
"""

from __future__ import annotations

import inspect
import re
import sys
import tempfile
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Path bootstrap: allow ``python scripts/check_gui_parity.py`` from the repo
# root without PYTHONPATH set, while still honouring an externally-provided
# PYTHONPATH (CI sets ``PYTHONPATH=src`` from ``server/``).
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_SRC = REPO_ROOT / "server" / "src"
if SERVER_SRC.is_dir() and str(SERVER_SRC) not in sys.path:
    sys.path.insert(0, str(SERVER_SRC))

from starlette.routing import Mount, WebSocketRoute  # noqa: E402

from andes_app.api.app import make_app  # noqa: E402

GUI_LOCATION_KEY = "x-andes-app-gui-location"
DEFERRAL_KEY = "x-andes-app-parity-deferred"
LEDGER_PATH = REPO_ROOT / "docs" / "gui-parity-ledger.md"

# A ``# parity-reviewed: YYYY-MM-DD`` marker in the route's source file.
PARITY_MARKER_RE = re.compile(r"#\s*parity-reviewed:\s*(\d{4}-\d{2}-\d{2})")

# Framework-internal endpoints (OpenAPI/Swagger/ReDoc) are tooling, not
# substrate capabilities — they carry no GUI parity obligation.
_FRAMEWORK_MODULE_PREFIXES = ("fastapi.", "starlette.")


def _build_app() -> Any:
    """Build the app with a dummy token. No socket bind, no worker spawn."""
    workspace = Path(tempfile.mkdtemp(prefix="parity-")) / "ws"
    workspace.mkdir(mode=0o700)
    return make_app(
        expected_token="d" * 64,
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
    )


def _source_has_parity_marker(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    return PARITY_MARKER_RE.search(text) is not None


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def main() -> int:
    app = _build_app()
    failures: list[str] = []

    # --- Pass 1: OpenAPI operations -------------------------------------
    spec = app.openapi()
    # ledger row: (method, path, location, deferral-reason-or-empty)
    openapi_rows: list[tuple[str, str, str, str]] = []
    for path, methods in sorted(spec.get("paths", {}).items()):
        for method, op in methods.items():
            if method == "parameters" or method.startswith("x-"):
                continue
            if not isinstance(op, dict):
                continue
            verb = method.upper()
            location = op.get(GUI_LOCATION_KEY)
            if not location or not str(location).strip():
                failures.append(
                    f"OPENAPI {verb} {path}: missing '{GUI_LOCATION_KEY}' "
                    f"(add openapi_extra={{'{GUI_LOCATION_KEY}': '<surface>'}} "
                    f"to the route decorator)"
                )
                continue
            location = str(location)
            deferral = op.get(DEFERRAL_KEY)
            if location == "none" and (
                not deferral or not str(deferral).strip()
            ):
                failures.append(
                    f"OPENAPI {verb} {path}: tagged 'none' without "
                    f"'{DEFERRAL_KEY}' (a CLI-only route MUST carry an "
                    f"explicit deferral reason)"
                )
                continue
            openapi_rows.append(
                (verb, path, location, str(deferral) if deferral else "")
            )

    # --- Pass 2: non-OpenAPI routes (WS + mounts) -----------------------
    # manual-review row: (kind, path-or-name, source-file, reviewed-flag)
    manual_rows: list[tuple[str, str, str, bool]] = []
    for route in app.router.routes:
        if isinstance(route, WebSocketRoute):
            endpoint = route.endpoint
            module = getattr(endpoint, "__module__", "")
            if module.startswith(_FRAMEWORK_MODULE_PREFIXES):
                continue
            try:
                src_file = Path(inspect.getsourcefile(endpoint) or "")
            except TypeError:
                src_file = Path()
            reviewed = bool(src_file) and _source_has_parity_marker(src_file)
            manual_rows.append(("websocket", route.path, _rel(src_file), reviewed))
            if not reviewed:
                failures.append(
                    f"MANUAL-REVIEW websocket {route.path}: no "
                    f"'# parity-reviewed: <date>' marker in "
                    f"{_rel(src_file)} (WS routes are invisible to OpenAPI; "
                    f"add the marker above the @router.websocket decorator)"
                )
        elif isinstance(route, Mount):
            # The SPA static mount. Its reviewer marker lives in app.py
            # (the make_app factory that registers the mount).
            src_file = REPO_ROOT / "server" / "src" / "andes_app" / "api" / "app.py"
            reviewed = _source_has_parity_marker(src_file)
            name = route.name or "<mount>"
            mount_path = route.path or "/"
            manual_rows.append(("mount", f"{name} ({mount_path})", _rel(src_file), reviewed))
            if not reviewed:
                failures.append(
                    f"MANUAL-REVIEW mount {name} ({mount_path}): no "
                    f"'# parity-reviewed: <date>' marker in {_rel(src_file)}"
                )

    if failures:
        print("GUI-parity check FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    _write_ledger(openapi_rows, manual_rows)

    dist = Counter(loc for _, _, loc, _ in openapi_rows)
    deferred = sum(1 for _, _, loc, _ in openapi_rows if loc == "none")
    dist_summary = ", ".join(f"{loc}={n}" for loc, n in sorted(dist.items()))
    print(
        f"GUI-parity OK: {len(openapi_rows)} OpenAPI routes tagged "
        f"({deferred} deferred 'none'), {len(manual_rows)} non-OpenAPI routes "
        f"reviewed. Distribution: {dist_summary}. Ledger -> {_rel(LEDGER_PATH)}"
    )
    return 0


def _write_ledger(
    openapi_rows: list[tuple[str, str, str, str]],
    manual_rows: list[tuple[str, str, str, bool]],
) -> None:
    """Render the parity ledger as Markdown (route -> GUI location)."""
    dist = Counter(loc for _, _, loc, _ in openapi_rows)
    lines: list[str] = []
    lines.append("# GUI-parity ledger")
    lines.append("")
    lines.append(
        "_Generated by `scripts/check_gui_parity.py` — do not edit by hand._"
    )
    lines.append("")
    lines.append(f"Generated: {date.today().isoformat()}")
    lines.append("")
    lines.append(
        "Every substrate capability must be reachable from a GUI surface, or "
        "be explicitly deferred (`none`) with a written reason. This ledger is "
        "the audit trail; the CI step that regenerates it fails when a new "
        "route lands untagged."
    )
    lines.append("")

    lines.append("## Distribution")
    lines.append("")
    lines.append("| GUI location | Routes |")
    lines.append("| --- | --- |")
    for loc, n in sorted(dist.items()):
        lines.append(f"| `{loc}` | {n} |")
    lines.append(f"| **total** | **{len(openapi_rows)}** |")
    lines.append("")

    lines.append("## OpenAPI routes")
    lines.append("")
    lines.append("| Method | Path | GUI location | Deferral reason |")
    lines.append("| --- | --- | --- | --- |")
    for verb, path, location, reason in openapi_rows:
        reason_cell = reason.replace("|", "\\|") if reason else ""
        lines.append(f"| `{verb}` | `{path}` | `{location}` | {reason_cell} |")
    lines.append("")

    lines.append("## Non-OpenAPI routes (manual review)")
    lines.append("")
    lines.append(
        "WebSocket routes and static mounts are invisible to `app.openapi()`. "
        "Each carries a `# parity-reviewed: <date>` marker in its source."
    )
    lines.append("")
    lines.append("| Kind | Route | Source | Reviewed |")
    lines.append("| --- | --- | --- | --- |")
    for kind, ident, src, reviewed in manual_rows:
        mark = "yes" if reviewed else "**NO**"
        lines.append(f"| {kind} | `{ident}` | `{src}` | {mark} |")
    lines.append("")

    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_PATH.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
