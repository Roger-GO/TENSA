"""Unit tests for the GENROU reactance-ordering validator.

Exercises ``_validate_genrou_reactances`` directly with plain dicts (no
ANDES System needed): the function receives the user's params plus the
defaults mapping that ``add_element`` builds from ``ss.GENROU.<p>.default``.
"""

from __future__ import annotations

from typing import Any

import pytest

from tensa.core.errors import ElementValidationError
from tensa.core.wrapper import _validate_genrou_reactances

# ANDES 2.x GENROU defaults (verified against ``System().GENROU.params``).
_ANDES_DEFAULTS: dict[str, float] = {
    "xl": 0.0,
    "xd": 1.9,
    "xq": 1.7,
    "xd1": 0.302,
    "xq1": 0.5,
    "xd2": 0.3,
    "xq2": 0.3,
}


def test_untouched_defaults_accepted() -> None:
    """No reactance params from the user → ANDES defaults satisfy the chains."""
    _validate_genrou_reactances({}, _ANDES_DEFAULTS)


def test_valid_full_set_accepted() -> None:
    """A consistent full WSCC-style set passes both axis chains."""
    params: dict[str, Any] = {
        "xl": 0.0336,
        "xd": 0.146,
        "xq": 0.0969,
        "xd1": 0.0608,
        "xq1": 0.0969,
        "xd2": 0.04,
        "xq2": 0.06,
        "Td10": 8.96,
        "Td20": 0.075,
        "Tq10": 0.31,
        "Tq20": 0.06,
    }
    # xq1 must be strictly > xq2; 0.0969 > 0.06 OK. xq > xq1 needs strict —
    # bump xq so the chain is strictly decreasing.
    params["xq"] = 0.0975
    _validate_genrou_reactances(params, _ANDES_DEFAULTS)


def test_partial_textbook_set_rejected_with_actionable_message() -> None:
    """The motivating bug: textbook transient values without the subtransient
    set collide with ANDES's xd2=0.3 default → reject, naming the silent
    default."""
    params = {"xd": 0.146, "xd1": 0.0608, "xq": 0.0969, "xq1": 0.0969}
    with pytest.raises(ElementValidationError) as ei:
        _validate_genrou_reactances(params, _ANDES_DEFAULTS)
    msg = str(ei.value)
    assert "GENROU reactances must satisfy xd > xd1 > xd2 > xl" in msg
    assert "got xd1=0.0608 <= xd2=0.3" in msg
    assert "xd2 is the ANDES default because you did not set it" in msg
    assert "Set xd2/xq2" in msg
    assert "leave the whole reactance set at defaults" in msg


def test_q_axis_violation_rejected() -> None:
    """The q-axis chain is enforced independently of the d-axis chain."""
    params = {"xq1": 0.2}  # default xq2=0.3 > 0.2 violates xq1 > xq2
    with pytest.raises(ElementValidationError) as ei:
        _validate_genrou_reactances(params, _ANDES_DEFAULTS)
    msg = str(ei.value)
    assert "xq > xq1 > xq2 > xl" in msg
    assert "got xq1=0.2 <= xq2=0.3" in msg


def test_explicit_violation_both_user_set_has_no_default_blame() -> None:
    """When BOTH offending values came from the user, the message doesn't
    blame an ANDES default."""
    params = {"xd1": 0.1, "xd2": 0.2}
    with pytest.raises(ElementValidationError) as ei:
        _validate_genrou_reactances(params, _ANDES_DEFAULTS)
    msg = str(ei.value)
    assert "got xd1=0.1 <= xd2=0.2" in msg
    assert "ANDES default" not in msg


def test_equal_values_rejected() -> None:
    """Ordering is strict: xd2 == xl is a violation."""
    params = {"xd2": 0.05, "xl": 0.05}
    with pytest.raises(ElementValidationError) as ei:
        _validate_genrou_reactances(params, _ANDES_DEFAULTS)
    assert "got xd2=0.05 <= xl=0.05" in str(ei.value)


def test_non_numeric_reactance_rejected() -> None:
    params = {"xd1": "not-a-number"}
    with pytest.raises(ElementValidationError) as ei:
        _validate_genrou_reactances(params, _ANDES_DEFAULTS)
    assert "must be a number" in str(ei.value)
