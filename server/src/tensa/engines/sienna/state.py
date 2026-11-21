"""The per-session state of the Sienna engine.

One ``SiennaState`` per session, the Sienna counterpart of the ANDES
``Wrapper`` for the six ops the engine answers. It holds the
:class:`~tensa.engines.sienna.bridge.JuliaBridge` (made on first use when none
is given), the Julia session the bridge returned, the case path and addfiles,
the :class:`~tensa.engines.identity.CaseIdentity`, the
:class:`~tensa.engines.keys.KeyBook`, the last topology, report and power flow
JSON, and the settings of the last power flow.

Every path that reaches the bridge (the case, the ``.dyr``, the scratch
folder) is checked against the workspace in Python first, by the validation
the case route uses, because Julia's own file reads go through the C library
and are invisible to the worker's audit hook.

Everything the engine says about a load or a power flow is logged on the
``tensa.notice`` logger, which the worker's log capture sends to the session's
message log (``tensa.core.messages``).
"""

from __future__ import annotations

import logging
import math
import os
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tensa.core.errors import (
    CaseLoadError,
    NoCaseLoadedError,
    PflowRequestError,
    short_repr,
)
from tensa.core.messages import PathScrubber
from tensa.core.pflow_options import PflowSettings
from tensa.core.session_dirs import SESSIONS_DIRNAME, write_owner_marker
from tensa.core.wrapper.results import PflowResult, TopologySnapshot
from tensa.engines.case_facts import corrections_document, read_case_facts
from tensa.engines.identity import _matpower_rows, read_identity
from tensa.engines.keys import KeyBook
from tensa.engines.sienna.bridge import JuliaBridge
from tensa.engines.sienna.convert import (
    file_ratings,
    pflow_result,
    report_messages,
    topology_snapshot,
)
from tensa.engines.sienna.keys import assign_sienna_keys
from tensa.security.paths import (
    WorkspacePathError,
    canonical_directory,
    open_workspace_file_for_andes,
)

if TYPE_CHECKING:
    from tensa.engines.identity import CaseIdentity

log = logging.getLogger("tensa.notice")

# The ops the Sienna engine does not take, named for the error message.
_ANDES_ONLY_PFLOW_OPTIONS = ("method", "n_factorize", "linesearch")


def _case_stamp(case_path: Path) -> tuple[Path, int, int]:
    """What tells one content of a case file from another: its path, its
    modification time in nanoseconds and its size. A file that cannot be read
    for them stamps as -1, -1 (the load is about to fail anyway)."""
    try:
        stat = case_path.stat()
    except OSError:
        return (case_path, -1, -1)
    return (case_path, stat.st_mtime_ns, stat.st_size)


def _read_text(path: Path) -> str:
    """The text of a case file, as UTF-8 or else Latin-1, as the identity and
    facts readers read it."""
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1")


def matpower_branch_rows(text: str) -> dict[tuple[int, int, str], int]:
    """The row number (from 1) of each ``mpc.branch`` row of a MATPOWER case,
    keyed by ``(from, to, ckt)``.

    ``ckt`` is the ordinal among the rows of the same unordered bus pair, as
    ``identity.py`` and ``case_facts.py`` assign it. The row number is the
    position in the file's branch matrix, not in the identity's ``branches``
    or the facts' lists, which put the lines first and the transformers after.
    """
    numbers: dict[tuple[int, int, str], int] = {}
    pair_ordinals: dict[tuple[int, int], int] = {}
    for number, row in enumerate(_matpower_rows(text, "branch"), start=1):
        from_bus, to_bus = int(row[0]), int(row[1])
        pair = (min(from_bus, to_bus), max(from_bus, to_bus))
        pair_ordinals[pair] = pair_ordinals.get(pair, 0) + 1
        numbers[(from_bus, to_bus, str(pair_ordinals[pair]))] = number
    return numbers


def julia_corrections(path: Path, document: Mapping[str, Any]) -> dict[str, Any]:
    """What the bridge's ``corrections`` argument takes for the case at ``path``:
    the ``transformers`` and ``line_charging`` rows of its corrections document,
    the only keys the Julia module knows.

    The Julia module names a branch of a PSS/E file by the record's circuit id
    and a branch of a MATPOWER file by its row number in the file, so for a
    ``.m`` file each row's third field becomes that row number, as text (``"1"``
    for the first branch row). A row whose branch the file does not have (the
    readers disagree, which is a bug) is sent as it is, and the Julia module's
    note that the System does not hold it says so.
    """
    transformers = [list(row) for row in document.get("transformers", [])]
    line_charging = [list(row) for row in document.get("line_charging", [])]
    if path.suffix.lower() == ".m":
        numbers = matpower_branch_rows(_read_text(path))
        for rows in (transformers, line_charging):
            for row in rows:
                number = numbers.get((int(row[0]), int(row[1]), str(row[2])))
                if number is not None:
                    row[2] = str(number)
    return {"transformers": transformers, "line_charging": line_charging}


def _validated(workspace: Path, path: Path) -> Path:
    """``path`` checked against the workspace by the validation the case route
    uses (``open_workspace_file_for_andes``), answered in its canonical form.

    The route has checked it already; this is the check again in the process
    that hands it to Julia, whose own file reads the audit hook does not see.
    A path outside the workspace, missing, or otherwise refused raises
    :class:`CaseLoadError` naming the file only.
    """
    try:
        root = canonical_directory(workspace)
        try:
            relative = Path(os.path.abspath(path)).relative_to(root)
        except ValueError:
            relative = Path(os.path.realpath(path)).relative_to(root)
        with open_workspace_file_for_andes(root, str(relative)) as canonical:
            return canonical
    except (ValueError, WorkspacePathError) as exc:
        raise CaseLoadError(
            path.name, f"{path.name} is not a file in the workspace"
        ) from exc


class SiennaState:
    """One session's Sienna state: the bridge, the Julia session, the case.

    The constructor takes the same first three arguments
    :meth:`EngineRuntime.make_state` passes the ANDES wrapper. ``workspace``
    and ``session_id`` decide the scratch folder Julia works in;
    ``owner_pid`` is kept for the owner marker the session directories write.
    """

    def __init__(
        self,
        workspace: str | None,
        session_id: str | None,
        owner_pid: int | None,
        bridge: JuliaBridge | None = None,
    ) -> None:
        self._workspace = Path(workspace) if workspace is not None else None
        self._session_id = session_id
        self._owner_pid = owner_pid
        self._bridge = bridge
        self._session: Any = None
        self._case_path: Path | None = None
        self._addfiles: list[Path] | None = None
        self._on_unsupported: str = "refuse"
        self._identity: CaseIdentity | None = None
        self._key_book = KeyBook()
        self._keyed_case: tuple[Path, int, int] | None = None
        self._topology_json: dict[str, Any] | None = None
        self._report_json: dict[str, Any] | None = None
        self._pflow_json: dict[str, Any] | None = None
        self._pflow_settings: PflowSettings | None = None
        self._document: dict[str, Any] | None = None

    # ---- the bridge ---------------------------------------------------------

    def _require_bridge(self) -> JuliaBridge:
        """The bridge, made and started on first use. Its messages name a file of
        the workspace relative to it, as the worker's own log capture does."""
        if self._bridge is None:
            self._bridge = JuliaBridge(scrub=PathScrubber(self._workspace))
        if not self._bridge.started:
            self._bridge.start()
        return self._bridge

    def _require_workspace(self, path: Path) -> Path:
        """The workspace, which every file the engine reads must be in."""
        if self._workspace is None:
            raise CaseLoadError(
                path.name,
                "the Sienna engine reads case files from a workspace only, "
                "and this session has none",
            )
        return self._workspace

    def _scratch_dir(self, workspace: Path, name: str) -> Path:
        """The ``sienna`` subfolder of the session's own scratch directory,
        ``<workspace>/.sessions/<session id>/sienna``, made with the owner marker
        the session directories carry (``tensa.core.session_dirs``), as the
        ANDES engine's clone folder is. The server removes the session directory
        when the session closes."""
        if not self._session_id:
            raise CaseLoadError(
                name, "the Sienna engine needs the session's id for its scratch folder"
            )
        session_root = workspace / SESSIONS_DIRNAME / self._session_id
        scratch = session_root / "sienna"
        scratch.mkdir(parents=True, exist_ok=True)
        write_owner_marker(session_root, self._owner_pid)
        return scratch

    def _drop_case(self) -> None:
        """Forget the case: the state holds none afterwards, and the Julia session
        is released."""
        self._session = None
        self._case_path = None
        self._addfiles = None
        self._on_unsupported = "refuse"
        self._identity = None
        self._key_book = KeyBook()
        self._keyed_case = None
        self._topology_json = None
        self._report_json = None
        self._pflow_json = None
        self._pflow_settings = None
        self._document = None

    # ---- load_case ----------------------------------------------------------

    def load_case(
        self,
        path: Path,
        addfiles: list[Path] | None = None,
        on_unsupported: str = "refuse",
    ) -> TopologySnapshot:
        """Load a PSS/E ``.raw`` or MATPOWER ``.m`` case through Julia.

        Every path that reaches the bridge (the case, the ``.dyr``, the
        scratch folder) is validated against the workspace in Python first, by
        the same validation the ANDES handler uses, because Julia's own file
        reads go through the C library and are invisible to the worker's audit
        hook.

        Raises :class:`CaseLoadError` for a file kind the engine does not
        read, for an addfile that is not one ``.dyr`` with a ``.raw``, for a file
        outside the workspace, and for unsupported dynamic records when
        ``on_unsupported`` is ``"refuse"``; that refusal leaves the state with no
        case. A file Julia cannot read raises :class:`SiennaError` with the Julia
        module's message, and the case held before (if any) stays, as a failed
        load leaves the ANDES engine's.
        """
        suffix = path.suffix.lower()
        if suffix not in (".raw", ".m"):
            raise CaseLoadError(
                path.name,
                f"the Sienna engine reads PSS/E .raw and MATPOWER .m case "
                f"files; {path.name} is neither",
            )
        if on_unsupported not in ("refuse", "drop"):
            raise CaseLoadError(
                path.name,
                f'on_unsupported must be "refuse" or "drop", got '
                f"{short_repr(on_unsupported)}",
            )
        dyr: Path | None = None
        if addfiles:
            if len(addfiles) > 1:
                raise CaseLoadError(
                    path.name,
                    "the Sienna engine takes at most one addfile, a .dyr",
                )
            candidate = Path(addfiles[0])
            if candidate.suffix.lower() != ".dyr":
                raise CaseLoadError(
                    path.name,
                    f"the Sienna engine's addfile must be a .dyr; "
                    f"{candidate.name} is not",
                )
            if suffix != ".raw":
                raise CaseLoadError(
                    path.name,
                    f"a .dyr file goes with a PSS/E .raw case, not with {path.name}",
                )
            dyr = candidate

        workspace = self._require_workspace(path)
        path = _validated(workspace, path)
        if dyr is not None:
            dyr = _validated(workspace, dyr)

        # What the file says where PowerSystems' reader departs from it. A file
        # these readers cannot read goes to Julia without corrections, so that a
        # file that is not a case is refused with the Julia module's message.
        identity: CaseIdentity | None
        document: dict[str, Any] | None
        try:
            identity = read_identity(path)
            document = dict(corrections_document(read_case_facts(path)))
        except (OSError, ValueError) as exc:
            log.debug("the case facts of %s could not be read: %s", path.name, exc)
            identity, document = None, None
        v_setpoints: dict[str, float] | None = None
        corrections: dict[str, Any] | None = None
        if document is not None:
            v_setpoints = {
                str(bus): float(vs) for bus, vs in dict(document["v_setpoints"]).items()
            }
            corrections = julia_corrections(path, document)

        bridge = self._require_bridge()
        scratch = self._scratch_dir(workspace, path.name)
        session = bridge.load_case(path, dyr, scratch, v_setpoints, corrections)
        report = bridge.report(session)
        topology = bridge.topology(session)

        unsupported = report.get("unsupported") or []
        if unsupported and on_unsupported == "refuse":
            del session
            self._drop_case()
            records = "; ".join(
                f"{row.get('model')} at bus {row.get('bus')}, id {row.get('id')}"
                for row in unsupported
            )
            raise CaseLoadError(
                path.name,
                f"the Sienna engine does not support these dynamic records: "
                f'{records}. Load it with on_unsupported "drop" to leave these '
                f"out, or use the ANDES engine.",
            )

        # Keys: keep the book when the same file content is loaded again,
        # start a new one when the file's path, size or modification time
        # differs (the rule of the ANDES wrapper's ``load_case``).
        stamp = _case_stamp(path)
        if self._keyed_case != stamp:
            self._key_book = KeyBook()
            self._keyed_case = stamp
        self._identity = identity

        self._session = session
        self._case_path = path
        self._addfiles = [dyr] if dyr is not None else None
        self._on_unsupported = on_unsupported
        self._topology_json = topology
        self._report_json = report
        self._pflow_json = None
        self._pflow_settings = None
        self._document = document

        book = assign_sienna_keys(topology, identity, self._key_book)

        # What the load found and did goes to the session's message log.
        if document is None:
            log.warning(
                "%s was read without the corrections TENSA makes to what "
                "PowerSystems reads: its records could not be read in Python",
                path.name,
            )
        for level, text in report_messages(report):
            if level == "warning":
                log.warning("%s", text)
            else:
                log.info("%s", text)
        for note in (document or {}).get("notes") or []:
            log.warning("%s", note)

        return topology_snapshot(topology, report, book, ratings=self._ratings(log_unmatched=True))

    def _ratings(self, *, log_unmatched: bool = False) -> dict[str, float] | None:
        """The file's branch ratings, keyed by branch key, for the snapshot and
        the power flow result: where the file gives a branch no rating,
        PowerSystems invents one. ``log_unmatched`` says on ``tensa.notice`` how
        many branch records of the file matched no branch of the System."""
        ratings, unmatched = file_ratings(self._document, self._key_book)
        if unmatched and log_unmatched:
            log.warning(
                "%d branch record(s) of the file matched no branch of the System; "
                "their ratings are the ones PowerSystems reports",
                unmatched,
            )
        return ratings

    # ---- the reads ----------------------------------------------------------

    def _require_session(self) -> Any:
        if self._session is None:
            raise NoCaseLoadedError("no case has been loaded")
        return self._session

    def topology(self) -> TopologySnapshot:
        """The topology of the loaded case, from the held JSON."""
        self._require_session()
        assert self._topology_json is not None  # noqa: S101
        assert self._report_json is not None  # noqa: S101
        ratings = self._ratings()
        return topology_snapshot(
            self._topology_json, self._report_json, self._key_book, ratings=ratings
        )

    def reload_case(self) -> TopologySnapshot:
        """Load the same files again with the same ``on_unsupported``."""
        if self._case_path is None:
            raise NoCaseLoadedError("no case has been loaded")
        return self.load_case(
            self._case_path,
            addfiles=self._addfiles,
            on_unsupported=self._on_unsupported,
        )

    def run_pflow(
        self,
        tolerance: float | None = None,
        max_iterations: int | None = None,
        flat_start: bool | None = None,
        enforce_q_limits: bool | None = None,
        **other: Any,
    ) -> PflowResult:
        """Solve the AC power flow.

        ``flat_start`` or ``enforce_q_limits`` that is not ``None``, or any
        ANDES-only option (``method``, ``n_factorize``, ``linesearch``) that
        is not ``None``, raises :class:`PflowRequestError` naming the option.
        ``tolerance`` must be a finite number above 0 and ``max_iterations``
        an integer of at least 1 (not a bool).
        """
        self._require_session()
        for name in ("flat_start", "enforce_q_limits"):
            value = locals()[name]
            if value is not None:
                raise PflowRequestError(
                    f"the Sienna engine does not take {name}"
                )
        for name in _ANDES_ONLY_PFLOW_OPTIONS:
            value = other.pop(name, None)
            if value is not None:
                raise PflowRequestError(
                    f"the Sienna engine does not take {name}"
                )
        for name, value in other.items():
            if value is not None:
                raise PflowRequestError(
                    f"the Sienna engine does not take {name}"
                )
        if tolerance is not None and (
            isinstance(tolerance, bool)
            or not isinstance(tolerance, int | float)
            or not math.isfinite(float(tolerance))
            or float(tolerance) <= 0
        ):
            raise PflowRequestError(
                f"tolerance must be a finite number above 0, got "
                f"{short_repr(tolerance)}"
            )
        if max_iterations is not None and (
            isinstance(max_iterations, bool)
            or not isinstance(max_iterations, int)
            or max_iterations < 1
        ):
            raise PflowRequestError(
                f"max_iterations must be a whole number of at least 1, got "
                f"{short_repr(max_iterations)}"
            )

        bridge = self._require_bridge()
        pflow = bridge.pflow(
            self._session,
            tolerance=None if tolerance is None else float(tolerance),
            max_iterations=max_iterations,
        )
        self._pflow_json = pflow

        for note in pflow.get("notes", []):
            if isinstance(note, str):
                log.info("%s", note)
            elif isinstance(note, dict):
                text = note.get("text", "")
                level = note.get("level", "info")
                if level in ("warning", "error"):
                    log.warning("%s", text)
                else:
                    log.info("%s", text)

        assert self._topology_json is not None  # noqa: S101
        ratings = self._ratings()
        result = pflow_result(
            pflow, self._topology_json, self._key_book, ratings=ratings
        )
        # The settings the JSON reports, with the fields the Sienna engine
        # has no value for set to the value that states "not used".
        result.settings = PflowSettings(
            tolerance=float(pflow.get("tolerance", 1e-8)),
            max_iterations=int(pflow.get("max_iterations", 30)),
            flat_start=False,
            enforce_q_limits=False,
            method="NR",
            n_factorize=1,
            linesearch=False,
        )
        self._pflow_settings = result.settings
        return result

    def operating_point(self) -> PflowResult:
        """The last power flow's result when one converged; otherwise the
        voltages and angles of the case as loaded, ``converged`` False.

        As the ANDES wrapper's, this leaves ``settings`` and ``summary``
        ``None``: only ``run_pflow`` sets them on its own result.
        """
        self._require_session()
        if self._pflow_json is not None and self._pflow_json.get("converged"):
            assert self._topology_json is not None  # noqa: S101
            ratings = self._ratings()
            result = pflow_result(
                self._pflow_json,
                self._topology_json,
                self._key_book,
                ratings=ratings,
            )
            result.settings = None
            result.summary = None
            return result

        assert self._topology_json is not None  # noqa: S101
        bus_voltages: dict[int | str, float] = {}
        bus_angles: dict[int | str, float] = {}
        bus_keys: dict[str, str] = {}
        for row in self._topology_json.get("buses", []):
            number = int(row["number"])
            bus_voltages[number] = float(row.get("v_pu", 1.0))
            bus_angles[number] = float(row.get("angle_rad", 0.0))
            key = self._key_book.key_of("Bus", number)
            if key is not None:
                bus_keys[str(number)] = key
        return PflowResult(
            converged=False,
            iterations=0,
            mismatch=0.0,
            bus_voltages=bus_voltages,
            bus_angles=bus_angles,
            line_flows={},
            generator_outputs={},
            load_consumption={},
            settings=None,
            summary=None,
            keys={"bus": bus_keys, "line": {}, "generator": {}, "load": {}},
        )

    def keys(self) -> KeyBook:
        """The keys of the loaded case's elements."""
        self._require_session()
        return self._key_book
