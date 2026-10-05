"""What the worker captures of ANDES's log, and the session log it ends up in.

The capture is driven through the real ``andes`` logger, the way ANDES's own
modules call it, and the session log through its public methods. Nothing here
starts a worker: ``tests/integration/test_messages_api.py`` does that.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tensa.core import messages
from tensa.core.messages import (
    MAX_MESSAGE_CHARS,
    MessageLog,
    PathScrubber,
    WorkerLogCapture,
    level_of,
)

pytestmark = pytest.mark.unit

ANDES = logging.getLogger("andes.routines.pflow")


@pytest.fixture
def capture() -> Iterator[WorkerLogCapture]:
    """A capture installed on the ``andes`` logger, taken off again afterwards."""
    cap = WorkerLogCapture()
    cap.install()
    try:
        yield cap
    finally:
        cap.uninstall()


def _entries(cap: WorkerLogCapture) -> list[dict[str, Any]]:
    reply = cap.attach({"type": "result"})
    return list(reply.get("log", []))


# ---- levels -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("levelno", "level"),
    [
        (logging.DEBUG, "info"),
        (logging.INFO, "info"),
        (logging.WARNING, "warning"),
        (logging.ERROR, "error"),
        (logging.CRITICAL, "error"),
    ],
)
def test_a_python_level_maps_to_the_message_level(levelno: int, level: str) -> None:
    assert level_of(levelno) == level


def test_levels_are_ordered_and_an_unknown_one_ranks_lowest() -> None:
    assert messages.level_rank("info") < messages.level_rank("warning")
    assert messages.level_rank("warning") < messages.level_rank("error")
    assert messages.level_rank("fatal") == messages.level_rank("info")


# ---- the capture --------------------------------------------------------------


def test_info_warning_and_error_are_captured_with_who_said_them(
    capture: WorkerLogCapture,
) -> None:
    capture.begin("run_pflow")
    ANDES.info("Converged in %d iterations in %s.", 5, "0.0028 seconds")
    ANDES.warning("a device failed")
    ANDES.error("Power flow failed after 25 iterations")

    entries = _entries(capture)

    assert [(e["level"], e["text"]) for e in entries] == [
        ("info", "Converged in 5 iterations in 0.0028 seconds."),
        ("warning", "a device failed"),
        ("error", "Power flow failed after 25 iterations"),
    ]
    assert {e["logger"] for e in entries} == {"andes.routines.pflow"}
    assert {e["source"] for e in entries} == {"run_pflow"}
    assert all(e["repeat"] == 1 for e in entries)
    assert all(isinstance(e["time"], float) for e in entries)


def test_debug_is_not_captured(capture: WorkerLogCapture) -> None:
    ANDES.debug("per-device chatter")
    assert _entries(capture) == []


def test_a_multi_line_message_is_kept_whole(capture: WorkerLogCapture) -> None:
    table = "PV.qlim: adjusted limit <lower>\n+-----+-------+\n| Idx | Input |\n+-----+-------+"
    ANDES.warning(table)
    assert [e["text"] for e in _entries(capture)] == [table]


def test_a_message_that_repeats_is_kept_once_with_a_count(capture: WorkerLogCapture) -> None:
    for _ in range(3):
        ANDES.warning("Fixed time step is smaller than the estimated minimum.")
    ANDES.warning("something else")
    ANDES.warning("Fixed time step is smaller than the estimated minimum.")

    entries = _entries(capture)

    assert [(e["text"], e["repeat"]) for e in entries] == [
        ("Fixed time step is smaller than the estimated minimum.", 3),
        ("something else", 1),
        ("Fixed time step is smaller than the estimated minimum.", 1),
    ]


def test_the_same_text_from_another_command_or_logger_is_not_merged(
    capture: WorkerLogCapture,
) -> None:
    capture.begin("run_pflow")
    ANDES.warning("same")
    capture.begin("run_tds")
    ANDES.warning("same")
    logging.getLogger("andes.routines.tds").warning("same")

    assert [(e["source"], e["logger"], e["repeat"]) for e in _entries(capture)] == [
        ("run_pflow", "andes.routines.pflow", 1),
        ("run_tds", "andes.routines.pflow", 1),
        ("run_tds", "andes.routines.tds", 1),
    ]


def test_a_flood_keeps_the_latest_and_counts_what_it_dropped() -> None:
    cap = WorkerLogCapture(capacity=3)
    cap.install()
    try:
        for i in range(5):
            ANDES.info("step %d", i)
        reply = cap.attach({"type": "result"})
    finally:
        cap.uninstall()

    assert [e["text"] for e in reply["log"]] == ["step 2", "step 3", "step 4"]
    assert reply["log_dropped"] == 2


def test_a_message_longer_than_the_cap_is_cut(capture: WorkerLogCapture) -> None:
    ANDES.error("x" * (MAX_MESSAGE_CHARS + 500))
    (entry,) = _entries(capture)
    assert entry["text"].startswith("x" * MAX_MESSAGE_CHARS)
    assert len(entry["text"]) < MAX_MESSAGE_CHARS + 50
    assert entry["text"].endswith("[message cut]")


# ---- attaching to a reply -----------------------------------------------------


def test_a_reply_with_nothing_pending_is_returned_untouched(capture: WorkerLogCapture) -> None:
    reply = {"type": "result", "seq": 1, "payload": {"a": 1}}
    assert capture.attach(reply) is reply
    assert reply == {"type": "result", "seq": 1, "payload": {"a": 1}}


def test_what_a_reply_carried_is_not_sent_again(capture: WorkerLogCapture) -> None:
    ANDES.info("once")
    assert len(_entries(capture)) == 1
    assert _entries(capture) == []


def test_messages_logged_between_replies_go_with_the_next_one(capture: WorkerLogCapture) -> None:
    capture.begin("run_tds")
    ANDES.info("frame one")
    first = capture.attach({"type": "stream_frame"})
    ANDES.info("frame two")
    second = capture.attach({"type": "result"})
    assert [e["text"] for e in first["log"]] == ["frame one"]
    assert [e["text"] for e in second["log"]] == ["frame two"]


# ---- commands that are not captured -------------------------------------------


@pytest.mark.parametrize("op", sorted(messages.UNCAPTURED_OPS))
def test_a_sweep_or_a_report_logs_nothing_to_the_reply(
    capture: WorkerLogCapture, op: str
) -> None:
    capture.begin(op)
    ANDES.info("per-iteration chatter")
    ANDES.warning("one of two hundred identical warnings")
    assert _entries(capture) == []
    # ...and the next command is captured again.
    capture.begin("run_pflow")
    ANDES.warning("a real one")
    assert [e["text"] for e in _entries(capture)] == ["a real one"]


def test_the_sweep_plan_is_part_of_the_sweep_and_is_not_captured(
    capture: WorkerLogCapture,
) -> None:
    """The server asks for it before it spreads a sweep over sub-workers, and no
    caller reads its messages: capturing them would send them with a reply that
    is thrown away."""
    assert "sweep_plan" in messages.UNCAPTURED_OPS
    capture.begin("sweep_plan")
    ANDES.warning("the snapshot could not be read")
    assert _entries(capture) == []


class _Recorder(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def _bare_root(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    """A root logger with no handler, as in a worker, and a recorder as the
    last-resort handler Python falls back on (the one that prints to stderr).

    Called inside the test body: pytest adds its own handlers to the root logger
    while the test runs, so a fixture would be undone before the test starts.
    """
    recorder = _Recorder()
    monkeypatch.setattr(logging.getLogger(), "handlers", [])
    monkeypatch.setattr(logging, "lastResort", recorder)
    return recorder


def test_warnings_still_reach_the_console_that_had_them_before(
    capture: WorkerLogCapture, monkeypatch: pytest.MonkeyPatch
) -> None:
    console = _bare_root(monkeypatch)
    ANDES.info("quiet")
    ANDES.warning("loud")
    ANDES.error("louder")
    assert [r.getMessage() for r in console.records] == ["loud", "louder"]


def test_warnings_of_a_sweep_still_reach_the_console(
    capture: WorkerLogCapture, monkeypatch: pytest.MonkeyPatch
) -> None:
    console = _bare_root(monkeypatch)
    capture.begin("run_sweep")
    ANDES.warning("loud in a sweep")
    assert [r.getMessage() for r in console.records] == ["loud in a sweep"]
    assert _entries(capture) == []


def test_nothing_is_printed_twice_when_something_else_handles_the_log(
    capture: WorkerLogCapture, monkeypatch: pytest.MonkeyPatch
) -> None:
    console = _bare_root(monkeypatch)
    logging.getLogger().handlers.append(logging.NullHandler())
    ANDES.warning("handled elsewhere")
    assert console.records == []


# ---- installing and removing --------------------------------------------------


def test_install_lets_info_through_and_uninstall_puts_the_level_back() -> None:
    andes = logging.getLogger("andes")
    before_level, before_handlers = andes.level, list(andes.handlers)
    cap = WorkerLogCapture()
    cap.install()
    try:
        assert andes.level == logging.INFO
        assert cap in andes.handlers
    finally:
        cap.uninstall()
    assert andes.level == before_level
    assert andes.handlers == before_handlers


def test_a_logger_set_to_debug_is_left_at_debug(monkeypatch: pytest.MonkeyPatch) -> None:
    andes = logging.getLogger("andes")
    monkeypatch.setattr(andes, "level", logging.DEBUG)
    cap = WorkerLogCapture()
    cap.install()
    try:
        assert andes.level == logging.DEBUG
    finally:
        cap.uninstall()
    assert andes.level == logging.DEBUG


def test_the_process_wide_capture_installs_once_and_comes_off_cleanly() -> None:
    andes = logging.getLogger("andes")
    before = list(andes.handlers)
    first = messages.install_capture()
    try:
        assert messages.install_capture() is first
        assert andes.handlers.count(first) == 1

        messages.begin_command("load_case")
        ANDES.warning("through the module functions")
        reply = messages.attach_log({"type": "result"})
        assert [(e["source"], e["text"]) for e in reply["log"]] == [
            ("load_case", "through the module functions")
        ]
    finally:
        messages.uninstall_capture()
    assert andes.handlers == before
    # With no capture installed the module functions do nothing.
    messages.begin_command("run_pflow")
    reply = {"type": "result"}
    assert messages.attach_log(reply) is reply


# ---- the server's own paths ---------------------------------------------------


@pytest.fixture
def scrub() -> PathScrubber:
    return PathScrubber(
        "/srv/tensa/ws", home="/home/ana", cwd="/opt/tensa/server", ignore_case=False
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # What ANDES prints when it loads a case.
        ('Working directory: "/opt/tensa/server"', 'Working directory: "<path>"'),
        (
            '> Loaded generated Python code in "/home/ana/.andes/pycode".',
            '> Loaded generated Python code in "~/.andes/pycode".',
        ),
        (
            'Parsing input file "/srv/tensa/ws/ieee14.raw"...',
            'Parsing input file "ieee14.raw"...',
        ),
        (
            'Parsing additional file "/srv/tensa/ws/cases/ieee14.dyr"...',
            'Parsing additional file "cases/ieee14.dyr"...',
        ),
        (
            'Loaded config from "/home/ana/.andes/andes.rc"',
            'Loaded config from "~/.andes/andes.rc"',
        ),
        # The workspace itself, and a directory under the working directory.
        ('Output in "/srv/tensa/ws"', 'Output in "."'),
        ("Wrote /opt/tensa/server/tmp/x.out", "Wrote <path>/tmp/x.out"),
        # A root is a directory: a sibling that only starts with it is another path.
        ('Parsing "/srv/tensa/ws2/x.raw"', 'Parsing "<path>"'),
        ("Wrote /opt/tensa/server-old/x.out.", "Wrote <path>."),
        # Any other absolute path, quoted (spaces and all) or bare.
        ('File "/usr/lib/python3.12/andes/core/model.py", line 3', 'File "<path>", line 3'),
        ("Parsing '/data/my cases/ieee14.raw'", "Parsing '<path>'"),
        ("Saved to /var/lib/andes/out.lst, then stopped", "Saved to <path>, then stopped"),
        # What is not an absolute path stays.
        ("Rate of 0.5 kV/s, a/b/c, 1/2, and/or on 2026/10/05", None),
        ("See https://example.org/andes/docs/models", None),
        ('Parsing "cases/ieee14.raw" and ./out/x.lst and ../y/z', None),
        ("Time step reduced to zero", None),
    ],
)
def test_the_servers_paths_are_taken_out_of_a_message(
    scrub: PathScrubber, text: str, expected: str | None
) -> None:
    assert scrub(text) == (text if expected is None else expected)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (r'Working directory: "C:\src\tensa"', 'Working directory: "<path>"'),
        (
            r'Loaded generated Python code in "C:\Users\Ana Ruiz\.andes\pycode".',
            r'Loaded generated Python code in "~\.andes\pycode".',
        ),
        (
            r'Parsing input file "C:\Users\Ana Ruiz\tensa ws\ieee14.raw"...',
            'Parsing input file "ieee14.raw"...',
        ),
        (
            'Parsing input file "C:/Users/Ana Ruiz/tensa ws/cases/ieee14.raw"...',
            'Parsing input file "cases/ieee14.raw"...',
        ),
        # Written the way ``repr`` writes a Windows path.
        (
            r"Parsing C:\\Users\\Ana Ruiz\\tensa ws\\ieee14.raw",
            "Parsing ieee14.raw",
        ),
        (r'Other drive "D:\data dir\x.raw"', 'Other drive "<path>"'),
        (r"Other drive D:\data\y.dyr, then", "Other drive <path>, then"),
        (r"On a share \\fileserver\share\cases\z.m.", "On a share <path>."),
        (r"A drive letter alone, C:, and a\b stay", None),
    ],
)
def test_windows_paths_are_taken_out_too(text: str, expected: str | None) -> None:
    windows = PathScrubber(
        r"C:\Users\Ana Ruiz\tensa ws",
        home=r"C:\Users\Ana Ruiz",
        cwd=r"C:\src\tensa",
        ignore_case=False,
    )
    assert windows(text) == (text if expected is None else expected)


def test_windows_paths_match_without_regard_to_case_where_asked() -> None:
    folded = PathScrubber(
        r"C:\Users\Ana\tensa", home=r"C:\Users\Ana", cwd=r"C:\src", ignore_case=True
    )
    assert folded(r'in "c:\users\ana\TENSA\ieee14.raw"') == 'in "ieee14.raw"'
    assert folded(r'in "C:\USERS\ANA\.andes"') == 'in "~\\.andes"'
    exact = PathScrubber(r"C:\Users\Ana\tensa", home=r"C:\Users\Ana", ignore_case=False)
    # Without it the spelling is not the workspace's, but the path is still hidden.
    assert exact(r'in "c:\users\ana\tensa\ieee14.raw"') == 'in "<path>"'


def test_the_most_specific_root_wins_and_the_home_directory_beats_the_working_one() -> None:
    nested = PathScrubber("/home/ana/ws", home="/home/ana", cwd="/home/ana", ignore_case=False)
    assert nested("a /home/ana/ws/x.raw b") == "a x.raw b"
    assert nested('in "/home/ana/.andes/pycode"') == 'in "~/.andes/pycode"'
    assert nested('in "/home/ana/work/x"') == 'in "~/work/x"'


def test_a_scrubber_with_no_roots_still_hides_other_absolute_paths() -> None:
    bare = PathScrubber(None, home="", cwd="")
    assert bare('Parsing "/tmp/run7/ieee14.raw"') == 'Parsing "<path>"'
    assert bare("nothing to hide") == "nothing to hide"


def test_a_relative_workspace_and_a_linked_one_are_found_by_their_absolute_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = tmp_path / "real"
    real.mkdir()
    monkeypatch.chdir(tmp_path)
    relative = PathScrubber("real", home="", cwd="")
    assert relative(f'Parsing "{real}/a.raw"') == 'Parsing "a.raw"'
    # The word of a relative path is not a root to hide: it would hide prose.
    assert relative("the real case") == "the real case"
    if os.name != "nt":
        link = tmp_path / "link"
        link.symlink_to(real, target_is_directory=True)
        linked = PathScrubber(link, home="", cwd="")
        assert linked(f'Parsing "{real}/a.raw" and "{link}/b.raw"') == 'Parsing "a.raw" and "b.raw"'


def test_the_workspace_the_home_and_the_working_directory_stay_on_the_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "ws"
    home = tmp_path / "home" / "ana"
    cwd = tmp_path / "where the server was started"
    for directory in (workspace, home, cwd):
        directory.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.chdir(cwd)
    cap = WorkerLogCapture(workspace=workspace)
    cap.install()
    try:
        cap.begin("load_case")
        ANDES.info('Working directory: "%s"', os.getcwd())
        ANDES.info('> Loaded generated Python code in "%s".', home / ".andes" / "pycode")
        ANDES.info('Parsing input file "%s"...', workspace / "ieee14.raw")
        ANDES.warning("Parsing %s failed", tmp_path / "elsewhere" / "ieee14.dyr")
        entries = _entries(cap)
    finally:
        cap.uninstall()

    assert [e["text"] for e in entries] == [
        'Working directory: "<path>"',
        f'> Loaded generated Python code in "~{os.sep}.andes{os.sep}pycode".',
        'Parsing input file "ieee14.raw"...',
        "Parsing <path> failed",
    ]
    for entry in entries:
        for private in (workspace, home, cwd, tmp_path):
            assert str(private) not in entry["text"]


def test_a_path_at_the_cut_is_hidden_before_the_text_is_cut(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "ana"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    cap = WorkerLogCapture()
    cap.install()
    try:
        # With the path left whole this message is one character over the cap, so it is
        # cut inside the path; hidden first it is "~/.andes", and the cut is past it.
        padding = "a" * (MAX_MESSAGE_CHARS - len(str(home / ".andes")) - 1)
        ANDES.info("%s %s", padding, home / ".andes")
        (entry,) = _entries(cap)
    finally:
        cap.uninstall()
    assert str(home) not in entry["text"]
    assert "~" in entry["text"]


# ---- the session's log --------------------------------------------------------


def _entry(text: str, level: str = "info", **extra: Any) -> dict[str, Any]:
    return {
        "time": 1.0,
        "level": level,
        "logger": "andes.test",
        "source": "run_pflow",
        "text": text,
        "repeat": 1,
    } | extra


def test_messages_are_numbered_in_the_order_they_arrive() -> None:
    log = MessageLog()
    log.extend([_entry("a"), _entry("b")])
    log.extend([_entry("c")])
    page = log.page()
    assert [(m.seq, m.text) for m in page.messages] == [(1, "a"), (2, "b"), (3, "c")]
    assert (page.first_seq, page.last_seq, page.next_after, page.dropped) == (1, 3, 3, 0)


def test_a_read_after_a_number_returns_only_what_came_since() -> None:
    log = MessageLog()
    log.extend([_entry("a"), _entry("b")])
    assert [m.text for m in log.page(after=1).messages] == ["b"]
    assert log.page(after=2).messages == []
    log.extend([_entry("c")])
    assert [m.text for m in log.page(after=2).messages] == ["c"]


def test_a_read_can_ask_for_warnings_and_worse() -> None:
    log = MessageLog()
    log.extend([_entry("i"), _entry("w", "warning"), _entry("e", "error")])
    assert [m.text for m in log.page(min_level="warning").messages] == ["w", "e"]
    assert [m.text for m in log.page(min_level="error").messages] == ["e"]
    # The numbering the reader goes on from does not depend on the filter.
    assert log.page(min_level="error").next_after == 3


def test_a_read_cut_at_its_limit_says_where_to_go_on_from() -> None:
    log = MessageLog()
    log.extend([_entry(str(i)) for i in range(5)])
    first = log.page(limit=2)
    assert [m.text for m in first.messages] == ["0", "1"]
    assert first.next_after == 2
    assert first.last_seq == 5
    second = log.page(after=first.next_after, limit=10)
    assert [m.text for m in second.messages] == ["2", "3", "4"]
    assert second.next_after == 5


def test_the_log_keeps_the_latest_and_counts_what_it_evicted() -> None:
    log = MessageLog(capacity=3)
    log.extend([_entry(str(i)) for i in range(5)])
    page = log.page()
    assert [(m.seq, m.text) for m in page.messages] == [(3, "2"), (4, "3"), (5, "4")]
    assert (page.first_seq, page.last_seq, page.dropped) == (3, 5, 2)


def test_what_the_worker_dropped_is_counted_with_what_the_log_evicted() -> None:
    log = MessageLog(capacity=2)
    log.extend([_entry("a"), _entry("b"), _entry("c")], dropped=4)
    assert log.page().dropped == 5
    log.extend([], dropped=1)
    assert log.page().dropped == 6


def test_clearing_forgets_the_messages_and_goes_on_numbering() -> None:
    log = MessageLog()
    log.extend([_entry("a"), _entry("b")])
    assert log.clear() == 2
    cleared = log.page()
    assert cleared.messages == []
    # Nothing held: the oldest is the next to come, so a reader drops all it has.
    assert (cleared.first_seq, cleared.last_seq) == (3, 2)
    log.extend([_entry("c")])
    page = log.page(after=2)
    assert [(m.seq, m.text) for m in page.messages] == [(3, "c")]


def test_clearing_is_not_counted_as_dropping() -> None:
    log = MessageLog()
    log.extend([_entry("a")])
    log.clear()
    assert log.page().dropped == 0


def test_a_malformed_entry_is_skipped_and_takes_no_number() -> None:
    log = MessageLog()
    log.extend(["not a dict", {"text": "no time"}, {"time": "x", "level": "info"}, _entry("ok")])
    page = log.page()
    assert [(m.seq, m.text) for m in page.messages] == [(1, "ok")]


def test_an_unknown_level_reads_as_info_and_a_missing_repeat_as_one() -> None:
    log = MessageLog()
    entry = _entry("odd", level="fatal")
    del entry["repeat"]
    log.extend([entry])
    (m,) = log.page().messages
    assert (m.level, m.repeat) == ("info", 1)


def test_an_empty_log_reports_where_the_next_message_will_be() -> None:
    page = MessageLog().page()
    assert (page.messages, page.first_seq, page.last_seq, page.next_after) == ([], 1, 0, 0)


# ---- a message that repeats across replies ------------------------------------


def test_a_repeat_in_a_later_reply_adds_to_the_newest_message_instead_of_taking_a_place() -> None:
    log = MessageLog()
    log.extend([_entry("start"), _entry("Time step reduced", level="warning", repeat=2, time=5.0)])
    log.extend([_entry("Time step reduced", level="warning", repeat=3, time=9.0)])

    page = log.page()

    assert [(m.text, m.repeat) for m in page.messages] == [("start", 1), ("Time step reduced", 5)]
    # The message keeps the time it was first said at.
    assert page.messages[1].time == 5.0


def test_a_message_that_grew_is_numbered_again_so_a_reader_that_follows_by_number_sees_it() -> None:
    log = MessageLog()
    log.extend([_entry("start"), _entry("Time step reduced", repeat=2)])
    first_read = log.page()
    assert [(m.seq, m.repeat) for m in first_read.messages] == [(1, 1), (2, 2)]

    log.extend([_entry("Time step reduced", repeat=3)])

    page = log.page(after=first_read.next_after)
    assert [(m.seq, m.repeat) for m in page.messages] == [(3, 5)]
    assert (page.first_seq, page.last_seq, page.next_after) == (1, 3, 3)
    # Read from the start, it is there once.
    assert [m.text for m in log.page().messages] == ["start", "Time step reduced"]


def test_a_log_of_one_message_that_grows_moves_its_first_number_with_it() -> None:
    log = MessageLog()
    log.extend([_entry("Time step reduced")])
    log.extend([_entry("Time step reduced")])
    page = log.page()
    assert [(m.seq, m.repeat) for m in page.messages] == [(2, 2)]
    assert page.first_seq == 2


def test_only_the_newest_message_takes_a_repeat() -> None:
    log = MessageLog()
    log.extend([_entry("a")])
    log.extend([_entry("b")])
    log.extend([_entry("a")])
    assert [(m.text, m.repeat) for m in log.page().messages] == [("a", 1), ("b", 1), ("a", 1)]


def test_the_same_text_from_another_level_logger_or_command_is_a_message_of_its_own() -> None:
    log = MessageLog()
    log.extend([_entry("same")])
    log.extend([_entry("same", level="warning")])
    log.extend([_entry("same", level="warning", logger="andes.routines.tds")])
    log.extend([_entry("same", level="warning", logger="andes.routines.tds", source="run_tds")])
    assert [m.repeat for m in log.page().messages] == [1, 1, 1, 1]


def test_a_warning_on_every_step_of_a_long_run_stays_one_message_and_evicts_nothing() -> None:
    log = MessageLog(capacity=3)
    log.extend([_entry("loaded"), _entry("solved")])
    for _ in range(500):
        log.extend([_entry("Time step reduced", level="warning", repeat=4)])

    page = log.page()

    assert [(m.text, m.repeat) for m in page.messages] == [
        ("loaded", 1),
        ("solved", 1),
        ("Time step reduced", 2000),
    ]
    assert page.dropped == 0


def test_two_entries_of_one_reply_that_say_the_same_are_merged_too() -> None:
    log = MessageLog()
    log.extend([_entry("x", repeat=2), _entry("x", repeat=2)])
    assert [(m.text, m.repeat) for m in log.page().messages] == [("x", 4)]


def test_a_repeat_after_a_clear_starts_a_message() -> None:
    log = MessageLog()
    log.extend([_entry("x")])
    log.clear()
    log.extend([_entry("x")])
    assert [(m.seq, m.repeat) for m in log.page().messages] == [(2, 1)]
