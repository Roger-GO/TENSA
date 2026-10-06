"""What ANDES said while a command ran: ``GET /sessions/{id}/messages``."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from tensa.core.messages import MAX_MESSAGE_CHARS, MESSAGE_LOG_CAPACITY, PENDING_CAPACITY

MessageLevelSchema = Literal["info", "warning", "error"]


class SessionMessageSchema(BaseModel):
    """One message in a session's log: something ANDES reported while the
    session's worker ran a command."""

    model_config = ConfigDict(extra="forbid")

    seq: int = Field(
        ...,
        description=(
            "Number of the message in the session, from 1, in the order the "
            "server received them. Numbers are never reused, not even after the "
            "log is cleared, so ``after=<seq>`` always reads what came next. A "
            "message that repeats the newest one is not added: its ``repeat`` grows "
            "and it takes the next number, so a reader that follows the log replaces "
            "the message it holds that says the same."
        ),
    )
    time: float = Field(
        ...,
        description="Unix time, in seconds, at which ANDES logged the message.",
    )
    level: MessageLevelSchema = Field(
        ...,
        description=(
            "``info`` for what ANDES reports about a run's progress, ``warning`` "
            "for something that may make a result wrong (a device whose "
            "initialisation failed, a limit that was not adjusted), ``error`` for "
            "what stopped the command."
        ),
    )
    logger: str = Field(
        ...,
        description=(
            "Name of the logger that said it: an ANDES module (``andes.routines.pflow``), or "
            "``tensa.notice`` for what the server worked out itself because ANDES does not "
            "log it (a generator switched from PV to PQ, a load turned into an impedance)."
        ),
    )
    source: str = Field(
        ...,
        description=(
            "The command the worker was running: ``load_case``, ``run_pflow``, "
            "``run_tds``, ``run_eig``, ... Empty for a message logged between commands."
        ),
    )
    text: str = Field(
        ...,
        description=(
            "The message. It can span several lines: ANDES logs tables. A "
            f"message longer than {MAX_MESSAGE_CHARS} characters is cut. Paths of "
            "the server are not in it: the workspace is written relative to itself, "
            "the home directory as ``~`` and any other absolute path as ``<path>``."
        ),
    )
    repeat: int = Field(
        ...,
        ge=1,
        description=(
            "How many times in a row ANDES logged this exact message, which is "
            "kept once (a solver that warns on every step). The count can grow "
            "after the message was read: it is then numbered again."
        ),
    )


class SessionMessages(BaseModel):
    """Response of ``GET /sessions/{id}/messages``."""

    model_config = ConfigDict(extra="forbid")

    messages: list[SessionMessageSchema] = Field(
        ...,
        description="The messages asked for, oldest first.",
    )
    first_seq: int = Field(
        ...,
        description=(
            "The number of the oldest message the session still holds (of the "
            "next one to arrive, when it holds none). A reader that kept older "
            "messages should drop them: they were evicted or cleared."
        ),
    )
    last_seq: int = Field(
        ...,
        description="The number of the newest message the session has had; 0 before any.",
    )
    next_after: int = Field(
        ...,
        description=(
            "What to pass as ``after`` to read on from here: the last message "
            "returned when the read stopped at ``limit``, otherwise ``last_seq``."
        ),
    )
    dropped: int = Field(
        ...,
        description=(
            f"How many messages were lost to the caps (the worker keeps {PENDING_CAPACITY} "
            f"between two replies, the session keeps the latest {MESSAGE_LOG_CAPACITY}), "
            "over the session's life. Clearing the log does not count."
        ),
    )
