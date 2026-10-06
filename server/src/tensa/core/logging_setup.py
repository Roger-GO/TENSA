"""How ``tensa serve`` logs: the level, plain text or JSON lines, and a log file.

The server writes to stderr, in plain text, at ``INFO``. ``configure_logging``
changes that on the root logger, which is where every ``tensa`` logger and, since
``serve`` hands uvicorn no logging configuration of its own, uvicorn's too
(``Exception in ASGI application`` and its traceback among them) end up:

- ``level`` is the threshold for all of them.
- ``json_lines`` writes each record as one JSON object per line (``time``,
  ``level``, ``logger``, ``message``, and ``exception`` when there is a
  traceback), for a log collector to read.
- ``log_file`` also writes the records, in the same format, to a file that
  rotates at ``MAX_LOG_BYTES`` and keeps ``LOG_BACKUPS`` older ones. A bare file
  name goes in ``~/.tensa/logs`` (see ``resolve_log_file``), where a run with
  nowhere to print to, a desktop window, can find it.

Only the server process is configured. A worker has its own interpreter and
reports through the reply to each command (``core/messages.py``), apart from a
rare warning that reaches stderr through Python's last-resort handler and a
crash traceback from ``faulthandler`` (see ``worker_main``). Neither goes into
the file.

The handlers this module installs are marked, so calling ``configure_logging``
again replaces them instead of adding a second set, and ``reset_logging`` takes
them off (tests do, so one run's handlers do not outlive it).
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO

TEXT_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"

# A log file rotates at this size and keeps this many older files, so a server left
# running for months holds at most 4 x 5 MiB.
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 3

# Set on every handler this module installs.
_MARK = "_tensa_logging_handler"


def log_dir() -> Path:
    """Where a bare ``--log-file`` name goes: ``~/.tensa/logs``."""
    return Path.home() / ".tensa" / "logs"


def resolve_log_file(value: str) -> Path:
    """The file ``--log-file value`` writes.

    A name with no directory part (``tensa.log``) goes in ``log_dir()``, so a log
    can be asked for without saying where the user's own logs live. Anything with
    one (``./tensa.log``, ``/var/log/tensa.log``, ``~/logs/tensa.log``) is used where
    it points, relative to the current directory when it is not absolute.
    """
    separators = (os.sep, os.altsep) if os.altsep else (os.sep,)
    if not any(sep in value for sep in separators) and not value.startswith("~"):
        return log_dir() / value
    return Path(value).expanduser().absolute()


class JsonFormatter(logging.Formatter):
    """One JSON object per record, on one line.

    ``time`` is UTC with milliseconds. Non-ASCII text is escaped, so the line
    survives a console whose encoding is not UTF-8.
    """

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, str] = {
            "time": datetime.fromtimestamp(record.created, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        elif record.exc_text:
            entry["exception"] = record.exc_text
        if record.stack_info:
            entry["stack"] = self.formatStack(record.stack_info)
        return json.dumps(entry)


class _StderrHandler(logging.StreamHandler[TextIO]):
    """A stream handler on whatever ``sys.stderr`` is at the moment of each record,
    so a stream that is swapped later (a test's capture) is never written to after
    it is closed."""

    def __init__(self) -> None:
        super().__init__(sys.stderr)

    @property
    def stream(self) -> TextIO:
        return sys.stderr

    @stream.setter
    def stream(self, _value: TextIO) -> None:
        """``StreamHandler`` assigns one in ``__init__`` and ``setStream``."""


def _file_handler(path: Path) -> logging.Handler:
    """Open ``path`` for rotating appends, creating its directory (mode 0700).

    Raises:
        OSError: the directory or file cannot be created or written.
    """
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return logging.handlers.RotatingFileHandler(
        path, maxBytes=MAX_LOG_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8"
    )


def reset_logging() -> None:
    """Remove and close the handlers ``configure_logging`` installed."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, _MARK, False):
            root.removeHandler(handler)
            handler.close()


def configure_logging(
    *,
    level: str | int = "INFO",
    json_lines: bool = False,
    log_file: Path | None = None,
) -> None:
    """Send the root logger's records to stderr, and to ``log_file`` when given.

    Replaces what an earlier call installed. Nothing is changed when the file
    cannot be opened.

    Raises:
        OSError: ``log_file`` cannot be created or written.
    """
    formatter: logging.Formatter = JsonFormatter() if json_lines else logging.Formatter(TEXT_FORMAT)
    handlers: list[logging.Handler] = [_StderrHandler()]
    if log_file is not None:
        handlers.append(_file_handler(log_file))
    reset_logging()
    root = logging.getLogger()
    root.setLevel(level)
    for handler in handlers:
        handler.setFormatter(formatter)
        setattr(handler, _MARK, True)
        root.addHandler(handler)
