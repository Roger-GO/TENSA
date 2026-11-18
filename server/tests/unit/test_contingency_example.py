"""The contingency screening study in ``examples/`` can be found, set up and run from a fresh install.

The study talks to a server over HTTP with ``httpx``, so these tests give it one made of
``httpx.MockTransport``: a four-bus network whose answers are fixed, enough to run the whole
chain (task, oracle, scripted agents, scoring) in a moment. They check what the study was
missing: the server's address comes from ``TENSA_URL``, the versions it ran against are
written beside what it computed, and the README's steps are steps that work. The tests read
the repository files directly, so they skip when run away from a checkout.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import re
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from tests._repo import REPO_ROOT, SERVER_DIR

pytestmark = pytest.mark.unit

_STUDY = REPO_ROOT / "examples" / "contingency_screening"
_MODULES = ("common", "build_task", "oracle", "baselines", "score")
_VERSIONS = {"tensa": "9.8.7", "andes": "6.5.4"}

# A ring of four buses with one chord: five branches, so ten pairs, of which the connected
# ones are the candidates.
_BRANCHES = {
    "Line_1": ("1", "2"),
    "Line_2": ("2", "3"),
    "Line_3": ("3", "4"),
    "Line_4": ("4", "1"),
    "Line_5": ("1", "3"),
}


def _server(seen: list[httpx.Request]) -> Callable[[httpx.Request], httpx.Response]:
    """What the routes the study uses answer, for the network above."""

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if path == "/api/version":
            return httpx.Response(200, json=_VERSIONS)
        if path == "/api/sessions" and request.method == "POST":
            return httpx.Response(201, json={"session_id": "s1"})
        if path.endswith("/topology"):
            lines = [
                {"idx": idx, "params": {"bus1": a, "bus2": b}} for idx, (a, b) in _BRANCHES.items()
            ]
            return httpx.Response(200, json={"lines": lines, "transformers": []})
        if path.endswith("/pflow"):
            flows = {idx: {"p": 40.0, "q": 30.0} for idx in _BRANCHES}
            return httpx.Response(200, json={"converged": True, "line_flows": flows})
        return httpx.Response(200, json={})

    return answer


_Study = Callable[[str | None], tuple[SimpleNamespace, list[httpx.Request]]]


@pytest.fixture
def study(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[_Study]:
    """The study's modules, imported as its scripts do (by name, from its folder), with their
    results folder in ``tmp_path`` and every HTTP client talking to the stand-in server."""
    if not _STUDY.is_dir():
        pytest.skip("examples/contingency_screening is not next to the tests")

    def load(url: str | None) -> tuple[SimpleNamespace, list[httpx.Request]]:
        if url is None:
            monkeypatch.delenv("TENSA_URL", raising=False)
        else:
            monkeypatch.setenv("TENSA_URL", url)
        monkeypatch.syspath_prepend(str(_STUDY))
        for name in _MODULES:
            sys.modules.pop(name, None)
        modules = SimpleNamespace(**{name: importlib.import_module(name) for name in _MODULES})
        seen: list[httpx.Request] = []
        real_client = httpx.Client

        def client(**kwargs: Any) -> httpx.Client:
            return real_client(transport=httpx.MockTransport(_server(seen)), **kwargs)

        stand_in = SimpleNamespace(Client=client, HTTPStatusError=httpx.HTTPStatusError)
        monkeypatch.setattr(modules.common, "httpx", stand_in)
        # ``score`` took the folder by name when it was imported; the others read it from ``common``.
        monkeypatch.setattr(modules.common, "RESULTS", tmp_path)
        monkeypatch.setattr(modules.score, "RESULTS", tmp_path)
        return modules, seen

    yield load
    for name in _MODULES:
        sys.modules.pop(name, None)


def test_the_server_is_where_tensa_url_says_and_by_default_where_it_was(study: _Study) -> None:
    default, _ = study(None)
    assert default.common.BASE_URL == "http://127.0.0.1:18800/api"
    for given in (
        "",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:8000/",
        "http://127.0.0.1:8000/api",
    ):
        modules, _ = study(given)
        want = "http://127.0.0.1:8000/api" if given else "http://127.0.0.1:18800/api"
        assert want == modules.common.BASE_URL, given


def test_the_scripts_drive_the_server_named_by_tensa_url_and_record_what_it_runs(
    study: _Study, tmp_path: Path
) -> None:
    """The oracle stood at 18800 and wrote nothing of the versions it ran against, so a result
    could not be told from one made with another TENSA or ANDES."""
    modules, seen = study("http://study.test:9")

    modules.build_task.main()
    modules.oracle.main()
    modules.baselines.main()
    modules.score.main()

    assert {r.url.host for r in seen} == {"study.test"}
    assert all(r.url.path.startswith("/api/") for r in seen)
    for name in (
        "task.json",
        "oracle.json",
        "submission_random.json",
        "submission_greedy_stress.json",
    ):
        assert json.loads((tmp_path / name).read_text())["versions"] == _VERSIONS, name
    # The scores are one entry per agent, and scoring reads past the versions.
    scores = json.loads((tmp_path / "scores.json").read_text())
    assert set(scores) == {"random", "greedy_stress"}
    # Eight of the ten pairs of the five branches leave the four buses connected.
    task = json.loads((tmp_path / "task.json").read_text())
    assert len(task["candidates"]) == 8


def test_the_readme_cites_the_benchmark_by_its_first_author() -> None:
    """It said Zhang et al., one of the later authors of PowerAgentBench-SS, whose first author is
    Mylonas."""
    texts = [(_STUDY / "README.md").read_text(), (_STUDY / "score.py").read_text()]
    for text in texts:
        assert "Zhang et al" not in text
    assert "Mylonas et al., arXiv:2606.18789" in texts[0]


def test_the_study_is_linked_from_the_readme_and_the_examples_readme() -> None:
    for page in ("README.md", "examples/README.md"):
        text = (REPO_ROOT / page).read_text(encoding="utf-8")
        assert "contingency_screening/" in text, page
        assert "httpx" in text, page


def _readme_block(language: str, containing: str) -> str:
    text = (_STUDY / "README.md").read_text(encoding="utf-8")
    (block,) = [
        b for b in re.findall(rf"```{language}\n(.*?)```", text, flags=re.DOTALL) if containing in b
    ]
    return block


def test_the_readme_says_what_the_study_needs_beyond_tensa() -> None:
    install = _readme_block("bash", "pip install")
    assert "httpx" in install
    # ``httpx`` is a test dependency of TENSA, not a runtime one, which is why it is named.
    runtime = (
        (SERVER_DIR / "pyproject.toml").read_text(encoding="utf-8").split("[project.optional")[0]
    )
    assert "httpx" not in runtime
    text = (_STUDY / "README.md").read_text(encoding="utf-8")
    assert "TENSA_URL" in text
    assert "results/" in text and "over the files" in text


def test_the_readmes_command_copies_the_case_out_of_the_installed_andes(tmp_path: Path) -> None:
    """The command is run as written, in a folder that has the ``study-workspace`` it copies into."""
    pytest.importorskip("andes")
    import andes

    block = _readme_block("bash", "import andes")
    (command,) = re.findall(r'^python -c "(.*)"$', block, flags=re.MULTILINE)
    (tmp_path / "study-workspace").mkdir()
    done = subprocess.run(
        [sys.executable, "-c", command], cwd=tmp_path, capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr
    copied = tmp_path / "study-workspace" / "ieee39.xlsx"
    assert copied.is_file()
    # The README names the file of ANDES 2.0.0 by its hash; another release may differ.
    if andes.__version__ == "2.0.0":
        named = re.search(r"SHA-256 `([0-9a-f]{64})`", (_STUDY / "README.md").read_text())
        assert named is not None
        assert hashlib.sha256(copied.read_bytes()).hexdigest() == named.group(1)
