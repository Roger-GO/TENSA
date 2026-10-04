"""``POST /tds`` ends a setup failure with one hint to reload, not two, and
answers a refused request value with no hint at all.

``SetupFailedError`` ends every message with the Python API's recovery hint
(``call reload_case() to recover``), which is also all a WebSocket client sees.
The route replaces it with the REST endpoint instead of adding a second hint
after it. ``TdsRequestError`` (a step size or override value the wrapper refuses
before it writes anything) has nothing to recover from, so it carries neither the
hint nor a recovery action.
"""

from __future__ import annotations

import pytest

from tensa.api.routes.tds import _to_http_error
from tensa.core.errors import SetupFailedError, TdsRequestError
from tensa.core.session import WorkerError


def _rest_message(detail: str) -> str:
    """The text a REST caller gets for ``SetupFailedError(detail)``, built the
    way the worker reports it: the error's ``str`` over the Pipe."""
    error = _to_http_error(WorkerError("SetupFailedError", str(SetupFailedError(detail))))
    assert error.status_code == 422
    body = error.detail
    assert isinstance(body, dict)
    message = body["detail"]
    assert isinstance(message, str)
    return message


@pytest.mark.unit
@pytest.mark.parametrize(
    "detail",
    [
        "QNDF cannot replace the trapezoidal integrator of a System that has "
        "already taken time-domain steps, in a run or in a snapshot taken after one",
        "power flow did not converge; TDS cannot begin",
    ],
)
def test_setup_failure_carries_exactly_one_reload_hint(detail: str) -> None:
    message = _rest_message(detail)
    assert message == (
        f"ANDES setup() failed: {detail} — call POST /api/sessions/{{id}}/reload to recover."
    )
    assert "reload_case()" not in message


@pytest.mark.unit
def test_other_categories_are_not_given_a_reload_hint() -> None:
    error = _to_http_error(WorkerError("no-case-loaded", "no case is loaded"))
    assert error.status_code == 409
    assert isinstance(error.detail, dict)
    assert error.detail["detail"] == "no case is loaded"


@pytest.mark.unit
@pytest.mark.parametrize(
    "detail",
    [
        "step size 'h' must be a finite number greater than 0, got 0.0",
        "TDS override 'fixt' must be 0 (variable step) or 1 (fixed step), got 3.0",
        "unknown TDS override key 'bogus'; expected a wrapper-canonical alias",
    ],
)
def test_a_refused_request_value_is_a_plain_422_with_no_reload_to_offer(detail: str) -> None:
    """Nothing was written to the System, so the response is the refusal alone:
    no ``setup()`` prefix, no hint to reload, and no ``recovery`` action for the
    web UI to turn into a Reload button."""
    error = _to_http_error(WorkerError("TdsRequestError", str(TdsRequestError(detail))))
    assert error.status_code == 422
    body = error.detail
    assert isinstance(body, dict)
    assert body["detail"] == detail
    assert body["recovery"] is None
    assert "reload" not in body["detail"].lower()
