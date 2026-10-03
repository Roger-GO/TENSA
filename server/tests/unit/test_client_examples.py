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
