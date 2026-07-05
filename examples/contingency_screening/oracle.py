"""Compute the HIDDEN oracle: exhaustive severity for every candidate.

Runs every connectivity-safe N-2 candidate through the same public
``validate`` operation the agents use (reload -> u=0 x2 -> AC PF), so the
ground truth and the agents' observations come from one solver and one
formula. Writes ``results/oracle.json`` with per-pair severity and the
oracle top-`report_k` ranking (non-converged candidates rank first, then
converged by descending severity).

This is the scoring key. Agents must never read it before submitting.
"""

from __future__ import annotations

import time

from common import REPORT_K, Tensa, load_json, save_json, severity


def main() -> None:
    task = load_json("task.json")
    ratings = {i: b["rate_mva"] for i, b in task["branches"].items()}
    candidates = [tuple(p) for p in task["candidates"]]

    t = Tensa()
    rows = []
    t0 = time.time()
    try:
        t.load_case()
        for n, pair in enumerate(candidates, 1):
            obs = t.validate_pair(pair)
            sev = severity(obs["flows_mva"], ratings, pair, obs["converged"])
            rows.append(
                {
                    "pair": list(pair),
                    "converged": obs["converged"],
                    "severity": None if sev is None else round(sev, 6),
                }
            )
            if n % 100 == 0:
                print(f"{n}/{len(candidates)} ({time.time() - t0:.0f}s)")
    finally:
        t.close()

    # Rank: non-converged first (most severe), then by severity descending.
    ranked = sorted(
        rows,
        key=lambda r: (0, 0.0) if r["severity"] is None else (1, -r["severity"]),
    )
    top = [r["pair"] for r in ranked[:REPORT_K]]
    n_nc = sum(1 for r in rows if not r["converged"])
    n_viol = sum(1 for r in rows if r["severity"] not in (None, 0.0))
    save_json(
        "oracle.json",
        {"rows": rows, "top_k": top, "report_k": REPORT_K},
    )
    print(
        f"oracle.json written: {len(rows)} candidates in {time.time() - t0:.0f}s, "
        f"{n_nc} non-converged, {n_viol} with thermal violations"
    )


if __name__ == "__main__":
    main()
