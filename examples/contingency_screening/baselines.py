"""Scripted baseline agents (no LLM): random and greedy-by-stress.

Both spend the same validation budget through the same public API surface
as the LLM agent, then submit the pairs they actually measured, ranked by
measured severity. Submissions are written in the shared format scored by
``score.py``:

    {"agent": ..., "validated": [[a, b], ...], "ranking": [[a, b], ...]}

- ``random``: uniform sample of the candidate list (seeded).
- ``greedy_stress``: rank candidates by the sum of the two branches' base
  loading percentages (public data only), validate the top-budget pairs.
"""

from __future__ import annotations

import random as _random

from common import Tensa, load_json, save_json, severity


def run_agent(name: str, chosen: list[tuple[str, str]], task: dict) -> None:
    ratings = {i: b["rate_mva"] for i, b in task["branches"].items()}
    t = Tensa()
    measured: list[tuple[tuple[str, str], float | None]] = []
    try:
        t.load_case()
        for pair in chosen[: task["budget"]]:
            obs = t.validate_pair(pair)
            measured.append(
                (pair, severity(obs["flows_mva"], ratings, pair, obs["converged"]))
            )
    finally:
        t.close()
    ranked = sorted(measured, key=lambda r: (0, 0.0) if r[1] is None else (1, -r[1]))
    submission = {
        "agent": name,
        "validated": [list(p) for p, _ in measured],
        "ranking": [list(p) for p, _ in ranked[: task["report_k"]]],
    }
    save_json(f"submission_{name}.json", submission)
    n_hit = sum(1 for _, s in measured if s is None or (s or 0) > 0)
    print(f"{name}: validated {len(measured)}, {n_hit} with violations/collapse")


def main() -> None:
    task = load_json("task.json")
    candidates = [tuple(p) for p in task["candidates"]]

    rng = _random.Random(39)
    run_agent("random", rng.sample(candidates, len(candidates)), task)

    loading = {i: b["base_loading_pct"] for i, b in task["branches"].items()}
    by_stress = sorted(candidates, key=lambda p: -(loading[p[0]] + loading[p[1]]))
    run_agent("greedy_stress", by_stress, task)


if __name__ == "__main__":
    main()
