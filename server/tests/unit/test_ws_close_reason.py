"""The WebSocket close reason fits in a close frame, and the error frame keeps
the whole message.

RFC 6455 allows a close frame's reason at most 123 bytes. ``_close_with_error``
used to cut the text to 120 characters, which overshoots the limit once the text
has multi-byte characters; the close then failed inside a suppressed block and
the client never received the code.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from starlette.websockets import WebSocketState

from tensa.api.routes import ws as ws_route


@pytest.mark.unit
@pytest.mark.parametrize(
    "reason",
    [
        "short",
        "x" * 500,
        "é" * 500,  # two bytes each
        "€" * 500,  # three bytes each
        "\U0001f600" * 500,  # four bytes each
        "ab" + "€" * 100,  # the cut falls inside a character
    ],
)
def test_fit_close_reason_stays_within_the_byte_limit(reason: str) -> None:
    fitted = ws_route._fit_close_reason(reason)  # noqa: SLF001
    assert len(fitted.encode("utf-8")) <= 123
    assert reason.startswith(fitted)


@pytest.mark.unit
def test_fit_close_reason_keeps_a_short_reason_whole() -> None:
    assert ws_route._fit_close_reason("run not found") == "run not found"  # noqa: SLF001


@pytest.mark.unit
def test_fit_close_reason_does_not_split_a_character() -> None:
    fitted = ws_route._fit_close_reason("ab" + "€" * 100)  # noqa: SLF001
    # 2 + 3 * 39 = 119 bytes fit; the fortieth euro sign would end at 122... or
    # not: whatever fits whole is kept, and nothing is a stray byte.
    assert fitted.encode("utf-8").decode("utf-8") == fitted
    assert set(fitted[2:]) == {"€"}


class _RecordingSocket:
    client_state = WebSocketState.CONNECTED

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed: dict[str, Any] | None = None

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def close(self, code: int, reason: str) -> None:
        # What a real socket does with a reason that is too long.
        if len(reason.encode("utf-8")) > 123:
            raise RuntimeError("close reason too long")
        self.closed = {"code": code, "reason": reason}


@pytest.mark.unit
async def test_close_with_error_sends_the_whole_message_and_a_closable_reason() -> None:
    socket = _RecordingSocket()
    message = "café: " + "é" * 200

    await ws_route._close_with_error(socket, 4500, message)  # type: ignore[arg-type]  # noqa: SLF001

    assert json.loads(socket.sent[0]) == {"type": "error", "code": 4500, "reason": message}
    assert socket.closed is not None
    assert socket.closed["code"] == 4500
    assert message.startswith(socket.closed["reason"])
