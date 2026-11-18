# Agent-driven N-2 contingency screening on IEEE 39-bus

This example evaluates how well an agent can find the most severe N-2
branch-outage contingencies through TENSA's public HTTP API, following
the task protocol of PowerAgentBench-SS (Mylonas et al., arXiv:2606.18789):
budgeted validation, evidence-backed ranked submission, hidden oracle.

One honesty note up front: this is a **PowerAgentBench-style protocol
implemented natively on TENSA**, not a run of that benchmark. Their
environment is DC with its own tool API; this study is full AC (ANDES via
TENSA) with published synthesized ratings. Scores here are not comparable
to numbers in their paper.

## Task

- Case: the stock ANDES `ieee39.xlsx` (39 buses, 46 branches; the file of ANDES
  2.0.0, SHA-256 `09929dc99f081e0ae4ae7fd8de6303acd1ed29015aea4a32c4467136a225af25`).
  The case ships no thermal ratings, so ratings are synthesized by quantizing
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

- `random`: scripted. Validates a uniform sample, submits what it saw.
- `greedy_stress`: scripted. Validates the 40 pairs with the highest
  combined base loading, submits by measured severity.
- `claude_opus_4.8`: an LLM agent (Claude Opus 4.8) driving the same API
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

You need TENSA, ANDES (which TENSA installs) and `httpx`, the HTTP client the
scripts use and TENSA does not install:

```bash
pip install tensa httpx
```

The study loads the IEEE 39-bus case that ships inside ANDES. Copy it into a
workspace of its own and serve that:

```bash
mkdir study-workspace
python -c "import andes, pathlib, shutil; shutil.copy(pathlib.Path(andes.__file__).parent / 'cases' / 'ieee39' / 'ieee39.xlsx', 'study-workspace')"
tensa serve --workspace study-workspace --port 18800
```

Then, from this folder in another terminal (the scripts import each other by
name, so run them here):

```bash
python build_task.py    # public task data (results/task.json)
python baselines.py     # scripted agents
python validate_cli.py Line_a,Line_b ...   # interactive/LLM agent turns
python oracle.py        # exhaustive ground truth (~3 min, 562 AC PFs)
python score.py         # metrics for every submission_*.json
```

The scripts look for the server at `http://127.0.0.1:18800`. To use another
port or host, set `TENSA_URL` to the address `tensa serve` prints, for example
`TENSA_URL=http://127.0.0.1:8000`. They write into `results/`, over the files
committed there, so copy this folder first to keep those.

A run records the TENSA and ANDES versions it used, under `versions`, in
`task.json`, `oracle.json`, the submissions of `baselines.py` and every entry
that `validate_cli.py` adds to its log. `score.py` warns when a submission names
other versions than the oracle does, so an agent that writes its own submission
should copy `versions` from its log into it. The files
committed in `results/` come from before that was recorded, so they carry no
versions. Running the scripts again with TENSA 0.5.0 and ANDES 2.0.0 gives the
same task, oracle, scripted submissions and scores as the committed files, apart
from `versions`. The oracle took 162 s on a workstation.

The oracle itself is a byproduct worth noting: 562 independent
outage->solve->restore cycles through the HTTP API took 162 s on a
workstation, at roughly 0.3 s per cycle. A slower machine takes longer.

## Why this example exists

It demonstrates the paper's central claim end to end: the same API
surface serves a person clicking in the UI, a script, and an LLM agent,
and an agent's actions (every validation above) are observable and
auditable. Building it also surfaced a real API gap that became a fix:
the Line connection-status parameter `u` was not editable through the
public endpoint, so line outages could not be expressed without deleting
file-loaded elements. TENSA now exposes `u` on Line edits.
