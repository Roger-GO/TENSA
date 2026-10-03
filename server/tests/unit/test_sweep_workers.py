"""How many workers a sweep gets: the helpers behind ``--sweep-workers``.

A sweep is spread over at most the configured number of sub-workers, and over
fewer when it is short, because a sub-worker costs a process start and an ANDES
import before its first iteration. A setting of 1, or a sweep too short to share,
keeps the iterations on the session's own worker.
"""

from __future__ import annotations

import os

import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.sweep import (
    DEFAULT_SWEEP_WORKERS_CAP,
    MIN_ITERATIONS_PER_SWEEP_WORKER,
    default_sweep_workers,
    sweep_worker_count,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("setting", "iterations", "expected"),
    [
        # Too short to share: fewer than two workers' worth of iterations.
        (4, 2, 0),
        (4, 3, 0),
        # A setting of one is the sequential sweep.
        (1, 8, 0),
        (1, 200, 0),
        # Each worker gets at least two iterations, up to the setting.
        (4, 4, 2),
        (4, 5, 2),
        (4, 6, 3),
        (4, 7, 3),
        (4, 8, 4),
        (4, 200, 4),
        (2, 200, 2),
        (16, 200, 16),
        (16, 20, 10),
    ],
)
def test_the_worker_count_is_bounded_by_the_setting_and_by_the_sweep_length(
    setting: int, iterations: int, expected: int
) -> None:
    assert sweep_worker_count(setting, iterations) == expected


def test_a_worker_is_never_given_fewer_iterations_than_the_minimum() -> None:
    for setting in range(1, 9):
        for iterations in range(2, 60):
            workers = sweep_worker_count(setting, iterations)
            assert workers <= setting
            assert workers == 0 or workers >= 2
            if workers:
                assert iterations // workers >= MIN_ITERATIONS_PER_SWEEP_WORKER


@pytest.mark.skipif(not hasattr(os, "sched_getaffinity"), reason="no CPU affinity on this OS")
@pytest.mark.parametrize(
    ("cpus", "expected"),
    [(1, 1), (2, 2), (4, 4), (6, DEFAULT_SWEEP_WORKERS_CAP), (256, DEFAULT_SWEEP_WORKERS_CAP)],
)
def test_the_default_is_the_smaller_of_four_and_the_usable_cpus(
    monkeypatch: pytest.MonkeyPatch, cpus: int, expected: int
) -> None:
    monkeypatch.setattr(os, "sched_getaffinity", lambda _pid: set(range(cpus)))
    assert default_sweep_workers() == expected


def test_the_default_counts_all_cpus_where_there_is_no_affinity_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(os, "sched_getaffinity", raising=False)
    monkeypatch.setattr(os, "cpu_count", lambda: 3)
    assert default_sweep_workers() == 3
    monkeypatch.setattr(os, "cpu_count", lambda: None)
    assert default_sweep_workers() == 1


def test_the_app_gives_its_session_manager_the_setting(tmp_path: object) -> None:
    from pathlib import Path

    workspace = Path(str(tmp_path)) / "ws"
    workspace.mkdir(mode=0o700)

    with TestClient(make_app(workspace=workspace, sweep_workers=3)) as client:
        assert client.app.state.session_manager._sweep_workers == 3  # type: ignore[attr-defined]  # noqa: SLF001
    with TestClient(make_app(workspace=workspace)) as client:
        manager = client.app.state.session_manager  # type: ignore[attr-defined]
        assert manager._sweep_workers == default_sweep_workers()  # noqa: SLF001
