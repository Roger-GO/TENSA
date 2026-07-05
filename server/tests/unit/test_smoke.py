"""Smoke test: package imports cleanly and version is a non-empty string.

This is the only test in Unit 1 — it proves the scaffolding is sound. Real
tests land in Units 2-8 alongside the code they cover.
"""

from __future__ import annotations

import pytest


@pytest.mark.unit
def test_package_imports() -> None:
    import tensa

    assert isinstance(tensa.__version__, str)
    assert tensa.__version__  # non-empty


@pytest.mark.unit
def test_trust_model_docstring_present() -> None:
    """The trust model lives in the package's top-level docstring (canonical statement).

    AGENTS.md references it. If the docstring is gone or empty, future contributors
    have nowhere to land when they touch security-related code.
    """
    import tensa

    assert tensa.__doc__ is not None
    assert "trust model" in tensa.__doc__.lower()
