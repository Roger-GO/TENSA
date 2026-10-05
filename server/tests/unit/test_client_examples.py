"""The clients and scripts outside the web UI label a JSON body as JSON.

FastAPI 0.133 and later parse a request body as JSON only when its
``Content-Type`` says so; a body without the header, or with curl's default
form type, answers 422. The web UI's client has its own tests. These cover the
other callers a user copies from: ``examples/tensa_client.py``, the MCP server's
HTTP helper (which sends every body the agent tools produce), and the curl
walkthrough. The clients are driven against a stand-in HTTP server that records
what arrives. The tests read the repository files directly, so they skip when run
away from a checkout.
"""

from __future__ import annotations

import http.server
import json
import re
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tests._repo import REPO_ROOT, load_module

pytestmark = pytest.mark.unit

_EXAMPLES = REPO_ROOT / "examples"
_JSON = "application/json"


@pytest.fixture
def recorder() -> Iterator[tuple[str, list[dict[str, Any]]]]:
    """A local server that answers ``{"ok": true}`` and records each request it gets."""
    seen: list[dict[str, Any]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _answer(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            seen.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "content_type": self.headers.get("Content-Type"),
                    "body": self.rfile.read(length) if length else b"",
                }
            )
            payload = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", _JSON)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_DELETE = _answer

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_the_example_client_sends_a_json_body_as_json(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    app = client.AndesApp(base)

    app.request("POST", "/sessions/abc/case", {"primary_path": "ieee14.raw"})
    app.request("POST", "/sessions/abc/pflow", {})
    app.request("POST", "/sessions")

    case, pflow, create = seen
    assert case["path"] == "/api/sessions/abc/case"
    assert case["content_type"] == _JSON
    assert json.loads(case["body"]) == {"primary_path": "ieee14.raw"}
    # An empty object is a body too, and the one most routes (pflow, reload) take.
    assert pflow["content_type"] == _JSON
    assert pflow["body"] == b"{}"
    assert create["body"] == b""


def test_the_mcp_helper_sends_a_json_body_as_json(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp.server.fastmcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server._api("POST", "/sessions/abc/tds", {"tf": 2.0})
    mcp_server._api("POST", "/sessions/abc/reload", {})
    mcp_server._api("GET", "/sessions/abc/topology")

    tds, reload, topology = seen
    assert tds["content_type"] == _JSON
    assert json.loads(tds["body"]) == {"tf": 2.0}
    assert reload["content_type"] == _JSON
    assert reload["body"] == b"{}"
    assert topology["body"] == b""


def test_the_mcp_power_flow_tool_sends_only_the_settings_it_was_given(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp.server.fastmcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.run_pflow("abc")
    mcp_server.run_pflow("abc", max_iterations=50, enforce_q_limits=False)

    plain, tuned = seen
    assert plain["path"] == "/api/sessions/abc/pflow"
    assert plain["content_type"] == _JSON
    assert plain["body"] == b"{}"
    # A setting set to false is a setting; only the ones left out are dropped.
    assert json.loads(tuned["body"]) == {"max_iterations": 50, "enforce_q_limits": False}


def test_the_example_client_passes_power_flow_settings_through(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    session = client.Session(client.AndesApp(base), "abc")

    session.run_pflow()
    session.run_pflow(flat_start=True, tolerance=1e-4)

    plain, tuned = seen
    assert plain["body"] == b"{}"
    assert json.loads(tuned["body"]) == {"flat_start": True, "tolerance": 1e-4}


def test_the_example_client_lists_andes_variables_and_describes_signals(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    app = client.AndesApp(base)
    session = client.Session(app, "abc")

    session.dae_variables()
    session.dae_variables(q="omega gen", kind="x", limit=5, model=None)
    session.run_tds(1.0, dae_vars=["omega GENROU 1"])
    app.response_metrics([{"name": "w", "t": [0, 1, 2], "y": [1, 1, 1]}], t_start=0.5)

    plain, filtered, run, metrics = seen
    assert plain["path"] == "/api/sessions/abc/dae-variables"
    assert filtered["path"] == "/api/sessions/abc/dae-variables?q=omega+gen&kind=x&limit=5"
    assert json.loads(run["body"]) == {"tf": 1.0, "dae_vars": ["omega GENROU 1"]}
    assert metrics["path"] == "/api/response-metrics"
    assert metrics["content_type"] == _JSON
    assert json.loads(metrics["body"])["t_start"] == 0.5


def test_the_example_client_reads_the_messages_of_a_session(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    session = client.Session(client.AndesApp(base), "abc")

    session.messages()
    session.messages(level="error", after=40)

    warnings, errors = seen
    assert warnings["path"] == "/api/sessions/abc/messages?level=warning&after=0"
    assert errors["path"] == "/api/sessions/abc/messages?level=error&after=40"


def test_the_example_client_uploads_a_case_file_as_its_own_bytes(
    recorder: tuple[str, list[dict[str, Any]]], tmp_path: Path
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    app = client.AndesApp(base)
    case = tmp_path / "My Case.raw"
    case.write_bytes(b"\xff\x00 not text \r\n")

    app.upload_case(case)
    app.upload_case(case, name="renamed.raw", overwrite=True)

    plain, renamed = seen
    # The file is the body, labelled as raw bytes (not JSON, not multipart); the name
    # and the overwrite choice travel in the query, escaped.
    assert plain["method"] == "POST"
    assert plain["path"] == "/api/workspace/files?name=My+Case.raw&overwrite=false"
    assert plain["content_type"] == "application/octet-stream"
    assert plain["body"] == b"\xff\x00 not text \r\n"
    assert renamed["path"] == "/api/workspace/files?name=renamed.raw&overwrite=true"
    assert renamed["body"] == plain["body"]


def test_the_mcp_tds_tool_sends_the_variables_it_was_asked_to_record(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp.server.fastmcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.run_tds("abc", 2.0)
    mcp_server.run_tds("abc", 2.0, dae_vars=["omega GENROU 1"])
    mcp_server.list_dae_variables("abc", q="omega", kind="x")

    plain, recording, listing = seen
    assert json.loads(plain["body"]) == {"tf": 2.0}
    assert json.loads(recording["body"]) == {"tf": 2.0, "dae_vars": ["omega GENROU 1"]}
    assert listing["path"] == "/api/sessions/abc/dae-variables?q=omega&kind=x&limit=100"


def test_the_mcp_messages_tool_asks_for_warnings_unless_told_otherwise(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp.server.fastmcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.get_messages("abc")
    mcp_server.get_messages("abc", level="info", after=17)

    warnings, everything = seen
    assert warnings["path"] == "/api/sessions/abc/messages?level=warning&after=0"
    assert everything["path"] == "/api/sessions/abc/messages?level=info&after=17"


def test_the_mcp_metrics_tool_runs_the_simulation_and_returns_only_the_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mcp.server.fastmcp")
    from tensa import mcp_server

    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def fake_api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        calls.append((method, path, body))
        if path.endswith("/tds"):
            return {
                "converged": True,
                "final_t": 3.0,
                "traces": {
                    "t": [0.0, 1.0, 2.0],
                    "variables": [{"name": "omega GENROU 1", "values": [1.0, 0.99, 1.0]}],
                    "truncated": False,
                },
            }
        return {"results": [{"name": "omega GENROU 1", "error": None}]}

    monkeypatch.setattr(mcp_server, "_api", fake_api)

    answer = mcp_server.get_response_metrics("abc", 3.0, ["omega GENROU 1"], t_start=1.0)

    (_, tds_path, tds_body), (_, metrics_path, metrics_body) = calls
    assert tds_path == "/sessions/abc/tds"
    assert tds_body == {"tf": 3.0, "dae_vars": ["omega GENROU 1"]}
    assert metrics_path == "/response-metrics"
    assert metrics_body == {
        "series": [{"name": "omega GENROU 1", "t": [0.0, 1.0, 2.0], "y": [1.0, 0.99, 1.0]}],
        "t_start": 1.0,
    }
    assert answer == {
        "converged": True,
        "final_t": 3.0,
        "truncated": False,
        "metrics": [{"name": "omega GENROU 1", "error": None}],
    }


def _curl_commands(script: Path) -> list[str]:
    """The lines of a shell script that run ``curl``, continuation lines joined."""
    text = script.read_text(encoding="utf-8").replace("\\\n", " ")
    return [
        line.strip()
        for line in text.splitlines()
        if re.search(r"\bcurl\b", line) and not line.lstrip().startswith("#")
    ]


def test_the_curl_walkthrough_labels_every_json_body() -> None:
    script = _EXAMPLES / "walkthrough.sh"
    if not script.is_file():
        pytest.skip("examples/walkthrough.sh is not next to the tests")
    with_body = [line for line in _curl_commands(script) if re.search(r"\s-d\s", line)]
    # The walkthrough posts a case, a disturbance, a power flow, and a TDS run. Fewer
    # would mean the pattern above stopped finding the bodies.
    assert len(with_body) >= 4, with_body
    unlabeled = [line for line in with_body if f"Content-Type: {_JSON}" not in line]
    assert not unlabeled, f"curl sends -d as a form without a JSON Content-Type: {unlabeled}"
