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

import contextlib
import logging
import math
import os
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from tensa.core.disturbance import DisturbanceSpec, FaultSpec, ToggleSpec
from tensa.core.eig_math import (
    _ZERO_EIGENVALUE_TOL,
    _compute_damping_ratio,
    _compute_frequency_hz,
    _settle_axis,
    _settle_zero,
    eigen_decomposition,
)
from tensa.core.eig_result import ComplexNumber, EigResult
from tensa.core.errors import (
    AndesAppError,
    CaseLoadError,
    EigComputationError,
    EigPrerequisiteError,
    ElementNotFoundError,
    NoCaseLoadedError,
    PflowRequestError,
    SiennaError,
    TdsRequestError,
    short_repr,
)
from tensa.core.messages import PathScrubber
from tensa.core.pflow_options import PflowSettings
from tensa.core.session_dirs import SESSIONS_DIRNAME, write_owner_marker
from tensa.core.wrapper.results import PflowResult, TopologySnapshot
from tensa.core.wrapper.ybus import MAX_YBUS_ENTRIES
from tensa.engines.case_facts import corrections_document, read_case_facts
from tensa.engines.identity import _matpower_rows, read_identity
from tensa.engines.keys import KeyBook
from tensa.engines.series_names import build_name
from tensa.engines.sienna.bridge import JuliaBridge
from tensa.engines.sienna.convert import (
    file_ratings,
    pflow_result,
    report_messages,
    topology_snapshot,
)
from tensa.engines.sienna.disturbances import (
    PendingDisturbance,
    run_json_entries,
    to_pending,
    unit_key_of,
)
from tensa.engines.sienna.keys import assign_sienna_keys
from tensa.engines.sienna.matrix_io import read_matrix
from tensa.security.paths import (
    WorkspacePathError,
    canonical_directory,
    open_workspace_file_for_andes,
)

if TYPE_CHECKING:
    from tensa.engines.identity import CaseIdentity

log = logging.getLogger("tensa.notice")

# The network matrix kinds the engine builds (spec section 6.1, ``matrices``).
NETWORK_MATRIX_KINDS = frozenset({"ptdf", "lodf", "ybus", "incidence"})


class NetworkMatrixKindError(AndesAppError):
    """A network matrix kind the Sienna engine does not build."""

    def __init__(self, kind: object) -> None:
        super().__init__(
            f"unknown network matrix kind: {short_repr(kind)}; "
            f"the kinds are ptdf, lodf, ybus, incidence"
        )


class NetworkMatrixTooLargeError(AndesAppError):
    """A network matrix with more entries than one answer carries."""

    def __init__(self, kind: str, entries: int, cap: int) -> None:
        super().__init__(
            f"the {kind} matrix has {entries} entries, more than the {cap} "
            f"one answer carries"
        )

# The ops the Sienna engine does not take, named for the error message.
_ANDES_ONLY_PFLOW_OPTIONS = ("method", "n_factorize", "linesearch")

# The load models a dynamic analysis takes (spec section 6.3).
_LOAD_MODELS = ("impedance", "power", "as-case")

# The TDS request options the Sienna engine does not have, named for the
# refusal message. ``integrator`` is special-cased: the route always sends it,
# and its schema default is read as "not given".
_TDS_OPTIONS_NOT_TAKEN = ("tds_config_overrides", "dae_vars", "controllers")

# The note a batch result carries for the relative rotor angles it does not
# hold (the dyn plan's machines report no inertia; see the unit's resolutions).
_ROTOR_REL_NOTE = (
    "relative rotor angles need each machine's inertia, "
    "which the Sienna engine does not report yet"
)


def _finite_or_none(value: Any) -> float | None:
    """A value of a run's row as a float, or ``None`` for a gap: ``null`` (how
    the Julia side writes a value that is not finite) or a NaN or infinity."""
    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None

# The note every Sienna eigenvalue result carries (spec section 13: PSID's own
# docs call the validation of its small-signal results work in progress, and
# every cross-engine eig comparison shows that note).
SIENNA_EIG_NOTE = (
    "PSID's small-signal results are work in progress in validation, "
    "by PSID's own documentation."
)


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
        self._versions: dict[str, str] | None = None
        self._eig_result: EigResult | None = None
        self._eig_participation: list[list[float]] | None = None
        self._pending_disturbances: list[PendingDisturbance] = []

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
        self._eig_result = None
        self._eig_participation = None
        self._pending_disturbances = []

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
        self._eig_result = None
        self._eig_participation = None
        # A fresh case holds no disturbances, as the ANDES wrapper's load_case
        # wipes the disturbance log.
        self._pending_disturbances = []

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
        # A new operating point is not the one the last analysis linearised at.
        self._eig_result = None
        self._eig_participation = None

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

    # ---- run_eig ------------------------------------------------------------

    def run_eig(self, load_model: str = "impedance") -> EigResult:
        """Small-signal analysis at the solved operating point.

        ``load_model`` is ``"impedance"`` (the default), ``"power"`` or
        ``"as-case"`` (spec section 6.3); any other value raises
        :class:`EigComputationError`. Without a converged power flow in this
        session raises :class:`EigPrerequisiteError` with the message the ANDES
        engine uses. A failure the Julia side reports (``ok`` false) arrives as
        :class:`SiennaError` carrying the answer's ``stage`` and becomes
        :class:`EigComputationError` with the stage and the message, so a case
        with no dynamic models or no solved power flow is a 422 that says why.
        """
        self._require_session()
        # The same gate as the ANDES engine's, on this session's own record.
        if self._pflow_json is None or not self._pflow_json.get("converged"):
            raise EigPrerequisiteError(
                "Run PFlow first; EIG requires a converged operating point."
            )
        if load_model not in _LOAD_MODELS:
            raise EigComputationError(
                f'load_model must be "impedance", "power" or "as-case", got '
                f"{short_repr(load_model)}"
            )

        assert self._case_path is not None  # noqa: S101 - a session has a case
        workspace = self._require_workspace(self._case_path)
        scratch = self._scratch_dir(workspace, "eig")
        sim_dir = scratch / "sim"
        sim_dir.mkdir(parents=True, exist_ok=True)
        matrix_file = sim_dir / "eig-state-matrix.bin"

        bridge = self._require_bridge()
        try:
            answer = bridge.eig(self._session, load_model=load_model, matrix_file=matrix_file)
        except SiennaError as exc:
            stage = getattr(exc, "stage", "eig")
            raise EigComputationError(
                f"eigenvalue analysis failed at {stage}: {exc}"
            ) from exc

        # State names: the unit key of the machine the state belongs to, then
        # the state as PSID names it (``gen:1-1 δ``). A device the key book has
        # no entry for (one PowerSystems renamed) falls back to the name Julia
        # gave, so a name is never empty.
        from tensa.engines.keys import generator_key

        state_names: list[str] = []
        for row in answer["states"]:
            key = generator_key(int(row["bus"]), str(row["id"]))
            entry = self._key_book.entry_of(key)
            prefix = entry.key if entry is not None else str(row["device"])
            state_names.append(f"{prefix} {row['state']}")

        n_states = int(answer["n_states"])
        matrix = read_matrix(matrix_file, n_states, n_states)
        try:
            matrix_file.unlink()
        except OSError:
            log.debug("the state matrix file %s could not be removed", matrix_file.name)
        # The eigenvalues and their factors come from one decomposition of the
        # matrix, as ANDES pairs them: PSID lists the same eigenvalues, but not
        # necessarily in the order a decomposition of ours would, and a factor
        # row must belong to the eigenvalue at its position.
        eigenvalues, self._eig_participation = eigen_decomposition(matrix)
        reported = int(len(answer["eigenvalues"]))
        if len(eigenvalues) != reported:
            raise EigComputationError(
                f"the state matrix has {len(eigenvalues)} eigenvalues and the "
                f"analysis reported {reported}"
            )
        settled = [
            _settle_axis(_settle_zero(z, _ZERO_EIGENVALUE_TOL)) for z in eigenvalues
        ]

        loads = answer.get("loads") or {}
        log.info(
            "Sienna eig: load model %s, %d load(s) converted",
            load_model,
            int(loads.get("converted", 0)),
        )
        for note in answer.get("notes", []):
            log.info("%s", note)
        log.info("%s", SIENNA_EIG_NOTE)

        result = EigResult(
            eigenvalues=[ComplexNumber.from_complex(z) for z in settled],
            damping_ratios=[_compute_damping_ratio(z) for z in settled],
            frequencies_hz=[_compute_frequency_hz(z) for z in settled],
            mode_count=len(settled),
            state_count=len(settled),
            state_names=state_names,
            tds_initialized=True,
        )
        self._eig_result = result
        return result

    def eig_participation(self, mode_idx: int) -> dict[str, object]:
        """Per-mode participation factors, the same dict the ANDES engine answers.

        Served from the matrix of the session's last ``run_eig``, kept in
        memory. Without a prior ``run_eig`` raises :class:`EigPrerequisiteError`
        with the ANDES message; a ``mode_idx`` out of range raises
        :class:`ElementNotFoundError` as the ANDES engine's does.
        """
        self._require_session()
        if self._eig_result is None or self._eig_participation is None:
            raise EigPrerequisiteError(
                "EIG has not been run on this session; run /eig first"
            )
        n_modes = self._eig_result.mode_count
        if mode_idx < 0 or mode_idx >= n_modes:
            raise ElementNotFoundError(
                f"mode_idx {mode_idx} out of range [0, {n_modes - 1}]"
            )
        participation = [
            {"state_name": name, "factor": factor}
            for name, factor in zip(
                self._eig_result.state_names,
                self._eig_participation[mode_idx],
                strict=False,
            )
        ]
        return {"mode_idx": mode_idx, "participation": participation}

    def keys(self) -> KeyBook:
        """The keys of the loaded case's elements."""
        self._require_session()
        return self._key_book

    # ---- network_matrix -------------------------------------------------------

    def _bus_axis_key(self, number: Any) -> str:
        """The key of one bus axis entry. The book holds every bus of the loaded
        case; a bus it does not hold (a reduced bus, say) falls back to the raw
        ``bus:<n>`` key so the answer stays well-formed."""
        from tensa.engines.keys import bus_key

        n = int(number)
        return self._key_book.key_of("Bus", n) or bus_key(n)

    def _arc_axis_entry(self, entry: Mapping[str, Any]) -> dict[str, Any]:
        """One arc axis entry as ``{"from", "to", "keys"}``: the bus numbers of
        the arc and the key of every branch of the topology on that arc
        (parallel circuits share an arc)."""
        from_bus = int(entry["from"])
        to_bus = int(entry["to"])
        pair = (min(from_bus, to_bus), max(from_bus, to_bus))
        keys: list[str] = []
        assert self._topology_json is not None  # noqa: S101
        for branch in self._topology_json.get("branches", []):
            ends = (int(branch["from"]), int(branch["to"]))
            if (min(ends), max(ends)) != pair:
                continue
            key = self._key_book.key_of("Line", str(branch.get("name")))
            if key is not None:
                keys.append(key)
        return {"from": from_bus, "to": to_bus, "keys": keys}

    def _matrix_axis(self, axis: list[Any]) -> list[Any]:
        """One axis of the descriptor with its entries keyed: arc entries as
        ``{"from", "to", "keys"}``, bus entries as ``{"bus", "key"}``."""
        out: list[Any] = []
        for entry in axis:
            if isinstance(entry, Mapping):
                out.append(self._arc_axis_entry(entry))
            else:
                n = int(entry)
                out.append({"bus": n, "key": self._bus_axis_key(n)})
        return out

    def network_matrix(self, kind: str) -> dict[str, Any]:
        """One network matrix of the loaded case.

        ``kind`` is ``"ptdf"``, ``"lodf"``, ``"ybus"`` or ``"incidence"``; any
        other value raises :class:`NetworkMatrixKindError` before any Julia
        call. The answer is the descriptor the route serialises: the axes with
        TENSA keys, the shape, the entry count, and either the values inline
        (``values``) or, for ``ybus``, the sparse triplets (``entries``). A
        matrix with more entries than one answer carries raises
        :class:`NetworkMatrixTooLargeError` after the build.
        """
        self._require_session()
        if kind not in NETWORK_MATRIX_KINDS:
            raise NetworkMatrixKindError(kind)
        assert self._case_path is not None  # noqa: S101 - a session has a case
        workspace = self._require_workspace(self._case_path)
        scratch = self._scratch_dir(workspace, "network-matrix")
        file = scratch / f"{kind}.bin"
        descriptor = self._require_bridge().network_matrix(self._session, kind, file)

        n_rows = int(descriptor["n_rows"])
        n_cols = int(descriptor["n_cols"])
        rows_axis: list[Any] = list(descriptor["rows"])
        cols_axis: list[Any] = list(descriptor["cols"])
        rows = self._matrix_axis(rows_axis)
        cols = self._matrix_axis(cols_axis)
        answer: dict[str, Any] = {
            "kind": kind,
            "n_rows": n_rows,
            "n_cols": n_cols,
            "complex": bool(descriptor["complex"]),
            "base_mva": float((self._topology_json or {}).get("base_mva", 100.0)),
            "rows": rows,
            "cols": cols,
            "distributed_slack": False,
        }
        if "ref_buses" in descriptor:
            answer["ref_buses"] = [
                self._bus_axis_key(number) for number in descriptor["ref_buses"]
            ]

        what = f"{kind} matrix"
        files = [Path(str(file) + ".re"), Path(str(file) + ".im")] if kind == "ybus" else [file]
        try:
            if kind == "ybus":
                re = read_matrix(files[0], n_rows, n_cols, what=what, error=SiennaError)
                im = read_matrix(files[1], n_rows, n_cols, what=what, error=SiennaError)
                # The nonzero entries, row by row, as the ANDES route lists them.
                nonzero_rows, nonzero_cols = np.nonzero((re != 0.0) | (im != 0.0))
                if nonzero_rows.size > MAX_YBUS_ENTRIES:
                    raise NetworkMatrixTooLargeError(
                        kind, int(nonzero_rows.size), MAX_YBUS_ENTRIES
                    )
                answer["n_entries"] = int(nonzero_rows.size)
                answer["entries"] = [
                    {"row": int(r), "col": int(c), "re": float(re[r, c]), "im": float(im[r, c])}
                    for r, c in zip(nonzero_rows, nonzero_cols, strict=True)
                ]
            else:
                # A dense answer: refused by its size before the file is read.
                n_entries = n_rows * n_cols
                if n_entries > MAX_YBUS_ENTRIES:
                    raise NetworkMatrixTooLargeError(kind, n_entries, MAX_YBUS_ENTRIES)
                matrix = read_matrix(file, n_rows, n_cols, what=what, error=SiennaError)
                answer["n_entries"] = n_entries
                answer["values"] = matrix.tolist()
        finally:
            for path in files:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    log.debug("the matrix file %s could not be removed", path.name)
        return answer

    def case_document_parts(
        self,
    ) -> tuple[
        dict[str, Any],
        dict[str, Any] | None,
        dict[str, Any] | None,
        CaseIdentity | None,
        KeyBook,
        Path | None,
        list[Path] | None,
    ]:
        """What the case document builder reads, as one tuple.

        The topology JSON, the report JSON, the corrections document, the
        identity, the key book, the case path and the addfiles. With no case
        loaded raises :class:`NoCaseLoadedError`, as ``topology`` does.
        """
        self._require_session()
        return (
            self._topology_json or {},
            self._report_json,
            self._document,
            self._identity,
            self._key_book,
            self._case_path,
            self._addfiles,
        )

    # ---- disturbances ---------------------------------------------------------

    def add_disturbance(self, spec: DisturbanceSpec) -> str:
        """Accept one disturbance for the next run, in the neutral form.

        Returns the position of the entry in the pending list as a string
        (``"0"``, ``"1"``, ...): the route's ``DisturbanceAck.idx`` wants the
        handle of what was created, and a Sienna disturbance has no engine idx
        until a run builds it. Raises :class:`NoCaseLoadedError` with no case
        and :class:`DisturbanceValidationError` for a spec the engine does not
        take (``disturbances.to_pending``'s message). There is no pre-setup
        gate: a Sienna run builds its simulation from the held system each
        time, so a disturbance is accepted whenever a case is loaded.
        """
        self._require_session()
        pending = to_pending(spec, self._key_book)
        self._pending_disturbances.append(pending)
        neutral = pending.neutral
        target = neutral.get("target") or neutral.get("bus")
        t = neutral.get("t", neutral.get("t_on"))
        log.info(
            "disturbance %s on %s at t=%s is held for the next run",
            neutral["kind"],
            target,
            t,
        )
        return str(len(self._pending_disturbances) - 1)

    def list_disturbances(self) -> list[FaultSpec | ToggleSpec]:
        """The specs accepted since the last load or clear, in order, as the
        ANDES wrapper's ``list_disturbances`` answers them."""
        self._require_session()
        return [item.spec for item in self._pending_disturbances]

    def clear_disturbances(self) -> None:
        """Forget the pending disturbances."""
        self._pending_disturbances = []

    # ---- run_tds ------------------------------------------------------------

    def _require_converged_pflow(self) -> None:
        """The gate every dynamic analysis shares: a solved power flow."""
        if self._pflow_json is None or not self._pflow_json.get("converged"):
            raise TdsRequestError("solve the power flow first")

    def _reference_bus(self) -> int:
        """The bus the relative angles are taken against: the case's reference
        bus, else the first bus by number."""
        assert self._topology_json is not None  # noqa: S101
        buses = sorted(
            int(row["number"]) for row in self._topology_json.get("buses", [])
        )
        for row in self._topology_json.get("buses", []):
            # The Julia module writes PowerSystems' bus types as they are named
            # there, ``REF`` for the reference.
            if str(row.get("type", "")).upper() == "REF":
                return int(row["number"])
        return buses[0] if buses else 0

    def _column_key(self, column: Mapping[str, Any], notes: list[str]) -> str:
        """The key part of a trace name for one column of the run's plan.

        A column whose element the key book lacks is named from its address
        (``bus 7`` or ``2-1``) and noted; the run's result must not fail for
        it.
        """
        quantity = str(column.get("quantity"))
        bus = int(column.get("bus", 0))
        if column.get("kind") == "bus":
            key = self._key_book.key_of("Bus", bus)
            if key is not None:
                return build_name(quantity, key)
            notes.append(f"no key for bus {bus}; its series is named {quantity}|bus {bus}")
            return f"{quantity}|bus {bus}"
        id = str(column.get("id", ""))
        key = unit_key_of(self._key_book, bus, id)
        if key is not None:
            return build_name(quantity, key)
        notes.append(f"no key for the generator at bus {bus} id {id}; its series is named {quantity}|{bus}-{id}")
        return f"{quantity}|{bus}-{id}"

    def run_tds(
        self,
        tf: float,
        h: float | None = None,
        load_model: str = "impedance",
        abort_event: Any = None,
        on_step: Any = None,
        **other: Any,
    ) -> dict[str, Any]:
        """The batch time-domain run, in the shape the ANDES engine answers.

        Options the engine does not have (``integrator`` other than the
        schema's default, ``tds_config_overrides``, ``dae_vars``,
        ``controllers``, and any other unexpected keyword) are refused by name
        with :class:`TdsRequestError` before anything runs, as are a ``tf`` or
        ``h`` that is not a finite number of seconds above 0 and a
        ``load_model`` outside the three of spec section 6.3. Without a
        converged power flow the refusal is "solve the power flow first".

        ``on_step`` is a per-step callback handed to the bridge's
        ``tds_run``: it is called once for the initial point and once after
        every accepted step with ``(t, values)``, and its ``False`` return
        stops the run (the P5-A contract). The streaming driver uses it to
        hand each row to the stream; ``abort_event`` is the other abort
        channel, checked here on every step through the same hook.
        """
        self._require_session()
        integrator = other.pop("integrator", None)
        if integrator not in (None, "trapezoidal"):
            raise TdsRequestError(
                f"the Sienna engine does not take integrator {integrator!r}; "
                "it runs IDA on the residual model"
            )
        for name in _TDS_OPTIONS_NOT_TAKEN:
            value = other.pop(name, None)
            if value is not None and value != [] and value != {}:
                raise TdsRequestError(f"the Sienna engine does not take {name}")
        for name, value in other.items():
            if value is not None and value != [] and value != {}:
                raise TdsRequestError(f"the Sienna engine does not take {name}")
        if (
            isinstance(tf, bool)
            or not isinstance(tf, int | float)
            or not math.isfinite(float(tf))
            or float(tf) <= 0
        ):
            raise TdsRequestError(
                f"tf must be a finite number of seconds above 0, got {short_repr(tf)}"
            )
        if h is not None and (
            isinstance(h, bool)
            or not isinstance(h, int | float)
            or not math.isfinite(float(h))
            or float(h) <= 0
        ):
            raise TdsRequestError(
                f"h must be a finite number of seconds above 0, got {short_repr(h)}"
            )
        if load_model not in _LOAD_MODELS:
            raise TdsRequestError(
                f'load_model must be "impedance", "power" or "as-case", got '
                f"{short_repr(load_model)}"
            )
        self._require_converged_pflow()

        entries = run_json_entries(self._pending_disturbances, self._key_book)

        hook: Any = on_step
        if abort_event is not None:
            user_on_step = on_step

            def hook(t: float, values: Any) -> bool:
                # The abort channel of spec section 13: False stops the run.
                try:
                    if abort_event.is_set():
                        return False
                except Exception:  # noqa: BLE001 - a broken event must not kill a run
                    pass
                if user_on_step is not None:
                    return bool(user_on_step(t, values))
                return True

        bridge = self._require_bridge()
        try:
            answer = bridge.tds_run(
                self._session,
                tf=float(tf),
                step=h,
                disturbances=entries or None,
                load_model=load_model,
                on_step=hook,
            )
        finally:
            # As the ANDES runs do (worker.py): an abort sent while nothing ran
            # stops this run at once, and is spent by it, so it never reaches
            # the run after.
            if abort_event is not None:
                with contextlib.suppress(Exception):
                    abort_event.clear()

        status = str(answer.get("status", "failed"))
        t_values = [float(v) for v in answer.get("t", [])]
        final_t = t_values[-1] if t_values else 0.0
        steps = int(answer.get("steps", 0))
        converged = status == "completed"
        if status == "aborted":
            log.info("the run was aborted at t=%s s", final_t)
        elif status == "failed":
            log.warning("the run failed at t=%s s: %s", final_t, answer.get("error"))

        notes: list[str] = []
        columns = answer.get("columns", [])
        rows = answer.get("rows", [])
        variables: list[dict[str, Any]] = []
        angle_series: list[tuple[int, list[float | None]]] = []
        for position, column in enumerate(columns):
            name = self._column_key(column, notes)
            # The Julia side writes a value that is not finite as null (JSON has
            # no NaN); either is a gap in the series.
            values = [_finite_or_none(row[position]) for row in rows]
            variables.append({"name": name, "values": values})
            if column.get("kind") == "bus" and column.get("quantity") == "angle":
                angle_series.append((int(column.get("bus", 0)), values))

        # angle_rel of every bus against the reference bus, by the shared
        # arithmetic of engines/frames.py. rotor_angle_rel is left out: the
        # dyn plan's machines report no inertia (see _ROTOR_REL_NOTE).
        if angle_series:
            import numpy as np

            from tensa.engines.frames import angle_rel

            reference = self._reference_bus()
            bus_numbers = [bus for bus, _ in angle_series]
            reference_index = (
                bus_numbers.index(reference) if reference in bus_numbers else 0
            )
            matrix = np.asarray(
                [
                    [math.nan if value is None else value for value in values]
                    for _, values in angle_series
                ],
                dtype=float,
            ).T
            relative = angle_rel(matrix, reference_index)
            for column_index, (bus, _) in enumerate(angle_series):
                key = self._key_book.key_of("Bus", bus)
                if key is None:
                    continue
                values = [
                    float(relative[row, column_index])
                    if math.isfinite(float(relative[row, column_index]))
                    else None
                    for row in range(relative.shape[0])
                ]
                variables.append({"name": build_name("angle_rel", key), "values": values})
        notes.append(_ROTOR_REL_NOTE)

        post_payload: dict[str, Any] | None = None
        post = answer.get("post")
        if isinstance(post, Mapping) and post.get("series") is not None:
            post_variables = []
            for series in post.get("series", []):
                bus = int(series.get("bus", 0))
                id = str(series.get("id", ""))
                key = unit_key_of(self._key_book, bus, id)
                if key is None:
                    notes.append(
                        f"no key for the generator at bus {bus} id {id}; "
                        "its post series is left out"
                    )
                    continue
                values = [
                    float(v) if v is not None and math.isfinite(float(v)) else None
                    for v in series.get("y", [])
                ]
                post_variables.append(
                    {"name": build_name(str(series.get("quantity")), key), "values": values}
                )
            post_payload = {
                "t": [float(v) for v in post.get("t", [])],
                "variables": post_variables,
                "truncated": False,
            }

        log.info(
            "TDS to %s s: %s, %d steps, load model %s",
            tf,
            status,
            steps,
            load_model,
        )
        for note in answer.get("notes", []):
            if isinstance(note, str):
                log.info("%s", note)
            elif isinstance(note, Mapping):
                text = str(note.get("text", ""))
                if note.get("level") in ("warning", "error"):
                    log.warning("%s", text)
                else:
                    log.info("%s", text)
        loads = answer.get("loads") or {}
        for left in loads.get("left", []) or []:
            if isinstance(left, Mapping):
                log.warning(
                    "load %s at bus %s was left unconverted: %s",
                    left.get("name"),
                    left.get("bus"),
                    left.get("reason"),
                )

        payload: dict[str, Any] = {
            "converged": converged,
            "final_t": final_t,
            "callpert_count": steps,
            "integrator": "ida",
            # completed, aborted or failed: what a streamed run's end reports.
            "status": status,
            "traces": {
                "t": t_values,
                "variables": variables,
                "truncated": False,
            },
            "controllers": None,
            "notes": notes,
        }
        if post_payload is not None:
            payload["post"] = post_payload
        return payload

    # ---- init_tds -----------------------------------------------------------

    def init_tds(self, test_init: bool = True) -> dict[str, Any]:
        """The initialisation report, in the route's ``TdsInitResult`` shape.

        The Sienna engine has no residual-test toggle: PSID's
        ``read_initial_conditions`` always reports what it found, so
        ``test_init=False`` is refused. ``n_states`` counts the devices'
        states and ``n_algeb`` the bus voltage parts of PSID's state vector.
        Fields with no Sienna meaning (``max_residual``, ``nan_residuals``,
        ``clamped``, ``residuals``) answer the value that states "not used",
        the convention ``run_pflow`` already uses; PSID reports no residual
        table and no clamped-limits table.
        """
        self._require_session()
        if not isinstance(test_init, bool):
            raise TdsRequestError(
                f"test_init must be true or false, got {short_repr(test_init)}"
            )
        if not test_init:
            raise TdsRequestError(
                "the Sienna engine always checks the initialisation; "
                "it does not take test_init false"
            )
        self._require_converged_pflow()
        bridge = self._require_bridge()
        answer = bridge.tds_init(self._session, load_model="impedance")
        initialized = bool(answer.get("initialized"))
        for note in answer.get("notes", []):
            if isinstance(note, str):
                text, level = note, "info"
            elif isinstance(note, Mapping):
                text, level = str(note.get("text", "")), str(note.get("level", "info"))
            else:
                continue
            if not initialized or level in ("warning", "error"):
                log.warning("%s", text)
            else:
                log.info("%s", text)
        # PSID's state vector holds the devices' states and, after them, the
        # real and imaginary voltage of every bus; the Julia answer's
        # ``n_states`` is the whole vector and its ``states`` the devices' part.
        # The route's fields are ANDES's: differential states and algebraic
        # variables apart.
        n_vector = int(answer.get("n_states", 0))
        n_device = len(answer.get("states", []))
        return {
            "initialized": initialized,
            "test_ok": initialized,
            "test_init": True,
            "n_states": n_device,
            "n_algeb": max(n_vector - n_device, 0),
            "max_residual": 0.0,
            "nan_residuals": 0,
            "clamped": [],
            "residuals": [],
            "diagnostics_truncated": False,
        }

    def versions(self) -> dict[str, str]:
        """The versions the running Julia reports, cached after the first call.

        For the results document of a later unit (spec section 9: "The adapter
        records the versions it ran with in every result"). They cannot change
        while the worker lives. A bridge whose ``versions()`` raises answers an
        empty dict, logged at warning: a version lookup must never fail an op.
        """
        if self._versions is None:
            try:
                reported = self._require_bridge().versions()
            except Exception as exc:  # noqa: BLE001 - never fail an op for this
                logging.getLogger("tensa.sienna").warning(
                    "could not read the Sienna versions (%s: %s)",
                    exc.__class__.__name__,
                    exc,
                )
                reported = {}
            self._versions = {str(k): str(v) for k, v in reported.items()}
        return dict(self._versions)
