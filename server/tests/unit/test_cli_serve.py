"""``tensa serve`` CLI wiring (no ANDES, no real server).

The bug these cover: ``--port 0`` (the default) used to build the app with
``bind_port=0`` before uvicorn bound the real port, so the Host/Origin
allow-list held only port-less origins and the SPA's
``Origin: http://127.0.0.1:<real port>`` was rejected with ``400 bad-origin``.
``serve`` now binds the socket first, builds the app from the real port, and
hands uvicorn that same socket.

uvicorn's ``Server`` is replaced by a fake that records what it was given, so
the tests exercise ``serve``'s wiring without a listening server.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from typer.testing import CliRunner

from tensa import cli
from tensa.api.app import make_app
from tensa.core.logging_setup import reset_logging

pytestmark = pytest.mark.unit

runner = CliRunner()


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """``serve`` configures the root logger, which outlives the test that ran it."""
    root = logging.getLogger()
    level = root.level
    yield
    reset_logging()
    root.setLevel(level)


class _FakeServer:
    """Stands in for ``uvicorn.Server``: records ``run(sockets=...)`` and, like
    a server that came up, flips ``started`` unless told not to."""

    instances: list[_FakeServer] = []
    start_ok = True

    def __init__(self, config: Any) -> None:
        self.config = config
        self.started = False
        self.sockets: list[socket.socket] | None = None
        self.bound_port_during_run: int | None = None
        _FakeServer.instances.append(self)

    def run(self, sockets: list[socket.socket] | None = None) -> None:
        self.sockets = sockets
        if sockets:
            self.bound_port_during_run = int(sockets[0].getsockname()[1])
        self.started = type(self).start_ok


class _FakeWarm:
    """Stands in for the background ``warm-cache`` child: records ``stop``."""

    def __init__(self) -> None:
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True


@pytest.fixture
def warm_starts(monkeypatch: pytest.MonkeyPatch) -> list[_FakeWarm]:
    """Replace the background warm-up, which would start a real process, with a
    recorder: one ``_FakeWarm`` per start."""
    started: list[_FakeWarm] = []

    def _start(andes_version: str, log: Any) -> _FakeWarm:
        started.append(_FakeWarm())
        return started[-1]

    monkeypatch.setattr(cli, "start_background_warm", _start)
    return started


@pytest.fixture
def fake_server(
    monkeypatch: pytest.MonkeyPatch, warm_starts: list[_FakeWarm]
) -> type[_FakeServer]:
    _FakeServer.instances = []
    _FakeServer.start_ok = True
    monkeypatch.setattr(cli.uvicorn, "Server", _FakeServer)
    # Seeding copies ANDES example files into the workspace; irrelevant here.
    monkeypatch.setattr(cli, "seed_example_cases", lambda _ws: [])
    return _FakeServer


@pytest.fixture
def built_apps(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Spy on ``make_app``: record each call's kwargs, build the real app."""
    calls: list[dict[str, Any]] = []

    def _spy(**kwargs: Any) -> FastAPI:
        app = make_app(**kwargs)
        calls.append({"kwargs": kwargs, "app": app})
        return app

    monkeypatch.setattr(cli, "make_app", _spy)
    return calls


def _get(app: FastAPI, port: int, origin: str | None) -> int:
    """GET ``/openapi.json`` (needs no session state) as a browser on ``port``."""
    headers = {"Origin": origin} if origin is not None else {}
    client = TestClient(app, base_url=f"http://127.0.0.1:{port}")
    return client.get("/openapi.json", headers=headers).status_code


# ------------------------------------------------------- bind + socket options


def test_bind_listen_socket_resolves_port_zero_to_a_real_port() -> None:
    sock = cli._bind_listen_socket("127.0.0.1", 0)
    try:
        port = int(sock.getsockname()[1])
        assert port > 0
        # The port is held by this socket, so nothing else can take it while
        # the app is being built.
        rival = socket.socket()
        try:
            with pytest.raises(OSError):
                rival.bind(("127.0.0.1", port))
        finally:
            rival.close()
    finally:
        sock.close()


def test_bind_listen_socket_raises_when_port_is_taken() -> None:
    holder = socket.socket()
    try:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        taken = int(holder.getsockname()[1])
        with pytest.raises(OSError):
            cli._bind_listen_socket("127.0.0.1", taken)
    finally:
        holder.close()


class _RecordingSocket:
    def __init__(self) -> None:
        self.options: list[tuple[int, int, int]] = []

    def setsockopt(self, level: int, optname: int, value: int) -> None:
        self.options.append((level, optname, value))


def test_bind_options_use_reuseaddr_on_posix() -> None:
    sock = _RecordingSocket()
    cli._apply_bind_options(sock, platform="linux")  # type: ignore[arg-type]
    assert sock.options == [(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)]


def test_bind_options_use_exclusive_addr_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The constant only exists on Windows; fake it so the branch runs here.
    monkeypatch.setattr(socket, "SO_EXCLUSIVEADDRUSE", -5, raising=False)
    sock = _RecordingSocket()
    cli._apply_bind_options(sock, platform="win32")  # type: ignore[arg-type]
    assert sock.options == [(socket.SOL_SOCKET, -5, 1)]
    # Never SO_REUSEADDR on Windows: it would let another process share the port.
    assert all(opt[1] != socket.SO_REUSEADDR for opt in sock.options)


def test_bind_options_set_nothing_on_windows_without_exclusive_addr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(socket, "SO_EXCLUSIVEADDRUSE", raising=False)
    sock = _RecordingSocket()
    cli._apply_bind_options(sock, platform="win32")  # type: ignore[arg-type]
    assert sock.options == []


# ------------------------------------------------------------- serve wiring


def test_serve_builds_the_app_with_the_real_bound_port(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0"]
    )
    assert result.exit_code == 0, result.output

    (server,) = fake_server.instances
    assert server.sockets is not None and len(server.sockets) == 1
    port = server.bound_port_during_run
    assert port is not None and port > 0

    # The app, uvicorn's config, and the socket uvicorn serves on agree.
    (built,) = built_apps
    assert built["kwargs"]["bind_port"] == port
    assert server.config.port == port

    # The SPA's real origin is accepted; a different port still is not.
    app = built["app"]
    assert _get(app, port, f"http://127.0.0.1:{port}") == 200
    assert _get(app, port, f"http://localhost:{port}") == 200
    assert _get(app, port, f"http://127.0.0.1:{port + 1}") == 400


def test_serve_exits_3_without_building_the_app_when_the_port_is_taken(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    holder = socket.socket()
    try:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        taken = int(holder.getsockname()[1])
        result = runner.invoke(
            cli.app,
            ["serve", "--workspace", str(tmp_path / "ws"), "--port", str(taken)],
        )
    finally:
        holder.close()
    assert result.exit_code == 3
    assert built_apps == []
    assert fake_server.instances == []


def test_serve_exits_3_when_the_server_never_starts(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    fake_server.start_ok = False
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0"]
    )
    assert result.exit_code == 3


def test_serve_open_browser_works_with_port_zero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    opened: list[str] = []
    done = threading.Event()

    def _open(url: str, new: int = 0) -> bool:
        opened.append(url)
        done.set()
        return True

    monkeypatch.setattr(cli.webbrowser, "open", _open)
    result = runner.invoke(
        cli.app,
        ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0", "--open"],
    )
    assert result.exit_code == 0, result.output
    assert done.wait(5.0), "browser was not opened"
    port = fake_server.instances[0].bound_port_during_run
    assert port is not None and port > 0
    assert opened == [f"http://127.0.0.1:{port}/"]


def test_serve_reload_resolves_port_zero_for_the_app_factory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
) -> None:
    run_kwargs: dict[str, Any] = {}
    monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **kw: run_kwargs.update(kw))
    with mock.patch.dict(os.environ):
        result = runner.invoke(
            cli.app,
            [
                "serve",
                "--workspace",
                str(tmp_path / "ws"),
                "--port",
                "0",
                "--reload",
            ],
        )
        assert result.exit_code == 0, result.output
        port = run_kwargs["port"]
        assert port > 0
        assert os.environ["ANDES_APP_RELOAD_PORT"] == str(port)
        # The reloader's subprocess builds the app from those env vars.
        app = cli._reload_app_factory()
    assert _get(app, port, f"http://127.0.0.1:{port}") == 200


def test_serve_prints_the_real_url(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("INFO", logger="tensa.serve"):
        result = runner.invoke(
            cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0"]
        )
    assert result.exit_code == 0, result.output
    port = fake_server.instances[0].bound_port_during_run
    assert f"serving http://127.0.0.1:{port}/" in caplog.text
    assert "os-assigned" not in caplog.text


# ------------------------------------------------------ generated-code warm-up


def test_serve_warms_the_generated_code_while_the_server_runs_and_stops_it_after(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    warm_starts: list[_FakeWarm],
) -> None:
    during_run: list[bool] = []
    run = fake_server.run

    def _run(self: _FakeServer, sockets: list[socket.socket] | None = None) -> None:
        during_run.extend(w.stopped for w in warm_starts)
        run(self, sockets)

    monkeypatch.setattr(fake_server, "run", _run)
    result = runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    # Started before the server ran, and still running while it did.
    assert during_run == [False]
    (warm,) = warm_starts
    assert warm.stopped


def test_serve_ends_the_warm_up_child_when_the_server_dies(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    warm_starts: list[_FakeWarm],
) -> None:
    def _crash(self: _FakeServer, sockets: list[socket.socket] | None = None) -> None:
        raise RuntimeError("the server crashed")

    monkeypatch.setattr(fake_server, "run", _crash)
    result = runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")])
    assert result.exit_code == 1
    (warm,) = warm_starts
    assert warm.stopped


def test_serve_checks_the_cache_against_the_installed_andes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
) -> None:
    versions: list[str] = []
    monkeypatch.setattr(cli, "_andes_version", lambda: "9.9.9")
    monkeypatch.setattr(cli, "start_background_warm", lambda v, log: versions.append(v))
    assert runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")]).exit_code == 0
    assert versions == ["9.9.9"]


def test_serve_with_no_warm_cache_starts_no_child(
    tmp_path: Path, fake_server: type[_FakeServer], warm_starts: list[_FakeWarm]
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--no-warm-cache"]
    )
    assert result.exit_code == 0, result.output
    assert warm_starts == []


def test_serve_does_not_warm_an_andes_it_cannot_find(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    warm_starts: list[_FakeWarm],
) -> None:
    monkeypatch.setattr(cli, "_andes_version", lambda: "unknown")
    assert runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")]).exit_code == 0
    assert warm_starts == []


def test_a_warm_up_that_cannot_start_does_not_stop_the_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    caplog: pytest.LogCaptureFixture,
) -> None:
    def _boom(andes_version: str, log: Any) -> None:
        raise PermissionError("cannot read the cache directory")

    monkeypatch.setattr(cli, "start_background_warm", _boom)
    with caplog.at_level("WARNING", logger="tensa.serve"):
        result = runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    assert fake_server.instances[0].started
    assert "cannot read the cache directory" in caplog.text


def test_serve_reload_warms_the_generated_code_around_the_reloader(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    warm_starts: list[_FakeWarm],
) -> None:
    during_run: list[bool] = []
    monkeypatch.setattr(
        cli.uvicorn, "run", lambda *a, **kw: during_run.extend(w.stopped for w in warm_starts)
    )
    with mock.patch.dict(os.environ):
        result = runner.invoke(
            cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--reload"]
        )
    assert result.exit_code == 0, result.output
    assert during_run == [False]
    assert warm_starts[0].stopped


# ------------------------------------------------------------ sweep workers


def test_serve_passes_the_sweep_worker_bound_to_the_app(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    result = runner.invoke(
        cli.app,
        ["serve", "--workspace", str(tmp_path / "ws"), "--sweep-workers", "3"],
    )
    assert result.exit_code == 0, result.output
    assert built_apps[0]["kwargs"]["sweep_workers"] == 3


def test_serve_leaves_the_sweep_worker_bound_to_the_default_unless_asked(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    result = runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    # ``None`` is "the smaller of 4 and the CPU count", worked out by the manager.
    assert built_apps[0]["kwargs"]["sweep_workers"] is None


@pytest.mark.parametrize("bad", ["0", "-2"])
def test_serve_refuses_fewer_than_one_sweep_worker(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
    bad: str,
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--sweep-workers", bad]
    )
    assert result.exit_code == 2
    assert built_apps == []
    assert fake_server.instances == []


def test_serve_reload_hands_the_sweep_worker_bound_to_the_app_factory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **kw: None)
    with mock.patch.dict(os.environ):
        # A value left over from an earlier ``serve --reload`` in this process must
        # not leak into one that did not ask for it.
        os.environ["ANDES_APP_RELOAD_SWEEP_WORKERS"] = "7"
        args = ["serve", "--workspace", str(tmp_path / "ws"), "--reload"]

        assert runner.invoke(cli.app, [*args, "--sweep-workers", "2"]).exit_code == 0
        assert os.environ["ANDES_APP_RELOAD_SWEEP_WORKERS"] == "2"
        cli._reload_app_factory()
        assert built_apps[-1]["kwargs"]["sweep_workers"] == 2

        assert runner.invoke(cli.app, args).exit_code == 0
        assert "ANDES_APP_RELOAD_SWEEP_WORKERS" not in os.environ
        cli._reload_app_factory()
        assert built_apps[-1]["kwargs"]["sweep_workers"] is None


# ------------------------------------------------------------ open watcher


def _watch(
    is_ready: Callable[[], bool], **kwargs: Any
) -> tuple[threading.Thread, list[str]]:
    opened: list[str] = []
    log = mock.Mock()
    with mock.patch.object(cli.webbrowser, "open", lambda url, new=0: opened.append(url)):
        thread = cli._spawn_open_browser_watcher(
            url="http://127.0.0.1:1234/",
            is_ready=is_ready,
            log=log,
            poll_interval=0.001,
            **kwargs,
        )
        thread.join(5.0)
    assert not thread.is_alive()
    return thread, opened


def test_open_watcher_opens_once_ready() -> None:
    polls = iter([False, False, True])
    _, opened = _watch(lambda: next(polls))
    assert opened == ["http://127.0.0.1:1234/"]


def test_open_watcher_gives_up_at_the_deadline() -> None:
    _, opened = _watch(lambda: False, deadline_seconds=0.05)
    assert opened == []


def test_accepts_connections_probe() -> None:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
        assert cli._accepts_connections("127.0.0.1", port) is False  # not listening
        sock.listen()
        assert cli._accepts_connections("127.0.0.1", port) is True
    finally:
        sock.close()


# ------------------------------------------------------------ logging options


def test_serve_logs_at_info_to_stderr_in_plain_text_by_default(
    tmp_path: Path, fake_server: type[_FakeServer]
) -> None:
    result = runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    port = fake_server.instances[0].bound_port_during_run
    assert f"[INFO] tensa.serve: serving http://127.0.0.1:{port}/" in result.stderr
    assert logging.getLogger().level == logging.INFO
    config = fake_server.instances[0].config
    assert config.log_level == "info"
    # uvicorn leaves logging to the handlers ``serve`` installed, so its lines (an
    # unhandled exception's traceback) get the level, the format and the file.
    assert config.log_config is None


@pytest.mark.parametrize("level", ["debug", "warning", "error", "critical", "WARNING"])
def test_serve_log_level_sets_the_threshold_and_uvicorns(
    tmp_path: Path, fake_server: type[_FakeServer], level: str
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--log-level", level]
    )
    assert result.exit_code == 0, result.output
    assert logging.getLogger().level == getattr(logging, level.upper())
    assert fake_server.instances[0].config.log_level == level.lower()


def test_serve_log_level_above_info_hides_the_startup_line(
    tmp_path: Path, fake_server: type[_FakeServer]
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--log-level", "warning"]
    )
    assert result.exit_code == 0, result.output
    assert "serving http" not in result.stderr


def test_serve_refuses_a_log_level_it_does_not_have(
    tmp_path: Path, fake_server: type[_FakeServer], built_apps: list[dict[str, Any]]
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--log-level", "loud"]
    )
    assert result.exit_code == 2
    assert built_apps == []


def test_serve_log_json_writes_one_json_object_per_line(
    tmp_path: Path, fake_server: type[_FakeServer]
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--log-json"]
    )
    assert result.exit_code == 0, result.output
    entries = [json.loads(line) for line in result.stderr.splitlines()]
    port = fake_server.instances[0].bound_port_during_run
    serving = [e for e in entries if e["logger"] == "tensa.serve" and "serving" in e["message"]]
    assert [e["message"].split(" (")[0] for e in serving] == [f"serving http://127.0.0.1:{port}/"]
    assert serving[0]["level"] == "INFO"


def test_serve_log_file_also_writes_the_log_there(
    tmp_path: Path, fake_server: type[_FakeServer]
) -> None:
    target = tmp_path / "logs" / "serve.log"
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--log-file", str(target)]
    )
    assert result.exit_code == 0, result.output
    text = target.read_text(encoding="utf-8")
    assert "[INFO] tensa.serve: serving http://127.0.0.1:" in text
    # The server says where its log is, on stderr as well.
    assert f"writing the log to {target}" in result.stderr


def test_serve_log_file_with_a_bare_name_writes_in_the_log_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_server: type[_FakeServer]
) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--log-file", "tensa.log"]
    )
    assert result.exit_code == 0, result.output
    assert "serving http" in (home / ".tensa" / "logs" / "tensa.log").read_text(encoding="utf-8")


def test_serve_log_file_and_json_combine(tmp_path: Path, fake_server: type[_FakeServer]) -> None:
    target = tmp_path / "serve.log"
    result = runner.invoke(
        cli.app,
        ["serve", "--workspace", str(tmp_path / "ws"), "--log-json", "--log-file", str(target)],
    )
    assert result.exit_code == 0, result.output
    assert all(json.loads(line)["logger"] for line in target.read_text("utf-8").splitlines())


def test_serve_writes_no_log_file_unless_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_server: type[_FakeServer]
) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    result = runner.invoke(cli.app, ["serve", "--workspace", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    assert not (home / ".tensa" / "logs").exists()


def test_serve_stops_before_binding_when_the_log_file_cannot_be_written(
    tmp_path: Path, fake_server: type[_FakeServer], built_apps: list[dict[str, Any]]
) -> None:
    blocker = tmp_path / "plain-file"
    blocker.write_text("not a directory", encoding="utf-8")
    result = runner.invoke(
        cli.app,
        ["serve", "--workspace", str(tmp_path / "ws"), "--log-file", str(blocker / "serve.log")],
    )
    assert result.exit_code == 2
    assert "--log-file" in result.output
    assert "cannot write the log file" in result.output
    assert built_apps == []
    assert fake_server.instances == []


def test_serve_reload_hands_the_logging_options_to_the_app_factory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
) -> None:
    """The server runs in the reloader's child, which opens the log file itself, so
    two processes never rotate one file."""
    run_kwargs: dict[str, Any] = {}
    monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **kw: run_kwargs.update(kw))
    target = tmp_path / "reload.log"
    with mock.patch.dict(os.environ):
        result = runner.invoke(
            cli.app,
            [
                "serve",
                "--workspace",
                str(tmp_path / "ws"),
                "--reload",
                "--log-level",
                "debug",
                "--log-json",
                "--log-file",
                str(target),
            ],
        )
        assert result.exit_code == 0, result.output
        assert run_kwargs["log_level"] == "debug"
        assert not target.exists(), "the reloader's parent must not hold the file"

        cli._reload_app_factory()  # what the child does
    logging.getLogger("tensa.test").debug("from the child")
    entries = [json.loads(line) for line in target.read_text("utf-8").splitlines()]
    (entry,) = [e for e in entries if e["logger"] == "tensa.test"]
    assert entry["message"] == "from the child"
    assert entry["level"] == "DEBUG"


def test_serve_reload_does_not_inherit_the_logging_options_of_an_earlier_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
) -> None:
    monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **kw: None)
    with mock.patch.dict(os.environ):
        os.environ["ANDES_APP_RELOAD_LOG_FILE"] = str(tmp_path / "stale.log")
        os.environ["ANDES_APP_RELOAD_LOG_JSON"] = "1"
        result = runner.invoke(
            cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--reload"]
        )
        assert result.exit_code == 0, result.output
        assert "ANDES_APP_RELOAD_LOG_FILE" not in os.environ
        assert os.environ["ANDES_APP_RELOAD_LOG_JSON"] == ""
        cli._reload_app_factory()
    assert not (tmp_path / "stale.log").exists()
