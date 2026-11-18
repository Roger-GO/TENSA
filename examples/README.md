# Examples

Copy-paste recipes for driving TENSA programmatically. Start the server first:

```bash
tensa serve --workspace ~/tensa-cases --port 8000
```

A server that starts on an empty workspace fills it with the example cases, so
`ieee14_full.xlsx` is there for the recipes below. In a workspace that already holds other
files, `tensa examples add ieee14 --workspace ~/tensa-cases` adds it.

| File | What it shows |
|---|---|
| [`walkthrough.sh`](./walkthrough.sh) | The whole lifecycle in plain curl: session → case → disturbance → power flow → TDS → results |
| [`tensa_client.py`](./tensa_client.py) | A small, dependency-light Python client (stdlib `urllib` only) you can vendor into any project |
| [`run_fault_study.py`](./run_fault_study.py) | Uses the client: load IEEE-14, apply a bus fault, run a 5 s TDS, print the lowest final bus voltage |
| [`contingency_screening/`](./contingency_screening/) | A budgeted N-2 contingency screening study on IEEE 39-bus: scripted and LLM agents drive the API, and an exhaustive oracle scores them. It needs `httpx` and the IEEE 39-bus case from ANDES; its [README](./contingency_screening/README.md) has the steps |

For the complete API contract, see `http://127.0.0.1:8000/docs` (interactive) or
[`../llms.txt`](../llms.txt) (condensed map, written for LLM agents).
