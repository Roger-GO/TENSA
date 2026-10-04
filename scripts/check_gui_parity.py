#!/usr/bin/env python3
"""GUI-parity ledger + fail-closed CI check (v3.1 Unit 16, KTD-12).

The overhaul's "parity" pillar promises that no substrate capability is
CLI-only: every route is reachable from *some* GUI surface, or is explicitly
deferred with a written reason. This script is the enforcement mechanism.

It does two passes:

1. **OpenAPI surface.** Build the app, call ``app.openapi()``, and walk
   ``schema["paths"][path][method]``. Every operation MUST carry
   ``x-tensa-gui-location`` (injected per-route via ``openapi_extra`` on
   the ``@router.<verb>`` decorator). An operation tagged ``"none"`` MUST also
   carry ``x-tensa-parity-deferred`` with a non-empty reason. A missing
   tag — or a ``"none"`` with no deferral — fails the check (exit 1). This is
   what catches a *new* route that lands untagged.

2. **Non-OpenAPI surface (adversarial F7 — fail-closed).** The OpenAPI spec
   only captures ``@router.get/.post/.put/.delete`` operations. Raw Starlette
   constructs — ``@router.websocket(...)`` routes and ``app.mount(...)`` static
   mounts — are invisible to ``app.openapi()``. Those are enumerated by walking
   the router, including the routers it includes, and each MUST carry a
   ``# parity-reviewed: <date>`` marker in its defining source file. A WS route
   or mount with no such marker fails the check. This prevents fail-OPEN on
   capabilities that live outside the documented HTTP surface (the TDS / jobs /
   sweep WS channels + the SPA mount).

2b. **Schema-invisible HTTP routes (fail-closed).** ``app.openapi()`` only
   reports routes with ``include_in_schema=True``. A future app route
   registered with ``include_in_schema=False`` would be a Starlette
   ``Route``/``APIRoute`` (not a ``WebSocketRoute``/``Mount``), so it would
   slip past *both* Pass 1 (absent from the spec) and Pass 2 (not a WS/mount).
   Pass 1b walks the router directly and fails closed on any HTTP route whose
   path is absent from the OpenAPI spec and is not one of FastAPI's own docs
   endpoints (``/openapi.json`` ``/docs`` ``/redoc`` ``/docs/oauth2-redirect``).
   A route of a kind the walk does not recognise also fails the check, so a
   FastAPI release that changes how routers are stored cannot turn the passes
   into no-ops.

On success: prints a one-line ledger summary for CI logs, writes the full
ledger to ``docs/gui-parity-ledger.md``, and exits 0.

The script imports the app with a dummy token; it never binds a socket or
spawns a worker, so it is safe to run in CI alongside (not inside) the
server-spawning acceptance suite.

CAVEAT — truthfulness vs presence. Pass 1 verifies that every route carries a
GUI-location *tag* (and that ``"none"`` carries a deferral). It does NOT
machine-verify that the named surface ("analysis-panel", "inspector", …)
actually invokes the route from the web client: surface names are
reviewer-asserted. A route tagged with a real-but-unwired surface therefore
passes here and must be caught in code review. Keep this in mind before
over-trusting the green check.
"""

from __future__ import annotations

import inspect
import re
import sys
import tempfile
from collections import Counter
from collections.abc import Iterator, Sequence
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

from fastapi.routing import APIRoute  # noqa: E402
from starlette.routing import Mount, Route, WebSocketRoute  # noqa: E402

from tensa.api.app import make_app  # noqa: E402

GUI_LOCATION_KEY = "x-tensa-gui-location"
DEFERRAL_KEY = "x-tensa-parity-deferred"
LEDGER_PATH = REPO_ROOT / "docs" / "gui-parity-ledger.md"

# A ``# parity-reviewed: YYYY-MM-DD`` marker in the route's source file.
PARITY_MARKER_RE = re.compile(r"#\s*parity-reviewed:\s*(\d{4}-\d{2}-\d{2})")

# Framework-internal endpoints (OpenAPI/Swagger/ReDoc) are tooling, not
# substrate capabilities — they carry no GUI parity obligation.
_FRAMEWORK_MODULE_PREFIXES = ("fastapi.", "starlette.")

# FastAPI's own docs endpoints. These are ``include_in_schema=False`` plain
# Starlette ``Route``s, so they are absent from ``app.openapi()``; Pass 1b
# allow-lists them so it only fails on *app* routes that escaped the spec.
_FRAMEWORK_DOC_PATHS = frozenset(
    {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
)


def _build_app() -> Any:
    """Build the app against a throwaway workspace. No socket bind, no worker spawn.

    The app mounts the SPA only when it finds a built UI, and Pass 2 reviews the
    mount only if it exists. A stand-in ``index.html`` makes the mount (and so its
    review, and its row in the ledger) the same whether or not ``web/dist`` was
    built here, so this check does not need the UI.
    """
    root = Path(tempfile.mkdtemp(prefix="parity-"))
    workspace = root / "ws"
    workspace.mkdir(mode=0o700)
    static = root / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
    return make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        static_override=static,
    )


def _iter_routes(routes: Sequence[Any]) -> Iterator[tuple[Any, str]]:
    """Yield ``(route, path)`` for every route reachable from ``routes``.

    ``route`` is the route as its module defined it (its type says what kind it
    is and its ``endpoint`` points at the source file); ``path`` is the path it
    answers on, with any ``include_router`` prefix applied.

    Through FastAPI 0.136, ``include_router`` copied each route into the
    including router, so ``app.router.routes`` listed all of them. From 0.137
    that list holds one placeholder per ``include_router`` call and the routes
    stay inside the included router, so a walk of the top level finds none of
    them. The placeholder's ``effective_route_contexts()`` flattens it.
    """
    for route in routes:
        effective_contexts = getattr(route, "effective_route_contexts", None)
        if effective_contexts is None:
            yield route, getattr(route, "path", "")
            continue
        for context in effective_contexts():
            # An API route keeps its prefixed path on the context. For the other
            # kinds (WebSocket routes, mounts, plain routes) FastAPI builds a
            # Starlette route with the prefix applied and the context's own
            # path stays empty.
            built = context.starlette_route
            yield context.original_route, (built if built is not None else context).path


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


def _check(
    app: Any,
) -> tuple[list[str], list[tuple[str, str, str, str]], list[tuple[str, str, str, bool]]]:
    """Run every pass against ``app``: ``(failures, openapi rows, manual rows)``."""
    failures: list[str] = []
    routes = list(_iter_routes(app.router.routes))

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

    # --- Pass 1b: schema-invisible HTTP routes (fail-closed) ------------
    # An app HTTP route registered with include_in_schema=False is absent
    # from the OpenAPI spec (Pass 1 can't see it) yet is a Route/APIRoute,
    # not a WebSocketRoute/Mount (Pass 2 skips it). Walk the router directly
    # and fail closed on any such route that isn't a framework docs endpoint.
    spec_paths = set(spec.get("paths", {}).keys())
    for route, path in routes:
        if isinstance(route, (Mount, WebSocketRoute)):
            continue
        if not isinstance(route, (Route, APIRoute)):
            failures.append(
                f"UNKNOWN-ROUTE {type(route).__name__} {path or '?'}: not a kind of "
                f"route this check knows how to review, so it would go "
                f"unchecked. Teach scripts/check_gui_parity.py about it (a new "
                f"FastAPI release may have changed how routers are stored)."
            )
            continue
        if path in spec_paths or path in _FRAMEWORK_DOC_PATHS:
            continue
        endpoint = getattr(route, "endpoint", None)
        module = getattr(endpoint, "__module__", "")
        if module.startswith(_FRAMEWORK_MODULE_PREFIXES):
            continue
        methods = ",".join(sorted(getattr(route, "methods", None) or {"?"}))
        failures.append(
            f"SCHEMA-INVISIBLE {methods} {path}: HTTP route absent from the "
            f"OpenAPI spec (include_in_schema=False?) and not a framework "
            f"docs endpoint — it escapes both the tag check and the WS/mount "
            f"review. Either include it in the schema (so Pass 1 tags it) or "
            f"add it to the framework allow-list with justification."
        )

    # --- Pass 2: non-OpenAPI routes (WS + mounts) -----------------------
    # manual-review row: (kind, path-or-name, source-file, reviewed-flag)
    manual_rows: list[tuple[str, str, str, bool]] = []
    for route, path in routes:
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
            manual_rows.append(("websocket", path, _rel(src_file), reviewed))
            if not reviewed:
                failures.append(
                    f"MANUAL-REVIEW websocket {path}: no "
                    f"'# parity-reviewed: <date>' marker in "
                    f"{_rel(src_file)} (WS routes are invisible to OpenAPI; "
                    f"add the marker above the @router.websocket decorator)"
                )
        elif isinstance(route, Mount):
            # The SPA static mount. Its reviewer marker lives in app.py
            # (the make_app factory that registers the mount).
            src_file = REPO_ROOT / "server" / "src" / "tensa" / "api" / "app.py"
            reviewed = _source_has_parity_marker(src_file)
            name = route.name or "<mount>"
            mount_path = path or "/"
            manual_rows.append(("mount", f"{name} ({mount_path})", _rel(src_file), reviewed))
            if not reviewed:
                failures.append(
                    f"MANUAL-REVIEW mount {name} ({mount_path}): no "
                    f"'# parity-reviewed: <date>' marker in {_rel(src_file)}"
                )

    return failures, openapi_rows, manual_rows


def main() -> int:
    failures, openapi_rows, manual_rows = _check(_build_app())
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
