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

import contextlib
import http.server
import io
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import textwrap
import threading
import urllib.error
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from tests._repo import REPO_ROOT, load_module

pytestmark = pytest.mark.unit

_EXAMPLES = REPO_ROOT / "examples"
_JSON = "application/json"


@contextlib.contextmanager
def _stand_in_server(
    answer: Callable[[str, str], bytes | tuple[int, bytes]],
) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    """A local server that records each request it gets and answers it with
    ``answer(method, path)``, the bytes of a JSON body, sent with 200 unless it
    comes with a status of its own."""
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
            answered = answer(self.command, self.path)
            status, payload = answered if isinstance(answered, tuple) else (200, answered)
            self.send_response(status)
            self.send_header("Content-Type", _JSON)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_DELETE = do_PUT = _answer

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


@pytest.fixture
def recorder() -> Iterator[tuple[str, list[dict[str, Any]]]]:
    """A local server that answers ``{"ok": true}`` and records each request it gets."""
    with _stand_in_server(lambda _method, _path: b'{"ok": true}') as served:
        yield served


def test_the_example_client_sends_a_json_body_as_json(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    app = client.TensaClient(base)

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
    pytest.importorskip("mcp")
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
    pytest.importorskip("mcp")
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
    session = client.Session(client.TensaClient(base), "abc")

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
    app = client.TensaClient(base)
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


def test_the_example_client_asks_for_a_comtrade_record_and_returns_its_bytes(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    app = client.TensaClient(base)
    traces = {"t": [0.0, 0.1], "variables": [{"name": "omega GENROU 1", "values": [1.0, 1.01]}]}

    archive = app.comtrade(traces["t"], traces["variables"], name="ieee14", trigger_t=0.1)

    (request,) = seen
    assert request["path"] == "/api/comtrade"
    assert request["content_type"] == _JSON
    assert json.loads(request["body"]) == {
        "t": [0.0, 0.1],
        "channels": [{"name": "omega GENROU 1", "values": [1.0, 1.01]}],
        "name": "ieee14",
        "trigger_t": 0.1,
    }
    # The answer is a .zip: it comes back as the bytes it is, not parsed as JSON.
    assert archive == b'{"ok": true}'


def test_the_example_client_reads_the_messages_of_a_session(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    session = client.Session(client.TensaClient(base), "abc")

    session.messages()
    session.messages(level="error", after=40)

    warnings, errors = seen
    assert warnings["path"] == "/api/sessions/abc/messages?level=warning&after=0"
    assert errors["path"] == "/api/sessions/abc/messages?level=error&after=40"


def test_the_example_client_runs_with_controllers_and_lists_what_they_can_command(
    recorder: tuple[str, list[dict[str, Any]]],
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    session = client.Session(client.TensaClient(base), "abc")
    droop = {"type": "droop", "model": "ESD1", "idx": 1, "gain": 50}

    session.tds_controllers()
    session.run_tds(5.0, controllers=[droop])

    listing, run = seen
    assert (listing["method"], listing["path"]) == ("GET", "/api/sessions/abc/tds/controllers")
    assert json.loads(run["body"]) == {"tf": 5.0, "controllers": [droop]}


def test_the_example_client_uploads_a_case_file_as_its_own_bytes(
    recorder: tuple[str, list[dict[str, Any]]], tmp_path: Path
) -> None:
    base, seen = recorder
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    app = client.TensaClient(base)
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
    pytest.importorskip("mcp")
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


def test_the_mcp_tds_tool_sends_its_controllers_and_lists_what_they_can_command(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)
    ffr = {"type": "ffr", "model": "ESD1", "idx": 1, "power": 20, "trigger_deviation": 0.1}

    mcp_server.run_tds("abc", 2.0, controllers=[ffr])
    mcp_server.run_tds("abc", 2.0, controllers=[])
    mcp_server.list_tds_controllers("abc")

    controlled, plain, listing = seen
    assert json.loads(controlled["body"]) == {"tf": 2.0, "controllers": [ffr]}
    # An empty list is not sent: the request body stays what it was without the option.
    assert json.loads(plain["body"]) == {"tf": 2.0}
    assert (listing["method"], listing["path"]) == ("GET", "/api/sessions/abc/tds/controllers")


def test_the_mcp_add_example_tool_posts_to_the_route_and_escapes_the_id(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.add_example("ieee14")
    mcp_server.add_example("a b/../c", overwrite=True)

    plain, escaped = seen
    assert (plain["method"], plain["path"]) == ("POST", "/api/examples/ieee14/add?overwrite=false")
    # An id is one path segment whatever it holds, and overwrite is asked for in so many words.
    assert escaped["path"] == "/api/examples/a%20b%2F..%2Fc/add?overwrite=true"


def test_the_mcp_list_examples_tool_shortens_the_catalog_and_gives_one_entry_in_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    full = {
        "id": "a",
        "title": "Case A",
        "summary": "For tests.",
        "category": "dynamic",
        "size": {"buses": 3, "generators": 1},
        "analyses": ["pf"],
        "default": True,
        "in_workspace": False,
        "differs": False,
        "available": True,
        "provenance": {"kind": "andes"},
        "licence": {"name": "GPL-3.0-or-later"},
        "citations": [{"role": "system", "text": "A long citation", "bibtex": "@misc{a}"}],
    }
    asked: list[tuple[str, str]] = []

    def api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        asked.append((method, path))
        return {"examples": [full]}

    monkeypatch.setattr(mcp_server, "_api", api)
    (brief,) = mcp_server.list_examples()
    # The listing leaves out what an agent reads only for one case: the citations and the rest.
    assert "citations" not in brief
    assert brief["source"] == "andes" and brief["licence"] == "GPL-3.0-or-later"
    assert brief["id"] == "a" and brief["in_workspace"] is False
    assert mcp_server.list_examples("a") == full
    assert asked == [("GET", "/examples")] * 2


def test_the_mcp_messages_tool_asks_for_warnings_unless_told_otherwise(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
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
    pytest.importorskip("mcp")
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


@pytest.mark.parametrize(
    ("dae_vars", "refusal"),
    [
        ([], "dae_vars names no variable"),
        ([f"v Bus {i}" for i in range(65)], "dae_vars names 65 variables; the metrics describe at most 64"),
    ],
)
def test_the_mcp_metrics_tool_refuses_what_the_metrics_would_before_it_runs_anything(
    monkeypatch: pytest.MonkeyPatch, dae_vars: list[str], refusal: str
) -> None:
    """With no variable the run records nothing and ``traces`` is null; with more
    than the metrics take, the whole run was made to be answered 422. The refusal is
    the SDK's tool error, the one exception whose text mcp 2 shows the agent."""
    pytest.importorskip("mcp")
    from tensa import mcp_server

    calls: list[str] = []
    monkeypatch.setattr(mcp_server, "_api", lambda _m, path, _b=None: calls.append(path))

    with pytest.raises(mcp_server._ToolError, match=refusal):
        mcp_server.get_response_metrics("abc", 3.0, dae_vars)
    assert calls == []


def test_the_mcp_metrics_tool_counts_a_name_given_twice_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server
    from tensa.api.schemas import MAX_METRIC_SERIES

    def fake_api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if path.endswith("/tds"):
            return {
                "converged": True,
                "final_t": 1.0,
                "traces": {"t": [0.0, 1.0], "variables": [], "truncated": False},
            }
        raise AssertionError(f"unexpected call to {path}")

    monkeypatch.setattr(mcp_server, "_api", fake_api)
    names = [f"v Bus {i}" for i in range(MAX_METRIC_SERIES)]

    # 64 names and one of them again is 64 variables, which a run takes.
    answer = mcp_server.get_response_metrics("abc", 1.0, [*names, names[0]])
    assert "error" in answer


@pytest.mark.parametrize(
    "traces", [None, {"t": [], "variables": [], "truncated": False}], ids=["null", "empty"]
)
def test_the_mcp_metrics_tool_says_so_when_the_run_recorded_nothing(
    monkeypatch: pytest.MonkeyPatch, traces: Any
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    calls: list[str] = []

    def fake_api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        calls.append(path)
        return {"converged": False, "final_t": 0.0, "traces": traces}

    monkeypatch.setattr(mcp_server, "_api", fake_api)

    answer = mcp_server.get_response_metrics("abc", 3.0, ["omega GENROU 1"])

    assert answer == {
        "converged": False,
        "final_t": 0.0,
        "error": "The run recorded none of the variables, so there is no response to describe.",
    }
    # The metrics were not asked for a body with no series, which they refuse.
    assert calls == ["/sessions/abc/tds"]


def test_the_mcp_metrics_tool_thins_a_run_with_more_samples_than_the_metrics_take(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server
    from tensa.api.schemas import MAX_METRIC_SAMPLES

    samples = 2 * MAX_METRIC_SAMPLES + 3
    sent: list[dict[str, Any]] = []

    def fake_api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if path.endswith("/tds"):
            return {
                "converged": True,
                "final_t": float(samples - 1),
                "traces": {
                    "t": [float(i) for i in range(samples)],
                    "variables": [{"name": "omega GENROU 1", "values": list(range(samples))}],
                    "truncated": False,
                },
            }
        assert body is not None
        sent.append(body)
        return {"results": [{"name": "omega GENROU 1", "error": None}]}

    monkeypatch.setattr(mcp_server, "_api", fake_api)

    answer = mcp_server.get_response_metrics("abc", 1.0, ["omega GENROU 1"])

    (series,) = sent[0]["series"]
    assert len(series["t"]) == len(series["y"]) <= MAX_METRIC_SAMPLES
    # Every third sample, each value still with its own time, and the last one kept.
    assert answer["every_nth_sample"] == 3
    assert len(series["t"]) > MAX_METRIC_SAMPLES // 2
    assert series["t"][:3] == [0.0, 3.0, 6.0]
    assert series["y"] == [int(t) for t in series["t"]]
    assert series["t"][-1] == float(samples - 1)


@pytest.mark.parametrize(
    ("samples", "every", "kept"),
    [
        (5, 1, [0, 1, 2, 3, 4]),
        (7, 3, [0, 3, 6]),
        (8, 3, [0, 3, 6, 7]),
        (2, 5, [0, 1]),
    ],
)
def test_thinning_keeps_the_first_sample_and_the_last(
    samples: int, every: int, kept: list[int]
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    assert list(mcp_server._thinned(samples, every)) == kept


def test_importing_the_mcp_server_imports_nothing_else_of_the_package() -> None:
    """It is a client of the HTTP API. The limits its metrics tool reads are the
    server's, in a module that brings the wrapper, numpy and pyarrow with it, so
    the tool reads them when it is called. In a fresh interpreter, where nothing
    has imported them yet."""
    pytest.importorskip("mcp")
    script = textwrap.dedent(
        """
        import json, sys
        import tensa.mcp_server

        print(json.dumps(sorted(m for m in sys.modules if m.startswith("tensa."))))
        """
    )
    done = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.strip().splitlines()[-1]) == ["tensa.mcp_server"]


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


# ---- the names the project and its client go by ------------------------------


def test_the_client_keeps_the_names_it_had_when_the_project_was_called_andes_app() -> None:
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    assert client.TensaClient.__name__ == "TensaClient"
    assert client.TensaClientError.__name__ == "TensaClientError"
    # The same classes, so a script that imports or catches the old names keeps working.
    assert client.AndesApp is client.TensaClient
    assert client.AndesAppError is client.TensaClientError


def test_a_refused_request_raises_the_client_error_that_both_names_catch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    problem = {
        "title": "Conflict",
        "detail": "a System is loaded",
        "recovery": {"kind": "reload-case"},
    }

    def refuse(request: Any, timeout: float | None = None) -> Any:
        body = io.BytesIO(json.dumps(problem).encode())
        raise urllib.error.HTTPError(request.full_url, 409, "Conflict", {}, body)

    monkeypatch.setattr(client.urllib.request, "urlopen", refuse)

    with pytest.raises(client.AndesAppError) as raised:
        client.TensaClient("http://127.0.0.1:1").request("POST", "/sessions/abc/case", {})
    assert isinstance(raised.value, client.TensaClientError)
    assert (raised.value.status, raised.value.problem) == (409, problem)
    assert "[409] Conflict: a System is loaded" in str(raised.value)


def test_the_pages_and_the_examples_name_the_client_by_its_current_name() -> None:
    """The class is ``TensaClient``; ``AndesApp`` stays only so that old scripts run, and
    the examples README says so. No page teaches it, and every name a page imports is there."""
    client = load_module("tensa_client", _EXAMPLES / "tensa_client.py")
    pages = [
        *sorted((REPO_ROOT / "docs").glob("*.md")),
        REPO_ROOT / "README.md",
        REPO_ROOT / "llms.txt",
        _EXAMPLES / "run_fault_study.py",
    ]
    for page in pages:
        text = page.read_text(encoding="utf-8")
        assert "AndesApp" not in text, f"{page.relative_to(REPO_ROOT)} teaches the old name"
        for name in re.findall(r"from tensa_client import (\w+)", text):
            assert hasattr(client, name), f"{page.relative_to(REPO_ROOT)} imports {name}"
    assert "TensaClient" in (REPO_ROOT / "docs" / "quickstart.md").read_text(encoding="utf-8")


# The walkthrough reads which server and which case from the environment: ``TENSA_URL`` and
# ``TENSA_CASE``, and ``ANDES_APP_URL`` and ``ANDES_APP_CASE``, their names while the project
# was called ANDES App, when those are not set.
_NEEDS_A_SHELL = pytest.mark.skipif(
    sys.platform == "win32" or not all(shutil.which(tool) for tool in ("bash", "curl", "python3")),
    reason="the scripts are for a POSIX shell with curl and python3",
)
_WALKTHROUGH_ANSWER = json.dumps(
    {"session_id": "s1", "state": "loaded", "converged": True, "bus_voltages": {"1": 1.0}}
).encode()


def _clean_environment() -> dict[str, str]:
    """This process's environment without anything the scripts read, and with a proxy
    setting that cannot send a loopback address elsewhere."""
    env = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith(("TENSA_", "ANDES_APP"))
    }
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1"
    return env


def _run_walkthrough(
    variables: dict[str, str],
) -> tuple[subprocess.CompletedProcess[str], list[dict[str, Any]]]:
    """Run ``examples/walkthrough.sh`` against a stand-in server, with ``variables`` in its
    environment; ``{base}`` in a value is the stand-in's address."""
    script = _EXAMPLES / "walkthrough.sh"
    if not script.is_file():
        pytest.skip("examples/walkthrough.sh is not next to the tests")
    with _stand_in_server(lambda _method, _path: _WALKTHROUGH_ANSWER) as (base, seen):
        env = {**_clean_environment(), **{k: v.format(base=base) for k, v in variables.items()}}
        done = subprocess.run(
            ["bash", str(script)],
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )
    return done, seen


@_NEEDS_A_SHELL
@pytest.mark.parametrize(
    "variables",
    [
        {"TENSA_URL": "{base}"},
        {"TENSA_URL": "{base}/"},
        {"TENSA_URL": "{base}/api"},
        {"ANDES_APP_URL": "{base}"},
        {"TENSA_URL": "{base}", "ANDES_APP_URL": "http://127.0.0.1:9"},
    ],
    ids=["new", "with the slash the server prints", "with /api", "old name", "new wins"],
)
def test_the_curl_walkthrough_finds_the_server_by_either_name_of_its_address(
    variables: dict[str, str],
) -> None:
    done, seen = _run_walkthrough(variables)
    assert done.returncode == 0, done.stderr + done.stdout
    assert seen[0]["method"] == "POST" and seen[0]["path"] == "/api/sessions"
    assert all(request["path"].startswith("/api/sessions") for request in seen)


@_NEEDS_A_SHELL
@pytest.mark.parametrize(
    ("variables", "loaded"),
    [
        ({"TENSA_URL": "{base}"}, "ieee14_full.xlsx"),
        ({"TENSA_URL": "{base}", "TENSA_CASE": "a.xlsx"}, "a.xlsx"),
        ({"TENSA_URL": "{base}", "ANDES_APP_CASE": "b.xlsx"}, "b.xlsx"),
        ({"TENSA_URL": "{base}", "TENSA_CASE": "a.xlsx", "ANDES_APP_CASE": "b.xlsx"}, "a.xlsx"),
    ],
    ids=["default", "new", "old name", "new wins"],
)
def test_the_curl_walkthrough_loads_the_case_named_by_either_name_of_the_variable(
    variables: dict[str, str], loaded: str
) -> None:
    done, seen = _run_walkthrough(variables)
    assert done.returncode == 0, done.stderr + done.stdout
    (case,) = [r for r in seen if r["path"].endswith("/case")]
    assert json.loads(case["body"]) == {"primary_path": loaded}


def _closed_ports(count: int) -> list[int]:
    """Loopback ports nothing listens on, all different: every probe is bound before any is
    let go, so the system cannot hand one port out twice."""
    probes = [socket.socket() for _ in range(count)]
    try:
        for probe in probes:
            probe.bind(("127.0.0.1", 0))
        return [int(probe.getsockname()[1]) for probe in probes]
    finally:
        for probe in probes:
            probe.close()


@_NEEDS_A_SHELL
def test_the_acceptance_walkthrough_takes_the_port_by_either_name() -> None:
    script = Path(__file__).resolve().parents[1] / "acceptance" / "walkthrough.sh"
    if not script.is_file():
        pytest.skip("server/tests/acceptance/walkthrough.sh is not next to the tests")
    ports = _closed_ports(2)

    def run(**variables: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(script)],
            env={**_clean_environment(), **variables},
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )

    # Nothing listens, so each run stops at its first request and names the port it used.
    new = run(TENSA_PORT=str(ports[0]))
    old = run(ANDES_APP_PORT=str(ports[1]))
    both = run(TENSA_PORT=str(ports[0]), ANDES_APP_PORT=str(ports[1]))
    assert str(ports[0]) in new.stderr
    assert str(ports[1]) in old.stderr
    assert str(ports[0]) in both.stderr and str(ports[1]) not in both.stderr
    neither = run()
    assert neither.returncode == 2
    assert "TENSA_PORT must be set" in neither.stderr


@_NEEDS_A_SHELL
def test_the_api_type_script_starts_the_tensa_it_is_given_by_either_name() -> None:
    script = REPO_ROOT / "web" / "scripts" / "regenerate-api-types.sh"
    if not script.is_file():
        pytest.skip("web/scripts/regenerate-api-types.sh is not next to the tests")
    text = script.read_text(encoding="utf-8")
    (assignment,) = [line for line in text.splitlines() if line.startswith("TENSA_BIN=")]
    assert '"$TENSA_BIN" serve' in text

    def resolved(**variables: str) -> str:
        done = subprocess.run(
            ["bash", "-c", f'{assignment}\nprintf %s "$TENSA_BIN"'],
            env={**_clean_environment(), **variables},
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=True,
        )
        return done.stdout

    assert resolved() == "tensa"
    assert resolved(TENSA_BIN="/new/tensa") == "/new/tensa"
    assert resolved(ANDES_APP="/old/tensa") == "/old/tensa"
    assert resolved(TENSA_BIN="/new/tensa", ANDES_APP="/old/tensa") == "/new/tensa"


def _regen_script(tmp_path: Path, tensa: str) -> tuple[Path, dict[str, str]]:
    """A copy of ``regenerate-api-types.sh`` in a folder of its own, so that the real
    ``generated.ts`` cannot be touched, and a ``TENSA_BIN`` that is the script ``tensa``."""
    script = REPO_ROOT / "web" / "scripts" / "regenerate-api-types.sh"
    if not script.is_file():
        pytest.skip("web/scripts/regenerate-api-types.sh is not next to the tests")
    copy = tmp_path / "web" / "scripts" / script.name
    copy.parent.mkdir(parents=True)
    shutil.copy(script, copy)
    fake = tmp_path / "tensa"
    fake.write_text(tensa, encoding="utf-8")
    fake.chmod(0o755)
    return copy, {**_clean_environment(), "TENSA_BIN": str(fake)}


@_NEEDS_A_SHELL
def test_the_api_type_script_stops_when_something_else_answers_on_its_port(
    tmp_path: Path,
) -> None:
    """When the port was taken, ``tensa serve`` stopped with status 3 and the script read the
    schema of whatever listened there and reported ``generated.ts`` up to date."""
    with _stand_in_server(lambda _method, _path: b"{}") as (base, _seen):
        copy, env = _regen_script(tmp_path, "#!/bin/sh\nexit 3\n")
        done = subprocess.run(
            ["bash", str(copy)],
            env={**env, "PORT": base.rsplit(":", 1)[1]},
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )
    assert done.returncode == 1, done.stderr + done.stdout
    assert "is in use" in done.stderr
    assert "up to date" not in done.stdout


@_NEEDS_A_SHELL
def test_the_api_type_script_stops_when_the_server_it_started_stops(tmp_path: Path) -> None:
    """A server that cannot start is no reason to wait out the ten seconds the script gives it."""
    copy, env = _regen_script(tmp_path, "#!/bin/sh\nexit 3\n")
    (port,) = _closed_ports(1)
    done = subprocess.run(
        ["bash", str(copy)],
        env={**env, "PORT": str(port)},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    assert done.returncode == 1, done.stderr + done.stdout
    assert "stopped before it was ready" in done.stderr


def test_the_mcp_server_reports_the_version_of_tensa_and_not_the_one_of_the_mcp_library() -> None:
    """A client shows ``serverInfo.version`` as the version of the server it talks to. On mcp
    1.x the server takes none, and the library fills in its own, which was 1.30.0 where this
    was found; on 2.x it is empty unless the server is given one. The handshake is made over
    the server's real standard input and output."""
    pytest.importorskip("mcp")
    import importlib.metadata

    import tensa

    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "0"},
        },
    }
    done = subprocess.run(
        [sys.executable, "-m", "tensa", "mcp", "--url", "http://127.0.0.1:9"],
        input=json.dumps(initialize) + "\n",
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.stdout.strip(), done.stderr
    server_info = json.loads(done.stdout.splitlines()[0])["result"]["serverInfo"]
    assert server_info["name"] == "tensa"
    assert server_info["version"] == tensa.__version__
    assert server_info["version"] != importlib.metadata.version("mcp")


def _mcp_conversation(base: str, requests: list[dict[str, Any]], log: Path) -> list[dict[str, Any]]:
    """Start ``tensa mcp --url base``, make the handshake an MCP client makes, then send each
    request over its standard input, waiting for the answer to one before the next, and
    return the answers. What the server logs goes to ``log``."""
    with log.open("w", encoding="utf-8") as stderr:
        server = subprocess.Popen(
            [sys.executable, "-m", "tensa", "mcp", "--url", base],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env=_clean_environment(),
            text=True,
            encoding="utf-8",
        )
    assert server.stdin is not None and server.stdout is not None
    lines: queue.Queue[str] = queue.Queue()
    reader = threading.Thread(
        target=lambda: [lines.put(line) for line in server.stdout], daemon=True
    )
    reader.start()

    def ask(request_id: int, method: str, params: dict[str, Any]) -> dict[str, Any]:
        assert server.stdin is not None
        message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        try:
            server.stdin.write(json.dumps(message) + "\n")
            server.stdin.flush()
        except OSError:
            raise AssertionError(f"tensa mcp stopped: {log.read_text('utf-8')}") from None
        while True:
            try:
                answer: dict[str, Any] = json.loads(lines.get(timeout=120))
            except queue.Empty:
                raise AssertionError(f"no answer to {method}: {log.read_text('utf-8')}") from None
            if answer.get("id") == request_id:
                return answer

    try:
        ask(
            0,
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            },
        )
        server.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        server.stdin.write("\n")
        return [ask(i, r["method"], r.get("params", {})) for i, r in enumerate(requests, 1)]
    finally:
        server.stdin.close()
        try:
            server.wait(timeout=30)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        # The child is gone, so the reader comes to the end of its output.
        reader.join(timeout=30)
        server.stdout.close()


def test_the_mcp_server_answers_its_tools_and_passes_on_what_the_api_refused(
    tmp_path: Path,
) -> None:
    """As an MCP client drives it, over its real standard input and output: every tool is
    listed, a call answers with what the HTTP API answered, and a refusal of the API reaches
    the agent with its detail and its recovery. mcp 2 shows the agent the text of its tool
    error only, and answers any other exception with the tool's name alone."""
    pytest.importorskip("mcp")
    from tensa import mcp_server

    files = {"files": [{"path": "ieee14.raw"}]}
    engines = {"engines": []}
    refusal = {"title": "Conflict", "detail": "no power flow", "recovery": {"kind": "run-pflow"}}
    # What an ANDES session answers for the dispatch, which only Sienna has.
    unsupported = {
        "title": "Conflict",
        "detail": "'run_dispatch' is not available with the andes engine; engines that have it: sienna",
        "recovery": None,
    }

    def answer(_method: str, path: str) -> bytes | tuple[int, bytes]:
        if path == "/api/workspace/files":
            return json.dumps(files).encode()
        if path == "/api/engines":
            return json.dumps(engines).encode()
        if path == "/api/sessions/abc/dispatch":
            return 409, json.dumps(unsupported).encode()
        return 409, json.dumps(refusal).encode()

    def call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return {"method": "tools/call", "params": {"name": name, "arguments": arguments}}

    with _stand_in_server(answer) as (base, seen):
        listed, listing, refused, engines_listing, dispatch_refused = _mcp_conversation(
            base,
            [
                {"method": "tools/list"},
                call("list_workspace_files", {}),
                call("run_eig", {"session_id": "abc"}),
                call("list_engines", {}),
                call("run_dispatch", {"session_id": "abc"}),
            ],
            tmp_path / "mcp.log",
        )

    source = Path(mcp_server.__file__).read_text(encoding="utf-8")
    declared = set(re.findall(r"^@mcp\.tool\(\)\ndef (\w+)", source, flags=re.MULTILINE))
    assert len(declared) > 10, "the pattern above stopped finding the tools"
    assert {tool["name"] for tool in listed["result"]["tools"]} == declared
    assert listing["result"]["isError"] is False
    assert json.loads(listing["result"]["content"][0]["text"]) == files
    assert refused["result"]["isError"] is True
    text = refused["result"]["content"][0]["text"]
    assert "Conflict (409): no power flow Recovery: run-pflow." in text
    assert engines_listing["result"]["isError"] is False
    assert json.loads(engines_listing["result"]["content"][0]["text"]) == engines
    assert dispatch_refused["result"]["isError"] is True
    dispatch_text = dispatch_refused["result"]["content"][0]["text"]
    assert "engines that have it: sienna" in dispatch_text
    assert [request["path"] for request in seen] == [
        "/api/workspace/files",
        "/api/sessions/abc/eig",
        "/api/engines",
        "/api/sessions/abc/dispatch",
    ]


def test_the_mcp_create_session_tool_names_the_engine(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.create_session()
    mcp_server.create_session("sienna")

    andes, sienna = seen
    # Without an engine the call is what it was before engines: no body,
    # which the server reads as ANDES.
    assert andes["method"] == "POST"
    assert andes["path"] == "/api/sessions"
    assert andes["body"] == b""
    assert sienna["method"] == "POST"
    assert sienna["path"] == "/api/sessions"
    assert sienna["content_type"] == _JSON
    assert json.loads(sienna["body"]) == {"engine": "sienna"}


def test_the_mcp_list_engines_tool_asks_the_route(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.list_engines()

    (request,) = seen
    assert request["method"] == "GET"
    assert request["path"] == "/api/engines"
    assert request["body"] == b""


def test_the_mcp_get_keys_tool_asks_the_session_route(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.get_keys("abc")

    (request,) = seen
    assert request["method"] == "GET"
    assert request["path"] == "/api/sessions/abc/keys"
    assert request["body"] == b""


def test_the_mcp_network_matrix_tool_sends_the_kind_and_defaults_to_ptdf(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.network_matrix("abc")
    mcp_server.network_matrix("abc", kind="lodf")

    ptdf, lodf = seen
    assert ptdf["path"] == "/api/sessions/abc/network-matrix?kind=ptdf"
    assert lodf["path"] == "/api/sessions/abc/network-matrix?kind=lodf"


def test_the_mcp_dispatch_tool_sends_the_network_model_and_duals_only_when_asked(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.run_dispatch("abc")
    mcp_server.run_dispatch("abc", network_model="dc", duals=True)

    plain, with_duals = seen
    assert json.loads(plain["body"]) == {"network_model": "copper_plate"}
    assert json.loads(with_duals["body"]) == {"network_model": "dc", "duals": True}


def test_the_mcp_convert_result_tool_sends_the_result_and_the_options_it_was_given(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.convert_result("pflow", "andes", {"converged": True})
    mcp_server.convert_result(
        "tds",
        "andes",
        {"t": [0.0], "variables": []},
        keys=[{"key": "bus:1", "bucket": "bus", "model": "Bus", "idx": "1", "source": "case"}],
        status="completed",
    )

    pflow, tds = seen
    assert json.loads(pflow["body"]) == {
        "kind": "pflow",
        "engine": "andes",
        "result": {"converged": True},
        "status": "completed",
    }
    assert "versions" not in json.loads(pflow["body"])
    assert "study" not in json.loads(pflow["body"])
    assert "keys" not in json.loads(pflow["body"])
    tds_body = json.loads(tds["body"])
    assert tds_body["keys"] == [{"key": "bus:1", "bucket": "bus", "model": "Bus", "idx": "1", "source": "case"}]


def test_the_mcp_compare_tool_sends_the_two_documents_and_tolerances_only_when_given(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.compare_results({"tensa_results": 1}, {"tensa_results": 1})
    mcp_server.compare_results({}, {}, tolerances={"frequency_hz": 0.01})

    plain, with_tolerances = seen
    assert json.loads(plain["body"]) == {
        "reference": {"tensa_results": 1},
        "comparison": {"tensa_results": 1},
    }
    assert "tolerances" not in json.loads(plain["body"])
    assert json.loads(with_tolerances["body"])["tolerances"] == {"frequency_hz": 0.01}


def test_the_mcp_element_tools_reach_the_element_routes(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.add_element("abc", "PQ", {"bus": "7", "p0": 10.0})
    mcp_server.edit_element("abc", "PQ", "PQ_1", {"p0": 12.0})
    mcp_server.delete_element("abc", "PQ", "PQ_1")
    mcp_server.delete_element("abc", "Line", "Line_6", cascade=True)
    mcp_server.undo_last_edit("abc")
    mcp_server.redo_edit("abc")

    add, edit, delete_plain, delete_cascade, undo, redo = seen
    assert add["method"] == "POST"
    assert add["path"] == "/api/sessions/abc/elements"
    assert json.loads(add["body"]) == {"model": "PQ", "params": {"bus": "7", "p0": 10.0}}
    assert edit["method"] == "PUT"
    assert edit["path"] == "/api/sessions/abc/elements/PQ/PQ_1"
    # The body EditElementRequest takes: the params by name.
    assert json.loads(edit["body"]) == {"params": {"p0": 12.0}}
    assert delete_plain["method"] == "DELETE"
    assert delete_plain["path"] == "/api/sessions/abc/elements/PQ/PQ_1?cascade=false"
    assert delete_cascade["method"] == "DELETE"
    assert delete_cascade["path"] == "/api/sessions/abc/elements/Line/Line_6?cascade=true"
    assert undo["method"] == "POST"
    assert undo["path"] == "/api/sessions/abc/undo-last-edit"
    assert json.loads(undo["body"]) == {}
    assert redo["method"] == "POST"
    assert redo["path"] == "/api/sessions/abc/redo-edit"
    assert json.loads(redo["body"]) == {}


def test_the_mcp_edit_tools_escape_the_model_and_the_idx(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.edit_element("abc", "PQ", "a b/1", {"p0": 1.0})

    (request,) = seen
    assert request["path"] == "/api/sessions/abc/elements/PQ/a%20b%2F1"


def test_the_mcp_helper_passes_an_engine_refusal_on_with_its_engines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An op the session's engine lacks is a 409 whose detail names the
    engines that have it (``EngineUnsupportedError``'s message); the agent
    reads that detail whole."""
    pytest.importorskip("mcp")
    from tensa import mcp_server
    from tensa.core.errors import EngineUnsupportedError

    detail = str(EngineUnsupportedError("run_cpf", "sienna", ["andes"]))
    problem = {"title": "Conflict", "detail": detail, "recovery": None}

    def refuse(request: Any, timeout: float | None = None) -> Any:
        body = io.BytesIO(json.dumps(problem).encode())
        raise urllib.error.HTTPError(request.full_url, 409, "Conflict", {}, body)

    monkeypatch.setattr(mcp_server.urllib.request, "urlopen", refuse)

    with pytest.raises(mcp_server._ToolError) as raised:
        mcp_server._api("POST", "/sessions/abc/cpf", {})
    assert str(raised.value) == (
        "Conflict (409): 'run_cpf' is not available with the sienna engine; "
        "engines that have it: andes"
    )


def test_the_mcp_run_tools_send_the_engine_options_only_when_given(
    recorder: tuple[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    base, seen = recorder
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)

    mcp_server.load_case("abc", "kundur.raw", ["kundur_full.dyr"])
    mcp_server.load_case("abc", "kundur.raw", ["kundur_full.dyr"], on_unsupported="drop")
    mcp_server.run_pflow("abc")
    mcp_server.run_pflow("abc", method="dc")
    mcp_server.run_tds("abc", 1.0)
    mcp_server.run_tds("abc", 1.0, load_model="power")

    load, load_drop, pflow, pflow_dc, tds, tds_power = (json.loads(r["body"]) for r in seen)
    assert load == {"primary_path": "kundur.raw", "addfiles": ["kundur_full.dyr"]}
    assert load_drop == {
        "primary_path": "kundur.raw",
        "addfiles": ["kundur_full.dyr"],
        "on_unsupported": "drop",
    }
    assert pflow == {}
    assert pflow_dc == {"method": "dc"}
    assert tds == {"tf": 1.0}
    assert tds_power == {"tf": 1.0, "load_model": "power"}


def test_every_mcp_tool_description_names_its_engines() -> None:
    """Every tool's docstring names the engines that have it, except the sessionless ones."""
    pytest.importorskip("mcp")
    from tensa import mcp_server

    sessionless = {
        "list_workspace_files",
        "list_examples",
        "add_example",
        "list_engines",
        "convert_result",
        "compare_results",
    }
    source = Path(mcp_server.__file__).read_text(encoding="utf-8")
    declared = re.findall(r"^@mcp\.tool\(\)\ndef (\w+)", source, flags=re.MULTILINE)
    for name in declared:
        func = getattr(mcp_server, name)
        docstring = func.__doc__ or ""
        if name not in sessionless:
            assert "Engines:" in docstring, f"{name} does not name its engines"


def test_the_mcp_instructions_name_both_engines() -> None:
    pytest.importorskip("mcp")
    from tensa import mcp_server

    assert "ANDES" in mcp_server._INSTRUCTIONS
    assert "Sienna" in mcp_server._INSTRUCTIONS
    assert "list_engines" in mcp_server._INSTRUCTIONS


def test_the_mcp_helper_says_so_when_the_server_does_not_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A TENSA that is not running is a failure for the agent to read too, not a crash
    whose text mcp 2 keeps in the server's log."""
    pytest.importorskip("mcp")
    from tensa import mcp_server

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        base = f"http://127.0.0.1:{probe.getsockname()[1]}"
    # Nothing listens on the port once the socket is closed.
    monkeypatch.setattr(mcp_server, "_BASE_URL", base)
    with pytest.raises(mcp_server._ToolError, match=f"TENSA at {base} did not answer"):
        mcp_server._api("GET", "/workspace/files")


@pytest.mark.parametrize(
    ("body", "said"),
    [
        (b"<html>not json</html>", "answered GET /api/workspace/files with a body that is not JSON"),
        (None, "did not answer in full: IncompleteRead"),
    ],
    ids=["not JSON", "cut short"],
)
def test_the_mcp_helper_says_so_when_an_answer_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch, body: bytes | None, said: str
) -> None:
    """A 200 whose body is not JSON, or one that stops before the length it announced, is
    a failure for the agent to read as well, not an exception mcp 2 answers with the tool's
    name alone."""
    pytest.importorskip("mcp")
    from tensa import mcp_server

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            payload = body if body is not None else b'{"files": ['
            self.send_response(200)
            self.send_header("Content-Type", _JSON)
            # Cut short: the length announced is more than what is sent.
            self.send_header("Content-Length", str(len(payload) + (100 if body is None else 0)))
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setattr(mcp_server, "_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}")
        with pytest.raises(mcp_server._ToolError, match=re.escape(said)):
            mcp_server._api("GET", "/workspace/files")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize(
    ("missing", "said", "not_said"),
    [
        ("mcp", "pip install 'tensa[mcp]'", "Traceback"),
        ("anyio", "anyio", "tensa[mcp]"),
    ],
)
def test_the_mcp_server_names_what_it_cannot_import(missing: str, said: str, not_said: str) -> None:
    """Without the SDK it asks for the extra. With the SDK, a module the SDK needs and cannot
    find is named as itself: an import error of any kind was once reported as a missing
    extra, which is how mcp 2, where the class TENSA imported was gone, looked like no SDK."""
    pytest.importorskip("mcp")
    script = f"import sys; sys.modules[{missing!r}] = None; import tensa.mcp_server"
    done = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode != 0
    assert said in done.stderr
    assert not_said not in done.stderr
