"""What ANDES says while a command runs, and how it reaches the user.

ANDES reports through the standard ``andes`` logger: that a power flow stopped
short of its limit, that a device failed to initialise, which limits a limiter
moved, that a fault was applied at ``t = 1 s``. Nothing in the worker ever read
it. The logger has no handler until ``andes.config_logger`` runs, which nothing
here calls, so its level is Python's default (warnings and errors only), and what
it did say went to the server's console, never to the person using the app.

:class:`WorkerLogCapture` is the handler the worker installs on the logger (and
lowers the logger's level to ``INFO`` for, since the information messages say how
a run went). It keeps what the current command logs, and the worker attaches it
to the reply it sends back (:func:`attach_log`): a streamed run's frames carry it
too, so a long run's messages arrive while it goes on. The server side
(:class:`MessageLog`, one per session) numbers the messages as they arrive and
keeps the latest, and ``GET /sessions/{id}/messages`` serves them.

The capture also listens to ``tensa.notice``, where the worker says what ANDES
does not log itself (:mod:`tensa.core.pflow_notices`).

Each message carries the level (``info``, ``warning`` or ``error``), the name of
the logger that said it, the command that was running (``run_pflow``,
``load_case``), the time and the text, which may span lines (ANDES logs tables).
A message that repeats the one before it, as a solver's warning does on every
step, is kept once with a count: the worker merges the repeats of one reply, and
the session's log merges a message into the newest one it holds, so a repeat that
arrives in a later reply or frame adds to the count instead of taking a place.
A message whose count grows is numbered again, so a reader that follows the log
by number reads it once more with the larger count.

ANDES prints the paths it works with (the working directory, the file it parses,
the code cache under the home directory), and the text goes to a client, so the
capture takes the server's own paths out of it (:class:`PathScrubber`), as the
wrapper does for ANDES's exception messages.

Two caps keep a flood from costing memory. The worker holds at most
:data:`PENDING_CAPACITY` messages between two replies, and drops the oldest past
that; the session holds at most :data:`MESSAGE_LOG_CAPACITY`. Both count what
they dropped, and the count is reported with the messages.

Sensitivity sweeps and report generation are not captured: a sweep runs hundreds
of power flows and time-domain runs whose messages would bury the user's own (the
plan the server asks the worker for before it spreads one over sub-workers is part
of the sweep), and a report re-prints a summary ANDES logged when the run ended. A
warning from any of them still goes to the server's console, as it did before.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Final, Literal

# What the worker says to the user itself, for what ANDES does and does not log
# (``core/pflow_notices.py``): a PV bus held at a reactive limit, a load turned into
# an impedance.
NOTICE_LOGGER: Final = "tensa.notice"

# The loggers whose records the worker captures. ANDES's own modules log under
# ``andes.<package>.<module>``, so the one handler on the parent sees them all.
CAPTURED_LOGGERS: Final[tuple[str, ...]] = ("andes", NOTICE_LOGGER)

MessageLevel = Literal["info", "warning", "error"]
LEVELS: Final[tuple[MessageLevel, ...]] = ("info", "warning", "error")
_LEVEL_RANK: Final[dict[str, int]] = {name: rank for rank, name in enumerate(LEVELS)}

# What the worker keeps between two replies, and what a session keeps in all.
PENDING_CAPACITY: Final = 1000
MESSAGE_LOG_CAPACITY: Final = 2000

# A message longer than this is cut. ANDES's longest (a table of adjusted limits
# for every device of a large case) is a few kilobytes.
MAX_MESSAGE_CHARS: Final = 20_000

# Commands whose messages are not captured (see the module docstring). Their
# warnings and errors still reach stderr. ``sweep_plan`` is the check the server asks
# the worker for before it spreads a sweep over sub-workers, so it is part of the sweep.
UNCAPTURED_OPS: Final[frozenset[str]] = frozenset(
    {"run_sweep", "run_sweep_iteration", "adopt_sweep_source", "generate_report", "sweep_plan"}
)


def level_of(levelno: int) -> MessageLevel:
    """The message level a ``logging`` level number stands for."""
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warning"
    return "info"


def level_rank(level: str) -> int:
    """Order of the levels, ``info`` lowest; an unknown level ranks as ``info``."""
    return _LEVEL_RANK.get(level, 0)


# ---- the server's own paths -----------------------------------------------------

PATH_PLACEHOLDER: Final = "<path>"

# What an absolute path in a message is. A quoted one (ANDES quotes the paths it
# prints) runs to the closing quote, since a user name or a folder may hold spaces.
_QUOTED_PATH: Final = re.compile(
    r"""(?P<quote>["'`])(?:[A-Za-z]:[\\/]|\\\\|/)(?:(?!(?P=quote)).)+(?P=quote)"""
)
# A bare Windows path (a drive letter, or a UNC host and share) ends at white space or at
# punctuation that does not belong to a path; one that holds spaces is only caught
# when it is quoted.
_BARE_WINDOWS_PATH: Final = re.compile(
    r"""(?<!\w)(?:[A-Za-z]:[\\/]|\\\\(?=[\w.\-]+\\[\w.$\-]))"""
    r"""[^\s"'`<>|*?]*[^\s"'`<>|*?.,;:!)\]}]"""
)
# A bare POSIX path needs two parts, so "kV/s", "1/2", "and/or" and a URL are left alone.
_BARE_POSIX_PATH: Final = re.compile(r"(?<![\w.\-~/\\>$%])(?:/[\w.\-~@+%=]*[\w\-~@+%=]){2,}")
_ROOT_BEHIND: Final = r"(?<![\w.\-~/\\>$%])"
_ABSOLUTE_START: Final = re.compile(r"(?:[A-Za-z]:[\\/]|[\\/])")


def _spellings(path: str | os.PathLike[str] | None) -> set[str]:
    """The ways a directory can be written in a message: as given, made absolute,
    with its links resolved, each with slashes, with backslashes and with backslashes
    doubled the way ``repr`` writes them. Empty for a path that is not absolute or
    that is only a drive or the file system root, which would match too much."""
    if not path:
        return set()
    given = os.fspath(path)
    forms = {given}
    try:
        forms.add(os.path.abspath(given))
        forms.add(os.path.realpath(given))
    except (OSError, ValueError):
        pass
    spellings: set[str] = set()
    for form in forms:
        form = form.rstrip("\\/")
        if not _ABSOLUTE_START.match(form) or not any(sep in form for sep in "\\/"):
            continue
        spellings |= {form, form.replace("\\", "/"), form.replace("\\", "\\\\")}
    return spellings


def _home_dir() -> str | None:
    try:
        return str(Path.home())
    except (RuntimeError, KeyError, OSError):
        return None


def _working_dir() -> str | None:
    try:
        return os.getcwd()
    except OSError:
        return None


# What a root becomes. The workspace is written relative to itself, so the file ANDES
# parses reads ``ieee14.raw``; the home directory is ``~``, as a shell writes it.
_RELATIVE: Final = ""


class PathScrubber:
    """Takes the server's own paths out of a message, which goes to a client.

    ANDES prints the directory the process works in, the file it parses and the
    folder holding its generated code, so a message would otherwise give away the
    server's layout and the name of the user it runs as. Where roots nest, the
    longest wins (a workspace under the home directory is still the workspace):

    - the workspace becomes a relative form (``<workspace>/ieee14.raw`` reads
      ``ieee14.raw``, the workspace itself ``.``),
    - the home directory becomes ``~``, and the working directory ``<path>``,
    - any other absolute path, POSIX or Windows (``C:\\...``, ``C:/...``, a UNC
      share, a path with its backslashes doubled), becomes ``<path>``.

    A path with spaces is caught when it is quoted, the way ANDES prints one. The
    scan is best effort, like the one the wrapper applies to ANDES's exception
    messages: it leaves the rest of the message as it was.
    """

    def __init__(
        self,
        workspace: str | os.PathLike[str] | None = None,
        *,
        home: str | os.PathLike[str] | None = None,
        cwd: str | os.PathLike[str] | None = None,
        ignore_case: bool | None = None,
    ) -> None:
        """``home`` and ``cwd`` default to the process's own. ``ignore_case`` defaults
        to whether the platform's file names are case-insensitive (Windows)."""
        self._ignore_case = os.name == "nt" if ignore_case is None else ignore_case
        home = _home_dir() if home is None else home
        cwd = _working_dir() if cwd is None else cwd
        self._tokens: dict[str, str] = {}
        variants: set[str] = set()
        # The first to claim a spelling keeps it: a working directory that is the
        # home directory reads ``~``.
        for root, token in ((workspace, _RELATIVE), (home, "~"), (cwd, PATH_PLACEHOLDER)):
            for spelling in _spellings(root):
                variants.add(spelling)
                self._tokens.setdefault(self._key(spelling), token)
        self._roots: re.Pattern[str] | None = None
        if variants:
            alternatives = "|".join(re.escape(v) for v in sorted(variants, key=len, reverse=True))
            self._roots = re.compile(
                rf"{_ROOT_BEHIND}(?P<root>{alternatives})(?:(?P<sep>[\\/]+)|(?![\w\-]|\.\w))",
                re.IGNORECASE if self._ignore_case else 0,
            )

    def _key(self, spelling: str) -> str:
        return spelling.casefold() if self._ignore_case else spelling

    def _hide_root(self, match: re.Match[str]) -> str:
        token = self._tokens[self._key(match.group("root"))]
        separator = match.group("sep")
        if token == _RELATIVE:
            return "" if separator else "."
        return token + (separator or "")

    def __call__(self, text: str) -> str:
        if "/" not in text and "\\" not in text:
            return text
        if self._roots is not None:
            text = self._roots.sub(self._hide_root, text)
        text = _QUOTED_PATH.sub(lambda m: f"{m['quote']}{PATH_PLACEHOLDER}{m['quote']}", text)
        text = _BARE_WINDOWS_PATH.sub(PATH_PLACEHOLDER, text)
        return _BARE_POSIX_PATH.sub(PATH_PLACEHOLDER, text)


class WorkerLogCapture(logging.Handler):
    """Keeps what ANDES logs while the worker runs a command, until a reply
    carries it away (:meth:`attach`).

    A ``logging.Handler`` serialises ``emit`` and takes its own lock around
    :meth:`attach`, so a record logged from a thread other than the one that
    sends the reply (ANDES starts none, but a library might) is neither lost nor
    sent twice.
    """

    def __init__(
        self,
        capacity: int = PENDING_CAPACITY,
        workspace: str | os.PathLike[str] | None = None,
    ) -> None:
        super().__init__(level=logging.INFO)
        self._capacity = capacity
        self._scrub = PathScrubber(workspace)
        self._pending: deque[dict[str, Any]] = deque()
        self._dropped = 0
        self._source = ""
        self._muted = False
        self._saved_levels: dict[str, int] = {}

    # ----- the logging side -------------------------------------------------

    def install(self) -> None:
        """Start capturing: attach to the captured loggers and let ``INFO``
        through, remembering the levels they had."""
        for name in CAPTURED_LOGGERS:
            target = logging.getLogger(name)
            self._saved_levels[name] = target.level
            # A level set by someone who wants more than ``INFO`` stays.
            if target.level == logging.NOTSET or target.level > logging.INFO:
                target.setLevel(logging.INFO)
            target.addHandler(self)

    def uninstall(self) -> None:
        """Stop capturing and put the loggers' levels back."""
        for name, level in self._saved_levels.items():
            target = logging.getLogger(name)
            target.removeHandler(self)
            target.setLevel(level)
        self._saved_levels = {}

    def emit(self, record: logging.LogRecord) -> None:
        """Keep the record, unless the command running is one that is not captured.

        Having a handler on the logger makes Python skip the last-resort handler
        that used to print warnings and errors to stderr (the server's console),
        so it is called here when nothing else handles them, and the console
        loses nothing.
        """
        try:
            if record.levelno >= logging.WARNING and not logging.getLogger().handlers:
                logging.lastResort.handle(record)  # type: ignore[union-attr]
            if self._muted:
                return
            # Before the cut, so a path is never cut in two and left half hidden.
            text = self._scrub(record.getMessage())
        except Exception:  # noqa: BLE001 - a log call must never break the command
            self.handleError(record)
            return
        if len(text) > MAX_MESSAGE_CHARS:
            text = text[:MAX_MESSAGE_CHARS] + "\n[message cut]"
        entry: dict[str, Any] = {
            "time": record.created,
            "level": level_of(record.levelno),
            "logger": record.name,
            "source": self._source,
            "text": text,
            "repeat": 1,
        }
        pending = self._pending
        if pending:
            last = pending[-1]
            if all(last[key] == entry[key] for key in ("level", "logger", "source", "text")):
                last["repeat"] += 1
                return
        pending.append(entry)
        if len(pending) > self._capacity:
            pending.popleft()
            self._dropped += 1

    # ----- the command side -------------------------------------------------

    def begin(self, op: str) -> None:
        """Note which command is about to run: its name goes on the messages it
        logs, and a command in :data:`UNCAPTURED_OPS` logs none."""
        self._source = op
        self._muted = op in UNCAPTURED_OPS

    def attach(self, message: dict[str, Any]) -> dict[str, Any]:
        """Put what is pending on a reply (``log``, and ``log_dropped`` when some
        was lost) and return the reply. A reply with nothing pending is untouched,
        and that case takes no lock: a streamed run calls this for every frame.
        """
        if not self._pending and not self._dropped:
            return message
        with self.lock:  # type: ignore[union-attr]
            entries = list(self._pending)
            self._pending.clear()
            dropped, self._dropped = self._dropped, 0
        if entries:
            message["log"] = entries
        if dropped:
            message["log_dropped"] = dropped
        return message


_capture: WorkerLogCapture | None = None


def install_capture(workspace: str | os.PathLike[str] | None = None) -> WorkerLogCapture:
    """Install the worker's capture (once per process) and return it. ``workspace``
    is the root the messages' paths are written relative to (see :class:`PathScrubber`)."""
    global _capture  # noqa: PLW0603 - one capture per process, like the loggers it sits on
    if _capture is None:
        _capture = WorkerLogCapture(workspace=workspace)
        _capture.install()
    return _capture


def uninstall_capture() -> None:
    """Remove the capture; the next :func:`install_capture` starts a fresh one."""
    global _capture  # noqa: PLW0603
    if _capture is not None:
        _capture.uninstall()
        _capture = None


def begin_command(op: str) -> None:
    """:meth:`WorkerLogCapture.begin` on the installed capture, if there is one."""
    if _capture is not None:
        _capture.begin(op)


def attach_log(message: dict[str, Any]) -> dict[str, Any]:
    """:meth:`WorkerLogCapture.attach` on the installed capture, if there is one."""
    return message if _capture is None else _capture.attach(message)


# ---- the session's side -------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SessionMessage:
    """One message in a session's log, numbered in the order it arrived (or, for
    one whose repeat count has grown, in the order it last did)."""

    seq: int
    time: float
    level: MessageLevel
    logger: str
    source: str
    text: str
    repeat: int


@dataclass(frozen=True, slots=True)
class MessagePage:
    """The messages a read returns, and where the log stands.

    ``first_seq`` is the oldest message the log still holds (the next one to
    arrive, when it is empty): a reader that holds older ones drops them.
    ``last_seq`` is the newest number given out, ``0`` before any. ``next_after``
    is what to ask for next: the last message returned when the read was cut at
    its limit, else ``last_seq``. ``dropped`` counts the messages lost to the two
    caps over the session's life.
    """

    messages: list[SessionMessage]
    first_seq: int
    last_seq: int
    next_after: int
    dropped: int


def _says_the_same(a: SessionMessage, b: SessionMessage) -> bool:
    return (a.level, a.logger, a.source, a.text) == (b.level, b.logger, b.source, b.text)


def _as_message(seq: int, entry: object) -> SessionMessage | None:
    """The message a worker's entry describes, or ``None`` if it is malformed."""
    if not isinstance(entry, Mapping):
        return None
    try:
        level = str(entry["level"])
        return SessionMessage(
            seq=seq,
            time=float(entry["time"]),
            level=level if level in _LEVEL_RANK else "info",  # type: ignore[arg-type]
            logger=str(entry["logger"]),
            source=str(entry.get("source", "")),
            text=str(entry["text"]),
            repeat=max(1, int(entry.get("repeat", 1))),
        )
    except (KeyError, TypeError, ValueError):
        return None


class MessageLog:
    """A session's messages: numbered as they arrive, the latest kept.

    Filled from the worker's replies on whichever thread reads the pipe and read
    from the event loop, so every method takes the lock.
    """

    def __init__(self, capacity: int = MESSAGE_LOG_CAPACITY) -> None:
        self._lock = threading.Lock()
        self._capacity = capacity
        self._items: deque[SessionMessage] = deque()
        self._next_seq = 1
        self._dropped = 0

    def extend(self, entries: Sequence[object], dropped: int = 0) -> None:
        """Add the entries a worker reply carried, and the count it lost.

        An entry that says what the newest message says (same level, logger,
        command and text) is not a new message: its repeats are added to that one,
        whichever reply or streamed frame it came with. The message keeps its place
        and its time and takes the next number, so a reader that follows the log by
        number reads it again with the larger count.
        """
        with self._lock:
            self._dropped += max(0, dropped)
            for entry in entries:
                message = _as_message(self._next_seq, entry)
                if message is None:
                    continue
                newest = self._items[-1] if self._items else None
                if newest is not None and _says_the_same(newest, message):
                    self._items[-1] = replace(
                        newest, seq=message.seq, repeat=newest.repeat + message.repeat
                    )
                    self._next_seq += 1
                    continue
                self._next_seq += 1
                self._items.append(message)
                if len(self._items) > self._capacity:
                    self._items.popleft()
                    self._dropped += 1

    def page(
        self,
        *,
        after: int = 0,
        min_level: MessageLevel = "info",
        limit: int = 500,
    ) -> MessagePage:
        """The messages numbered above ``after`` that are at ``min_level`` or
        higher, at most ``limit`` of them, oldest first."""
        floor = level_rank(min_level)
        with self._lock:
            last_seq = self._next_seq - 1
            first_seq = self._items[0].seq if self._items else self._next_seq
            matching = [
                m for m in self._items if m.seq > after and level_rank(m.level) >= floor
            ]
            dropped = self._dropped
        cut = len(matching) > limit
        returned = matching[:limit]
        return MessagePage(
            messages=returned,
            first_seq=first_seq,
            last_seq=last_seq,
            next_after=returned[-1].seq if cut else last_seq,
            dropped=dropped,
        )

    def clear(self) -> int:
        """Forget every message and return how many there were. Numbering goes
        on, so a reader that holds a number from before still reads what follows."""
        with self._lock:
            removed = len(self._items)
            self._items.clear()
            return removed
