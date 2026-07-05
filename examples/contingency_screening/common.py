"""Shared plumbing for the PowerAgentBench-style N-2 screening study.

Everything here talks to a running TENSA server through the public HTTP
API only — the same surface the UI and the MCP server use. A "validation"
of one N-2 candidate is:

    reload case -> PUT u=0 on both branches -> POST /pflow -> read flows

Line outages use the Line ``u`` (connection status) parameter; outaged
branches report zero flow and the reload returns the session to the
pristine pre-setup case, so validations are independent by construction.

Ratings: the stock IEEE 39-bus case ships no thermal ratings
(``rate_a == 0``), so this study synthesizes them by quantizing base-case
flows upward: ``rate = max(100, 50 * ceil(1.3 * S_base / 50))`` MVA. The
quantization leaves each branch with a different headroom, which is what
gives screening heuristics a signal. Ratings are published to the agent
in ``task.json`` — they are part of the public task, not hidden state.
"""

from __future__ import annotations

import json
import math
from itertools import combinations
from pathlib import Path
from typing import Any

import httpx

BASE_URL = "http://127.0.0.1:18800/api"
CASE = "ieee39.xlsx"
HERE = Path(__file__).parent
RESULTS = HERE / "results"

RATE_FACTOR = 1.3
RATE_STEP_MVA = 50.0
RATE_FLOOR_MVA = 100.0
BUDGET = 40
REPORT_K = 20


class Tensa:
    """Minimal client for the slice of the TENSA API this study uses."""

    def __init__(self, base_url: str = BASE_URL) -> None:
        self._c = httpx.Client(base_url=base_url, timeout=180)
        self.sid = self._c.post("/sessions").json()["session_id"]

    def load_case(self, path: str = CASE) -> None:
        r = self._c.post(f"/sessions/{self.sid}/case", json={"primary_path": path})
        r.raise_for_status()

    def reload(self) -> None:
        self._c.post(f"/sessions/{self.sid}/reload").raise_for_status()

    def outage(self, branch_idx: str) -> None:
        r = self._c.put(
            f"/sessions/{self.sid}/elements/Line/{branch_idx}",
            json={"params": {"u": 0}},
        )
        r.raise_for_status()

    def pflow(self) -> dict[str, Any]:
        r = self._c.post(f"/sessions/{self.sid}/pflow", json={})
        r.raise_for_status()
        return r.json()

    def topology(self) -> dict[str, Any]:
        r = self._c.get(f"/sessions/{self.sid}/topology")
        r.raise_for_status()
        return r.json()

    def validate_pair(self, pair: tuple[str, str]) -> dict[str, Any]:
        """One budgeted validation: outage ``pair``, solve AC PF, return flows.

        Always leaves the session back at the pristine pre-setup case.
        """
        self.reload()
        self.outage(pair[0])
        self.outage(pair[1])
        try:
            pf = self.pflow()
        except httpx.HTTPStatusError:
            # Solver-level failure (e.g., singular Jacobian on a degenerate
            # topology). Treat as non-converged rather than crashing the run.
            self.reload()
            return {"converged": False, "flows_mva": {}}
        flows = {
            idx: math.hypot(f["p"], f["q"])
            for idx, f in (pf.get("line_flows") or {}).items()
        }
        return {"converged": bool(pf.get("converged")), "flows_mva": flows}

    def close(self) -> None:
        self._c.delete(f"/sessions/{self.sid}")
        self._c.close()


def branch_endpoints(topology: dict[str, Any]) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    for entry in topology["lines"] + topology.get("transformers", []):
        p = entry["params"]
        out[str(entry["idx"])] = (str(p["bus1"]), str(p["bus2"]))
    return out


def synth_ratings(base_flows_mva: dict[str, float]) -> dict[str, float]:
    return {
        idx: max(
            RATE_FLOOR_MVA,
            RATE_STEP_MVA * math.ceil(RATE_FACTOR * s / RATE_STEP_MVA),
        )
        for idx, s in base_flows_mva.items()
    }


def severity(
    flows_mva: dict[str, float],
    ratings: dict[str, float],
    outaged: tuple[str, str],
    converged: bool,
) -> float | None:
    """Sum of per-branch overload fractions; ``None`` marks non-convergence.

    Non-convergence under an N-2 outage on a connectivity-safe candidate
    means the AC power flow found no acceptable operating point — ranked
    above every converged candidate by the oracle (see ``oracle.py``).
    """
    if not converged:
        return None
    total = 0.0
    for idx, s in flows_mva.items():
        if idx in outaged:
            continue
        rate = ratings.get(idx)
        if rate:
            total += max(0.0, s / rate - 1.0)
    return total


def _connected_without(
    buses: set[str], edges: dict[str, tuple[str, str]], removed: tuple[str, str]
) -> bool:
    parent = {b: b for b in buses}

    def find(a: str) -> str:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for idx, (u, v) in edges.items():
        if idx in removed:
            continue
        ra, rb = find(u), find(v)
        if ra != rb:
            parent[ra] = rb
    roots = {find(b) for b in buses}
    return len(roots) == 1


def enumerate_candidates(
    endpoints: dict[str, tuple[str, str]],
) -> list[tuple[str, str]]:
    """All branch pairs whose simultaneous outage keeps the grid connected.

    Islanding pairs are excluded from the candidate set (published in the
    task): they are trivially detectable from topology alone and would
    dominate any severity ranking without exercising the solver.
    """
    buses = {b for pair in endpoints.values() for b in pair}
    return [
        pair
        for pair in combinations(sorted(endpoints), 2)
        if _connected_without(buses, endpoints, pair)
    ]


def load_json(name: str) -> Any:
    return json.loads((RESULTS / name).read_text())


def save_json(name: str, payload: Any) -> None:
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / name).write_text(json.dumps(payload, indent=2, sort_keys=True))
