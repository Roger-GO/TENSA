"""Budgeted validation CLI for a human- or LLM-driven agent run.

Usage:

    python validate_cli.py Line_14,Line_20 Line_3,Line_5 ...

Each argument is one N-2 candidate ``a,b``. Every call is appended to
``results/agent_claude_log.json`` (the budget audit trail); the tool
refuses to exceed the task budget and refuses pairs outside the
candidate list. Prints, per pair: convergence, severity, and the
worst-loaded surviving branches, i.e., exactly the observation an agent
is entitled to.
"""

from __future__ import annotations

import sys
from pathlib import Path

from common import RESULTS, Tensa, load_json, save_json, severity

LOG = "agent_claude_log.json"


def main() -> None:
    task = load_json("task.json")
    ratings = {i: b["rate_mva"] for i, b in task["branches"].items()}
    candidates = {tuple(p) for p in task["candidates"]}
    log = load_json(LOG) if (Path(RESULTS) / LOG).exists() else []
    seen = {tuple(e["pair"]) for e in log}

    pairs = []
    for arg in sys.argv[1:]:
        a, b = arg.split(",")
        pair = tuple(sorted((a, b)))
        if pair not in candidates:
            print(f"REJECTED {pair}: not in candidate list")
            continue
        if pair in seen:
            print(f"SKIP {pair}: already validated (no budget spent)")
            continue
        pairs.append(pair)

    remaining = task["budget"] - len(log)
    if len(pairs) > remaining:
        print(f"REFUSED: {len(pairs)} requested, only {remaining} budget left")
        return

    t = Tensa()
    try:
        t.load_case()
        for pair in pairs:
            obs = t.validate_pair(pair)
            sev = severity(obs["flows_mva"], ratings, pair, obs["converged"])
            over = sorted(
                (
                    (idx, s / ratings[idx])
                    for idx, s in obs["flows_mva"].items()
                    if idx not in pair and ratings.get(idx) and s / ratings[idx] > 0.9
                ),
                key=lambda kv: -kv[1],
            )[:5]
            log.append(
                {
                    "pair": list(pair),
                    "converged": obs["converged"],
                    "severity": None if sev is None else round(sev, 6),
                }
            )
            tag = "COLLAPSE" if sev is None else f"sev={sev:.4f}"
            hot = "  ".join(f"{i}@{100 * v:.0f}%" for i, v in over) or "-"
            print(f"{pair[0]},{pair[1]}  {tag}  hot: {hot}")
    finally:
        t.close()

    save_json(LOG, log)
    print(f"budget used: {len(log)}/{task['budget']}")


if __name__ == "__main__":
    main()
