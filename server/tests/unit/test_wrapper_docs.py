"""Unit tests for ``Wrapper.supported_models`` and ``Wrapper.model_doc``: the
models ANDES ships and its documentation of each, read off a fresh System."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from andes.system import System

from tensa.api.error_mapping import WORKER_ERROR_HTTP_MAP
from tensa.core.errors import ModelDocError, ModelDocUnavailableError
from tensa.core.wrapper import Wrapper, docs


@pytest.fixture(scope="module")
def shared_system() -> System:
    """One fresh System for the tests that read many models, so they need not
    build one per model (each takes most of a second)."""
    return System()


@pytest.fixture
def wrapper(tmp_path: Path) -> Wrapper:
    return Wrapper(workspace=str(tmp_path), session_id="docs", owner_pid=None)


class _Spy:
    """A System that records every attribute read off it."""

    def __init__(self, system: System, reads: list[str]) -> None:
        object.__setattr__(self, "_system", system)
        object.__setattr__(self, "_reads", reads)

    def __getattribute__(self, name: str) -> Any:
        object.__getattribute__(self, "_reads").append(name)
        return getattr(object.__getattribute__(self, "_system"), name)


@pytest.fixture
def spied(
    monkeypatch: pytest.MonkeyPatch, shared_system: System
) -> Iterator[list[str]]:
    reads: list[str] = []
    monkeypatch.setattr(docs, "_fresh_system", lambda: _Spy(shared_system, reads))
    yield reads


@pytest.mark.unit
def test_supported_models_is_every_model_of_a_system_once_by_group(
    wrapper: Wrapper, shared_system: System
) -> None:
    groups = wrapper.supported_models()
    assert groups
    names = [name for models in groups.values() for name in models]
    assert all(isinstance(name, str) for name in names)
    assert all(models for models in groups.values())
    # Every model the System holds, each once: the deprecated alias ACTopology
    # is the ACNode group again and would list Bus twice.
    assert len(names) == len(set(names))
    assert set(names) == set(shared_system.models)
    assert "ACTopology" not in groups
    # The groups are ANDES's own, with their models in ANDES's order.
    for group, models in groups.items():
        assert models == list(shared_system.groups[group].models)
    assert "Bus" in groups["ACNode"]
    assert "GENROU" in groups["SynGen"]


@pytest.mark.unit
def test_supported_models_and_model_doc_leave_the_wrapper_without_a_system(
    wrapper: Wrapper,
) -> None:
    wrapper.supported_models()
    wrapper.model_doc("Bus")
    assert wrapper._ss is None


@pytest.mark.unit
def test_model_doc_of_bus_is_andes_text(wrapper: Wrapper) -> None:
    doc = wrapper.model_doc("Bus")
    assert doc.startswith("Model <Bus> in Group <ACNode>")
    # A parameter and both variables of the model.
    assert " Vn " in doc
    assert "voltage magnitude" in doc
    assert "voltage angle" in doc


@pytest.mark.unit
def test_every_listed_model_has_documentation(
    wrapper: Wrapper, shared_system: System, spied: list[str]
) -> None:
    names = [name for models in wrapper.supported_models().values() for name in models]
    assert len(names) > 90
    for name in names:
        doc = wrapper.model_doc(name)
        assert doc.strip(), name
        assert f"Model <{name}>" in doc
        assert len(doc.encode()) < 64_000, name


@pytest.mark.unit
@pytest.mark.parametrize(
    "name",
    [
        "NoSuchModel",
        "PFlow",
        "TDS",
        "dae",
        "config",
        "groups",
        "models",
        "__class__",
        "__dict__",
        "bus",
        "",
        "ACNode",
    ],
)
def test_a_name_that_is_no_model_is_refused_before_any_lookup(
    wrapper: Wrapper, spied: list[str], name: str
) -> None:
    with pytest.raises(ModelDocError, match="unknown ANDES model"):
        wrapper.model_doc(name)
    # Only the list was read: the name reached no attribute of the System.
    assert set(spied) == {"groups"}


@pytest.mark.unit
def test_a_model_is_looked_up_only_after_the_check(
    wrapper: Wrapper, spied: list[str]
) -> None:
    wrapper.model_doc("GENROU")
    assert spied == ["groups", "models"]


@pytest.mark.unit
def test_documentation_andes_fails_to_write_is_its_own_error(
    wrapper: Wrapper, monkeypatch: pytest.MonkeyPatch, shared_system: System
) -> None:
    def broken(self: Any, *args: Any, **kwargs: Any) -> str:
        raise KeyError("Bus")

    monkeypatch.setattr(type(shared_system.models["TGOV1"]), "doc", broken)
    with pytest.raises(ModelDocUnavailableError, match="TGOV1"):
        wrapper.model_doc("TGOV1")


@pytest.mark.unit
def test_the_two_errors_answer_404_and_422() -> None:
    assert WORKER_ERROR_HTTP_MAP["ModelDocError"] == 404
    assert WORKER_ERROR_HTTP_MAP["ModelDocUnavailableError"] == 422
