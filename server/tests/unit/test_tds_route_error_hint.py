"""``POST /tds`` ends a setup failure with one hint to reload, not two.

``SetupFailedError`` ends every message with the Python API's recovery hint
(``call reload_case() to recover``), which is also all a WebSocket client sees.
The route replaces it with the REST endpoint instead of adding a second hint
after it.
"""

from __future__ import annotations

import pytest

from tensa.api.routes.tds import _to_http_error
from tensa.core.errors import SetupFailedError
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
