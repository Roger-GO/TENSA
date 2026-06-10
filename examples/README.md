# Examples

Copy-paste recipes for driving ANDES App programmatically. Start the server first:

```bash
andes-app serve --workspace ~/andes-cases --port 8000
```

| File | What it shows |
|---|---|
| [`walkthrough.sh`](./walkthrough.sh) | The whole lifecycle in plain curl: session → case → disturbance → power flow → TDS → results |
| [`andes_client.py`](./andes_client.py) | A ~150-line dependency-light Python client (stdlib `urllib` only) you can vendor into any project |
| [`run_fault_study.py`](./run_fault_study.py) | Uses the client: load IEEE-14, apply a bus fault, run a 5 s TDS, print the frequency nadir |

For the complete API contract, see `http://127.0.0.1:8000/docs` (interactive) or
[`../llms.txt`](../llms.txt) (condensed map, written for LLM agents).
