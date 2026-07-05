# Agent-driven N-2 contingency screening on IEEE 39-bus

This example evaluates how well an agent can find the most severe N-2
branch-outage contingencies through TENSA's public HTTP API, following
the task protocol of PowerAgentBench-SS (Zhang et al., arXiv:2606.18789):
budgeted validation, evidence-backed ranked submission, hidden oracle.

One honesty note up front: this is a **PowerAgentBench-style protocol
implemented natively on TENSA**, not a run of that benchmark. Their
environment is DC with its own tool API; this study is full AC (ANDES via
TENSA) with published synthesized ratings. Scores here are not comparable
to numbers in their paper.

## Task

- Case: the stock ANDES `ieee39.xlsx` (39 buses, 46 branches). The case
  ships no thermal ratings, so ratings are synthesized by quantizing
  base-case flows upward (`rate = max(100, 50 * ceil(1.3 * S_base / 50))`
  MVA) and published to the agent. Quantization leaves each branch a
  different headroom, which is what gives screening a signal.
- Candidates: all branch pairs whose simultaneous outage keeps the grid
  connected (562 of 1,035 raw pairs; islanding pairs are excluded because
  they are detectable from topology without a solver).
- One validation = `reload -> PUT u=0 on both branches -> POST /pflow ->
  read line flows`, all through the public API. Severity is the sum of
  per-branch overload fractions; a non-converged AC case ranks above all
  converged ones.
- Budget: 40 validations (7% of the candidate space). Submission: ranked
  top-20.
- Metrics (PowerAgentBench-SS definitions): recall@20, evidence-backed
  recall, found recall, budget used.

## Agents

- `random` — scripted: validates a uniform sample, submits what it saw.
- `greedy_stress` — scripted: validates the 40 pairs with the highest
  combined base loading, submits by measured severity.
- `claude_opus_4.8` — an LLM agent (Claude Opus 4.8) driving the same API
  interactively: 12 validations to isolate single-outage contributions
  (each suspect paired with a mild remote partner), then combinations of
  the strongest contributors, adapting to observed overloads. The full
  audit trail is `results/agent_claude_log.json`; the oracle was computed
  only after the submission was frozen.

## Results

| agent | recall@20 | evidence-backed | found recall | budget |
|---|---|---|---|---|
| claude_opus_4.8 (LLM) | 0.25 | 1.00 | 0.25 | 40 |
| greedy_stress (scripted) | 0.25 | 1.00 | 0.25 | 40 |
| random (scripted) | 0.10 | 1.00 | 0.10 | 40 |

The oracle over all 562 candidates (162 s of wall time, every case
converged) puts (Line_1, Line_3) and (Line_2, Line_3) at the top with
severity 21.1: parallel-corridor synergies around bus 2 whose joint
effect far exceeds either single outage. The LLM agent found 5 of the
hidden top-20, including 3 of the top-10, with every submitted hit
backed by a validation it paid for. Its failure mode is as informative
as its hits: round-1 single-outage probes identified the 21-22 corridor
(Line_27) as dominant and the agent concentrated its budget there,
discovering the stronger Line_3/Line_4 family only in the final round,
too late to explore its pairings. Budgeted N-2 screening is hard
precisely because pair synergies are invisible to single-effect
extrapolation, and a 7% validation budget punishes late pivots. The
scripted greedy baseline tied the LLM at 0.25 by blanket-covering
stressed pairs; both beat random by 2.5x.

## Reproduce

```bash
# serve TENSA with ieee39.xlsx in the workspace
tensa serve --workspace <dir-with-ieee39.xlsx> --port 18800

python build_task.py    # public task data (results/task.json)
python baselines.py     # scripted agents
python validate_cli.py Line_a,Line_b ...   # interactive/LLM agent turns
python oracle.py        # exhaustive ground truth (~5 min, 562 AC PFs)
python score.py         # metrics for every submission_*.json
```

The oracle itself is a byproduct worth noting: 562 independent
outage->solve->restore cycles through the HTTP API complete in a few
minutes on a laptop-class machine, at roughly 0.3 s per cycle.

## Why this example exists

It demonstrates the paper's central claim end to end: the same API
surface serves a person clicking in the UI, a script, and an LLM agent,
and an agent's actions (every validation above) are observable and
auditable. Building it also surfaced a real API gap that became a fix:
the Line connection-status parameter `u` was not editable through the
public endpoint, so line outages could not be expressed without deleting
file-loaded elements. TENSA now exposes `u` on Line edits.
