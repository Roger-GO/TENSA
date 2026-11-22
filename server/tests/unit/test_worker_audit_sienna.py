"""The file-open audit hook: a file under the Sienna project folder is not
warned about in a Sienna worker and is in an ANDES one.

An audit hook cannot be taken out once it is in (PEP 578), so each case runs in
a fresh interpreter: a hook left by another test would warn of the file whatever
the hook under test decides.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_PROBE = """
import logging, sys
from pathlib import Path
from tensa.core import worker
from tensa.engines.sienna import environment

workspace, project, engine = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
environment.sienna_project = lambda: project
logging.basicConfig(level=logging.WARNING, stream=sys.stdout, format="%(message)s")
worker._install_strict_fs_audit_hook(workspace, engine)
for name in ("lock.pid", "pyjuliapkg/meta.json"):
    with open(project / name, encoding="utf-8") as handle:
        handle.read()
print("done")
"""


def _warnings(tmp_path: Path, engine: str) -> list[str]:
    """Install the hook for ``engine`` in a fresh interpreter, open the two
    files Julia's start opens in the Sienna project folder, and return what the
    hook warned of."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    project = tmp_path / "sienna-project"
    (project / "pyjuliapkg").mkdir(parents=True)
    (project / "lock.pid").write_text("1", encoding="utf-8")
    (project / "pyjuliapkg" / "meta.json").write_text("{}", encoding="utf-8")
    done = subprocess.run(
        [sys.executable, "-c", _PROBE, str(workspace), str(project), engine],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    lines = done.stdout.splitlines()
    assert lines and lines[-1] == "done", done.stdout
    return [line for line in lines if "strict-fs" in line]


def test_a_sienna_worker_does_not_warn_of_the_project_folder(tmp_path: Path) -> None:
    assert _warnings(tmp_path, "sienna") == []


def test_an_andes_worker_warns_of_the_project_folder(tmp_path: Path) -> None:
    warned = _warnings(tmp_path, "andes")
    assert len(warned) == 2, warned
    assert all("out-of-workspace open" in line for line in warned)
    assert any(line.endswith("lock.pid") for line in warned)
    assert any(line.endswith("meta.json") for line in warned)
