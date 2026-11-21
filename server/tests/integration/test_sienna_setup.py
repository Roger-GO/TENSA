"""The real Sienna setup against the real Julia (unit P4-D).

Slow: the install step instantiates and precompiles the whole Manifest. With
the packages already in Julia's depot it needs no network and takes under a
minute; with an empty depot it downloads about 0.8 GB and takes much longer.
The project folder's name has a space in it, which every path given to Julia
must survive.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from tensa.engines.sienna import environment, setup

pytestmark = [pytest.mark.integration, pytest.mark.sienna]

julia = pytest.mark.skipif(
    environment.julia_executable() is None or importlib.util.find_spec("juliacall") is None,
    reason="no Julia, or no juliacall",
)


@julia
def test_setup_sienna_with_the_real_julia(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = environment.julia_executable()
    assert executable is not None
    project = tmp_path / "a project" / "dyn"
    echoed: list[str] = []
    returned = setup.setup_sienna(julia=executable, project=project, echo=echoed.append)
    assert returned == project
    manifest = setup.packaged_project() / "Manifest.toml"
    assert (project / setup.STAMP).read_text(encoding="utf-8").strip() == setup.stamp_text(
        manifest
    )
    assert setup.is_ready(project, manifest)
    assert any(line.strip().startswith("PowerSystems ") for line in echoed), echoed

    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    monkeypatch.setenv("TENSA_JULIA", str(executable))
    monkeypatch.delenv("TENSA_SIENNA_SKIP_STAMP", raising=False)
    assert environment.sienna_unavailable_reason() is None
