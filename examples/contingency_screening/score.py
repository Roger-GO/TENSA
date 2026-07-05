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

Metric names follow the PowerAgentBench-SS definitions [Zhang et al.];
the environment here is AC (ANDES via TENSA) with published synthesized
ratings, so numbers are NOT comparable to that paper's DC results.
"""

from __future__ import annotations

from pathlib import Path

from common import RESULTS, load_json, save_json


def main() -> None:
    oracle = load_json("oracle.json")
    top = {tuple(p) for p in oracle["top_k"]}
    k = oracle["report_k"]

    scores = {}
    for sub_path in sorted(Path(RESULTS).glob("submission_*.json")):
        sub = load_json(sub_path.name)
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
