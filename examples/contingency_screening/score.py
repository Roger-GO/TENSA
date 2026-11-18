"""Score submissions against the oracle (PowerAgentBench-style metrics).

For each ``results/submission_*.json``:

- ``recall_at_k``          — |ranking ∩ oracle top-k| / k. The headline
                             discovery metric.
- ``evidence_backed``      — of the submitted ∩ oracle top-k pairs, the
                             fraction the agent actually validated (spent
                             budget on) rather than guessed.
- ``found_recall``         — |validated ∩ oracle top-k| / k: how much of
                             the top-k the agent's budget touched at all,
                             submitted or not.
- ``budget_used``          — validations consumed.

Metric names follow the PowerAgentBench-SS definitions [Mylonas et al.];
the environment here is AC (ANDES via TENSA) with published synthesized
ratings, so numbers are NOT comparable to that paper's DC results.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from common import RESULTS, load_json, save_json


def version_warning(oracle: dict[str, Any], submission: dict[str, Any]) -> str | None:
    """Say when a submission was made with other TENSA or ANDES versions than the oracle.

    The numbers of two versions can differ for reasons that have nothing to do with the agent,
    so the pair is worth knowing. A file that names no versions (the ones committed before they
    were recorded, or an agent's submission that left them out) says nothing either way.
    """
    made, truth = submission.get("versions"), oracle.get("versions")
    if not made or not truth or made == truth:
        return None

    def named(versions: dict[str, str]) -> str:
        return f"TENSA {versions.get('tensa', '?')} and ANDES {versions.get('andes', '?')}"

    return f"made with {named(made)}, the oracle with {named(truth)}"


def main() -> None:
    oracle = load_json("oracle.json")
    top = {tuple(p) for p in oracle["top_k"]}
    k = oracle["report_k"]

    scores = {}
    for sub_path in sorted(Path(RESULTS).glob("submission_*.json")):
        sub = load_json(sub_path.name)
        warning = version_warning(oracle, sub)
        if warning:
            print(f"WARNING: {sub_path.name} was {warning}", file=sys.stderr)
        ranking = [tuple(p) for p in sub["ranking"]][:k]
        validated = {tuple(p) for p in sub["validated"]}
        hit = [p for p in ranking if p in top]
        evidence = [p for p in hit if p in validated]
        scores[sub["agent"]] = {
            "recall_at_k": round(len(hit) / k, 3),
            "evidence_backed": round(len(evidence) / len(hit), 3) if hit else 0.0,
            "found_recall": round(len(validated & top) / k, 3),
            "budget_used": len(sub["validated"]),
        }

    save_json("scores.json", scores)
    w = max(len(a) for a in scores)
    print(f"{'agent'.ljust(w)}  recall@{k}  evidence  found  budget")
    for agent, s in sorted(scores.items(), key=lambda kv: -kv[1]["recall_at_k"]):
        print(
            f"{agent.ljust(w)}  {s['recall_at_k']:.3f}     "
            f"{s['evidence_backed']:.3f}     {s['found_recall']:.3f}  "
            f"{s['budget_used']}"
        )


if __name__ == "__main__":
    main()
