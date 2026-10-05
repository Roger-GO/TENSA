"""A minimal, dependency-free Python client for the TENSA API.

Uses only the standard library so you can vendor this single file into any
project (or let an LLM agent import it). For the full API surface see
``http://<server>/docs`` or the repo's ``llms.txt``.

Usage::

    from tensa_client import AndesApp

    app = AndesApp("http://127.0.0.1:8000")
    with app.session() as s:
        s.load_case("ieee14_full.xlsx")
        s.add_fault(bus_idx="7", tf=1.0, tc=1.1)
        print(s.run_pflow()["converged"])
        result = s.run_tds(tf=5.0)
        print(result["converged"])
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class AndesAppError(RuntimeError):
    """Raised on any non-2xx response, carrying the RFC-7807 ProblemDetails."""

    def __init__(self, status: int, problem: dict[str, Any]):
        self.status = status
        self.problem = problem
        recovery = problem.get("recovery") or {}
        hint = f" — recovery: {recovery.get('kind')}" if recovery.get("kind") else ""
        super().__init__(f"[{status}] {problem.get('title')}: {problem.get('detail')}{hint}")


class AndesApp:
    """Top-level handle to a running ``tensa serve`` instance."""

    def __init__(self, base_url: str = "http://127.0.0.1:8000", timeout: float = 330.0):
        self.api = base_url.rstrip("/") + "/api"
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        raw: bytes | None = None,
    ) -> Any:
        """Send ``body`` as JSON, or ``raw`` bytes as the file they are."""
        if raw is not None:
            data: bytes | None = raw
            headers = {"Content-Type": "application/octet-stream"}
        else:
            data = json.dumps(body).encode() if body is not None else None
            headers = {"Content-Type": "application/json"} if data else {}
        req = urllib.request.Request(
            self.api + path,
            data=data,
            method=method,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            try:
                problem = json.loads(e.read())
            except Exception:
                problem = {"title": e.reason, "detail": ""}
            raise AndesAppError(e.code, problem) from None

    @contextmanager
    def session(self) -> Iterator["Session"]:
        """Create a session and guarantee cleanup."""
        sid = self.request("POST", "/sessions")["session_id"]
        try:
            yield Session(self, sid)
        finally:
            try:
                self.request("DELETE", f"/sessions/{sid}")
            except AndesAppError:
                pass

    def workspace_files(self) -> list[dict[str, Any]]:
        return self.request("GET", "/workspace/files")["files"]

    def upload_case(
        self, path: str | Path, name: str | None = None, overwrite: bool = False
    ) -> dict[str, Any]:
        """Copy a local case file (.xlsx .raw .dyr .json .m, up to 32 MiB) into the
        server's workspace, under ``name`` (default: the file's own name), so a
        session can load it by that name. An existing file of that name is left
        alone and raises 409 unless ``overwrite`` is true."""
        query = urllib.parse.urlencode(
            {"name": name or Path(path).name, "overwrite": "true" if overwrite else "false"}
        )
        return self.request("POST", f"/workspace/files?{query}", raw=Path(path).read_bytes())

    def response_metrics(self, series: list[dict[str, Any]], **options: Any) -> Any:
        """Nadir, rate of change, settling time, overshoot and damping of signals.

        ``series`` is a list of ``{"name": ..., "t": [...], "y": [...]}``, for
        instance built from the ``traces`` of ``run_tds(..., dae_vars=[...])``.
        Options: ``t_start``, ``t_end`` (the window), ``settling_band``,
        ``rocof_window``. Needs no session."""
        return self.request("POST", "/response-metrics", {"series": series, **options})


class Session:
    """One isolated ANDES ``System`` living in its own server-side subprocess."""

    def __init__(self, app: AndesApp, session_id: str):
        self.app = app
        self.id = session_id

    def _req(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        return self.app.request(method, f"/sessions/{self.id}{path}", body)

    # -- case lifecycle ----------------------------------------------------
    def load_case(self, primary_path: str, addfiles: list[str] | None = None) -> Any:
        body: dict[str, Any] = {"primary_path": primary_path}
        if addfiles:
            body["addfiles"] = addfiles
        return self._req("POST", "/case", body)

    def reload(self) -> Any:
        """Return to pre-setup state so more disturbances/edits can be added."""
        return self._req("POST", "/reload", {})

    def topology(self) -> Any:
        return self._req("GET", "/topology")

    # -- disturbances (pre-setup only) --------------------------------------
    def add_disturbances(self, specs: list[dict[str, Any]]) -> Any:
        return self._req("POST", "/disturbances", {"disturbances": specs})

    def add_fault(self, bus_idx: str, tf: float, tc: float, xf: float = 0.05, rf: float = 0.0) -> Any:
        return self.add_disturbances(
            [{"kind": "fault", "bus_idx": bus_idx, "tf": tf, "tc": tc, "xf": xf, "rf": rf}]
        )

    def add_toggle(self, model: str, dev_idx: str, t: float) -> Any:
        return self.add_disturbances([{"kind": "toggle", "model": model, "dev_idx": dev_idx, "t": t}])

    def add_alter(self, model: str, dev_idx: str, src: str, t: float, method: str, amount: float) -> Any:
        return self.add_disturbances(
            [{"kind": "alter", "model": model, "dev_idx": dev_idx, "src": src,
              "t": t, "method": method, "amount": amount}]
        )

    # -- analyses ------------------------------------------------------------
    def run_pflow(self, **settings: Any) -> Any:
        """Solve the power flow. Optional settings, for this run only: tolerance,
        max_iterations, flat_start, enforce_q_limits (hold generators at their Q
        limits)."""
        return self._req("POST", "/pflow", settings)

    def run_tds(self, tf: float, **kwargs: Any) -> Any:
        """Batch time-domain simulation (synchronous; server caps at 300 s wall time).

        ``dae_vars=["omega GENROU 1", ...]`` records those ANDES variables at
        every step and returns them under ``traces`` (see ``dae_variables``)."""
        return self._req("POST", "/tds", {"tf": tf, **kwargs})

    def dae_variables(self, **filters: Any) -> Any:
        """The ANDES variables of the loaded case that ``run_tds`` can record, named
        as ANDES names them (``omega GENROU 1``). Filters: ``q`` (words that must
        all appear in the name), ``kind`` (``x`` state, ``y`` algebraic), ``model``,
        ``limit``, ``offset``."""
        query = urllib.parse.urlencode({k: v for k, v in filters.items() if v is not None})
        return self._req("GET", f"/dae-variables?{query}" if query else "/dae-variables")

    def operating_point(self) -> Any:
        return self._req("GET", "/operating-point")

    def run_eig(self) -> Any:
        return self._req("POST", "/eig", {})
