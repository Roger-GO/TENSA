"""Build the PUBLIC task definition (``results/task.json``).

This is everything an agent is allowed to see before spending budget:
branch topology, base-case AC flows, synthesized ratings, the candidate
list, the validation budget, and the report size. No post-contingency
information is included.

Run (server on :18800 with ieee39.xlsx in the workspace):

    python build_task.py
"""

from __future__ import annotations

from common import (
    BUDGET,
    CASE,
    REPORT_K,
    Tensa,
    branch_endpoints,
    enumerate_candidates,
    save_json,
    synth_ratings,
)


def main() -> None:
    t = Tensa()
    try:
        t.load_case()
        endpoints = branch_endpoints(t.topology())
        pf = t.pflow()
        assert pf.get("converged"), "base case must converge"
        import math

        base = {idx: math.hypot(f["p"], f["q"]) for idx, f in pf["line_flows"].items()}
        ratings = synth_ratings(base)
        candidates = enumerate_candidates(endpoints)
        task = {
            "case": CASE,
            "branches": {
                idx: {
                    "bus1": endpoints[idx][0],
                    "bus2": endpoints[idx][1],
                    "base_mva": round(base[idx], 3),
                    "rate_mva": ratings[idx],
                    "base_loading_pct": round(100 * base[idx] / ratings[idx], 1),
                }
                for idx in sorted(endpoints)
            },
            "candidates": [list(p) for p in candidates],
            "budget": BUDGET,
            "report_k": REPORT_K,
            "protocol": (
                "Validate at most `budget` candidate pairs via the TENSA API "
                "(reload -> u=0 on both branches -> AC power flow -> flows). "
                "Submit a ranked list of `report_k` pairs believed to have the "
                "highest post-contingency thermal severity. Severity of a pair "
                "is the sum over in-service branches of max(0, S/rate - 1); "
                "non-converged AC cases rank above all converged ones."
            ),
        }
        save_json("task.json", task)
        n_over = sum(1 for b in task["branches"].values() if b["base_loading_pct"] > 90)
        print(
            f"task.json written: {len(endpoints)} branches, "
            f"{len(candidates)} connectivity-safe N-2 candidates "
            f"(of {46 * 45 // 2} raw pairs), budget={BUDGET}, report_k={REPORT_K}, "
            f"{n_over} branches above 90% base loading"
        )
    finally:
        t.close()


if __name__ == "__main__":
    main()
