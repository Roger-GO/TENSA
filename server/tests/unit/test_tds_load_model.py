"""``load_model`` on a time-domain request (spec section 6.3): the request
takes the three values, and the ANDES engine refuses what it does not do
before anything runs."""

from __future__ import annotations

import threading

import pytest
from pydantic import ValidationError

from tensa.api.schemas.tds import TdsRunRequest
from tensa.core import worker
from tensa.core.errors import TdsRequestError

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("value", ["impedance", "power", "as-case", None])
def test_the_request_takes_the_three_load_models(value: str | None) -> None:
    assert TdsRunRequest(tf=1.0, load_model=value).load_model == value


def test_the_request_refuses_another_load_model() -> None:
    with pytest.raises(ValidationError, match="load_model"):
        TdsRunRequest(tf=1.0, load_model="zip")  # type: ignore[arg-type]


@pytest.mark.parametrize("value", ["power", "as-case"])
@pytest.mark.parametrize("stream", [False, True])
def test_the_andes_engine_refuses_a_load_model_it_does_not_do(value: str, stream: bool) -> None:
    """Refused first, so neither the System nor the data pipe is touched (both
    are ``None`` here)."""
    with pytest.raises(TdsRequestError, match=f"load_model {value} is not available"):
        worker._handle_run_tds(  # noqa: SLF001
            None,  # type: ignore[arg-type]
            {"tf": 1.0, "load_model": value, "stream": stream},
            threading.Event(),
        )
