"""The embedded Julia of one worker process, behind a small Python surface.

``juliacall`` embeds Julia in the Python process. It is imported inside
:meth:`JuliaBridge.start`, never at module import, so a worker that never runs
Sienna pays nothing for it and importing this module imports no Julia. Before
the import, the environment decides what ``juliacall`` starts:

- ``PYTHON_JULIAPKG_EXE``, ``PYTHON_JULIAPKG_PROJECT`` and
  ``PYTHON_JULIAPKG_OFFLINE=yes``: the Julia executable, the folder holding the
  instantiated Sienna environment, and never download. ``juliapkg`` then uses
  the project as it is: it writes a ``pyjuliapkg`` folder and a ``lock.pid``
  file beside ``Project.toml`` and leaves ``Project.toml`` and
  ``Manifest.toml`` alone, so the folder must be writable.
- ``PYTHON_JULIACALL_EXE``, ``_PROJECT``, ``_BINDIR``, ``_LIB`` and ``_INIT``
  are removed: each would make ``juliacall`` start another Julia or project
  than the one TENSA found, or none.
- ``PYTHON_JULIACALL_THREADS=1`` and ``PYTHON_JULIACALL_HANDLE_SIGNALS=no``:
  one Julia thread, whatever ``JULIA_NUM_THREADS`` says, and Julia installs no
  signal handlers. The worker leaves Ctrl+C to the server and is stopped by it,
  and ``faulthandler`` keeps the crash signals; PythonCall needs Julia's own
  handlers only when Julia runs more than one thread, which it does not here.
  Julia must then be called from the worker's main thread only.
- ``JULIA_LOAD_PATH`` is set to the active project and the standard library,
  so nothing of the user's default Julia environment is loaded.

``juliapkg`` prints ``[juliapkg]`` lines when it resolves, and a worker's
streams must stay clean, so both Python streams are redirected for the import
and what was printed is logged at debug level on ``tensa.sienna``. Julia
writes to the process's file descriptors, which no Python redirect reaches, so
the include of the module runs inside Julia's own ``redirect_stdio`` to a
temporary file, whose text is logged the same way. What Julia itself might
print while ``juliacall`` starts it (``using PythonCall``, which precompiles
only when its cache is stale) is not caught: redirecting the descriptors there
would bind Julia's ``stdout`` and ``stderr`` to the redirect target for the
life of the process.

``juliacall`` is one Julia per process, so a second bridge in the same process
shares the module the first included instead of including it again. The
dynamics module (``TensaSiennaDyn.jl``) is included the same way, but only
when a session first needs dynamics, so a session that only solves power flows
never loads PowerSimulationsDynamics.

Every call into Julia goes through :meth:`JuliaBridge._call`, which turns a
``juliacall.JuliaError`` into :class:`~tensa.core.errors.SiennaError`: the
first line of Julia's message, without the ``ArgumentError: `` or
``ErrorException: `` prefix the module puts on its own messages for the user,
scrubbed of the server's paths. A call with arguments the Julia function has
no method for (a session that is ``None``, say) is the caller's mistake and
stays a ``TypeError``, with the first line of Julia's message only. Everything
logged goes through the same scrubber, at debug level.

The dynamics functions answer JSON documents and report a failure a user can
cause as ``{"ok": false, "stage", "error", "notes"}`` instead of throwing.
Each such answer becomes one :class:`~tensa.core.errors.SiennaError` whose
message is the answer's ``error`` and whose ``stage`` attribute carries the
answer's ``stage`` as Julia gave it; the bridge does not classify stages. Only
a Julia exception (not an answer) is an engine failure, mapped as above.
"""

from __future__ import annotations

import contextlib
import io
import json
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy

from tensa.core.errors import EngineUnavailableError, SiennaError
from tensa.core.messages import PathScrubber
from tensa.engines.sienna import environment

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

log = logging.getLogger("tensa.sienna")

# Prefixes of the Julia module's own messages, which are written for the user;
# another exception type's first line is kept whole.
_OWN_PREFIXES = ("ArgumentError: ", "ErrorException: ")

# The prefix juliacall puts on a Julia error it raises as a Python built-in
# exception, such as the ``TypeError`` of a ``MethodError`` on the called function.
_PYTHONCALL_PREFIX = "Julia: "

# What juliacall reads that would start another Julia or project, or none.
_FOREIGN_JULIACALL = (
    "PYTHON_JULIACALL_EXE",
    "PYTHON_JULIACALL_PROJECT",
    "PYTHON_JULIACALL_BINDIR",
    "PYTHON_JULIACALL_LIB",
    "PYTHON_JULIACALL_INIT",
)

# Includes the module with Julia's streams sent to a temporary file and answers
# what was printed and the error, if any, as text. Used for both modules.
_INCLUDE = """\
let path = tempname(), failure = nothing
    try
        open(path, "w") do io
            redirect_stdio(stdout=io, stderr=io) do
                try
                    include(raw"{module}")
                catch err
                    failure = sprint(showerror, err)
                end
            end
        end
        (read(path, String), failure)
    finally
        rm(path; force=true)
    end
end"""

# The guards for the includes of the lazily loaded modules, the counterpart of
# the one ``start`` runs for the first module.
_INCLUDE_DYN_GUARD = "isdefined(Main, :TensaSiennaDyn)"
_INCLUDE_NET_GUARD = "isdefined(Main, :TensaSiennaNet)"


def _first_line(text: str, fallback: str) -> str:
    """The first line of ``text``, or ``fallback`` when there is none."""
    lines = text.splitlines()
    return lines[0] if lines and lines[0] else fallback


def _float_array(values: Any) -> Any:
    """The Julia vector as a numpy array of floats, in one crossing.

    The array wrapper PythonCall hands a Python callable for a Julia
    ``Vector{Float64}`` supports ``__array__``, so numpy copies the whole
    buffer at once; indexing the wrapper element by element would be a Julia
    call per element. The list comprehension is the fallback for a wrapper
    that does not.
    """
    try:
        return numpy.asarray(values, dtype=float)
    except Exception:
        return numpy.asarray([float(v) for v in values], dtype=float)


class _StepHook:
    """Wraps the user's ``on_step`` so it can cross into Julia and back.

    Julia calls the instance with ``t`` and a Julia ``Vector{Float64}``. A
    return of exactly ``False`` from the user's callable stops the run;
    anything else continues. An exception is stored and ``False`` is returned,
    so Julia ends the run and reports it, and the bridge re-raises the stored
    exception in Python after Julia has returned; a Python exception never
    unwinds through Julia's frames.
    """

    def __init__(self, on_step: Callable[[float, Any], bool]) -> None:
        self._on_step = on_step
        self.error: BaseException | None = None

    def __call__(self, t: Any, values: Any) -> bool:
        if self.error is not None:
            return False
        try:
            result = self._on_step(float(t), _float_array(values))
        except BaseException as exc:  # stored, never raised into Julia
            self.error = exc
            return False
        return result is not False


class JuliaBridge:
    """Owns the embedded Julia of one worker process.

    Nothing happens at construction. :meth:`start` finds Julia, sets the
    environment ``juliacall`` reads, imports it and includes the engine's Julia
    module; the other methods call its functions and parse the JSON strings
    they answer. ``scrub`` takes the server's paths out of a message the way
    the worker scrubs ANDES's messages; without one, a
    :class:`~tensa.core.messages.PathScrubber` with no workspace is used, which
    leaves no absolute path in a message.
    """

    def __init__(self, scrub: Callable[[str], str] | None = None) -> None:
        self._scrub: Callable[[str], str] = PathScrubber() if scrub is None else scrub
        self._jl: Any = None
        self._ts: Any = None
        self._ts_dyn: Any = None
        self._ts_net: Any = None
        self._julia_error: type[Exception] | None = None

    @property
    def started(self) -> bool:
        """Whether :meth:`start` has run to the end."""
        return self._ts is not None

    @property
    def dynamics_started(self) -> bool:
        """Whether :meth:`start_dynamics` has run to the end."""
        return self._ts_dyn is not None

    @property
    def network_started(self) -> bool:
        """Whether :meth:`start_network` has run to the end."""
        return self._ts_net is not None

    def start(self) -> None:
        """Start Julia and include the engine's module. Safe to call again.

        Raises :class:`EngineUnavailableError` when the environment check
        finds a reason Julia cannot start, or when the import of ``juliacall``
        or the include of the module fails.
        """
        if self.started:
            return
        reason = environment.sienna_unavailable_reason()
        if reason is not None:
            raise EngineUnavailableError("sienna", reason)
        executable = environment.julia_executable()
        if executable is None:
            # The check above already covers this; it is here for the type.
            raise EngineUnavailableError("sienna", "Julia was not found")
        self._set_environment(executable, environment.sienna_project())
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                # juliacall ships no type stubs and is not installed where the
                # type check runs in CI; the mypy override for it in
                # pyproject.toml covers both, so everything it hands back is
                # Any and every use of it stays inside this module.
                import juliacall

                jl = juliacall.Main
                if not bool(jl.seval("isdefined(Main, :TensaSienna)")):
                    printed, failure = jl.seval(
                        _INCLUDE.replace("{module}", str(environment.module_path()))
                    )
                    self._log_printed(str(printed))
                    if failure is not None:
                        raise RuntimeError(str(failure))
        except Exception as exc:
            self._log_printed(out.getvalue() + err.getvalue())
            text = self._scrub(str(exc))
            log.debug("Julia could not start: %s", text)
            first = _first_line(text, type(exc).__name__)
            if isinstance(exc, PermissionError):
                # juliapkg writes its lock and its state beside Project.toml.
                name = Path(os.path.abspath(environment.sienna_project())).name
                first = (
                    f"the Sienna Julia environment at {name} cannot be written to, "
                    f"and juliapkg keeps its lock and state there ({first})"
                )
            raise EngineUnavailableError("sienna", f"Julia could not start: {first}") from exc
        self._log_printed(out.getvalue() + err.getvalue())
        self._jl = jl
        self._ts = jl.TensaSienna
        self._julia_error = juliacall.JuliaError

    def start_dynamics(self) -> None:
        """Include the dynamics module. Safe to call again.

        Starts Julia first when it is not started. Raises
        :class:`EngineUnavailableError` when Julia cannot start or the include
        of the dynamics module fails.
        """
        if self.dynamics_started:
            return
        self.start()
        jl = self._jl
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                if not bool(jl.seval(_INCLUDE_DYN_GUARD)):
                    printed, failure = jl.seval(
                        _INCLUDE.replace("{module}", str(environment.dynamics_module_path()))
                    )
                    self._log_printed(str(printed))
                    if failure is not None:
                        raise RuntimeError(str(failure))
        except Exception as exc:
            self._log_printed(out.getvalue() + err.getvalue())
            text = self._scrub(str(exc))
            log.debug("Julia could not load the dynamics module: %s", text)
            first = _first_line(text, type(exc).__name__)
            raise EngineUnavailableError(
                "sienna", f"Julia could not load the dynamics module: {first}"
            ) from exc
        self._log_printed(out.getvalue() + err.getvalue())
        self._ts_dyn = jl.TensaSiennaDyn

    def start_network(self) -> None:
        """Include the network matrix module. Safe to call again.

        Starts Julia first when it is not started. Raises
        :class:`EngineUnavailableError` when Julia cannot start or the include
        of the network module fails.
        """
        if self.network_started:
            return
        self.start()
        jl = self._jl
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                if not bool(jl.seval(_INCLUDE_NET_GUARD)):
                    printed, failure = jl.seval(
                        _INCLUDE.replace("{module}", str(environment.network_module_path()))
                    )
                    self._log_printed(str(printed))
                    if failure is not None:
                        raise RuntimeError(str(failure))
        except Exception as exc:
            self._log_printed(out.getvalue() + err.getvalue())
            text = self._scrub(str(exc))
            log.debug("Julia could not load the network module: %s", text)
            first = _first_line(text, type(exc).__name__)
            raise EngineUnavailableError(
                "sienna", f"Julia could not load the network module: {first}"
            ) from exc
        self._log_printed(out.getvalue() + err.getvalue())
        self._ts_net = jl.TensaSiennaNet

    @staticmethod
    def _set_environment(executable: Path, project: Path) -> None:
        """Set what ``juliacall`` and ``juliapkg`` read when they are imported."""
        for name in _FOREIGN_JULIACALL:
            if os.environ.pop(name, None) is not None:
                log.debug("%s was set; it is removed so TENSA's Julia starts", name)
        os.environ["PYTHON_JULIAPKG_EXE"] = str(executable)
        os.environ["PYTHON_JULIAPKG_PROJECT"] = str(project)
        os.environ["PYTHON_JULIAPKG_OFFLINE"] = "yes"
        os.environ["PYTHON_JULIACALL_THREADS"] = "1"
        os.environ["PYTHON_JULIACALL_HANDLE_SIGNALS"] = "no"
        os.environ["JULIA_LOAD_PATH"] = os.pathsep.join(("@", "@stdlib"))

    def _log_printed(self, text: str) -> None:
        """Log what ``juliapkg`` or Julia printed, a line at a time."""
        for line in self._scrub(text).splitlines():
            if line.strip():
                log.debug("julia: %s", line)

    def load_case(
        self,
        raw: Path,
        dyr: Path | None,
        scratch: Path,
        v_setpoints: Mapping[str, float] | None,
        corrections: Mapping[str, Any] | None,
    ) -> Any:
        """Load a case and return the Julia session object."""
        return self._call(
            "load_case",
            str(raw),
            None if dyr is None else str(dyr),
            scratch=str(scratch),
            v_setpoints=None if v_setpoints is None else json.dumps(v_setpoints),
            corrections=None if corrections is None else json.dumps(corrections),
        )

    def report(self, session: Any) -> dict[str, Any]:
        """What the load found and did."""
        return self._json(self._call("report_json", session))

    def topology(self, session: Any) -> dict[str, Any]:
        """The System in TENSA's terms."""
        return self._json(self._call("topology_json", session))

    def pflow(
        self,
        session: Any,
        tolerance: float | None = None,
        max_iterations: int | None = None,
    ) -> dict[str, Any]:
        """Solve the AC power flow; only the keywords given are passed."""
        keywords: dict[str, Any] = {}
        if tolerance is not None:
            keywords["tolerance"] = tolerance
        if max_iterations is not None:
            keywords["max_iterations"] = max_iterations
        return self._json(self._call("pflow_json", session, **keywords))

    def dc_pflow(self, session: Any, method: str) -> dict[str, Any]:
        """Solve the DC power flow by ``method`` (``"dc"`` or ``"ptdf-dc"``)."""
        self.start_network()
        return self._json(
            self._call("dc_pflow_json", session, _module=self._ts_net, method=method)
        )

    def versions(self) -> dict[str, Any]:
        """The Julia and Sienna package versions of the environment."""
        return self._json(self._call("versions_json"))

    def network_matrix(self, session: Any, kind: str, file: Path) -> dict[str, Any]:
        """Build the matrix and write it to ``file``; answer the JSON descriptor."""
        self.start_network()
        return self._json(
            self._call(
                "network_matrix_json",
                session,
                _module=self._ts_net,
                kind=kind,
                file=str(file),
            )
        )

    def dyn_plan(self, session: Any, load_model: str = "impedance") -> dict[str, Any]:
        """What a dynamic run of this session would be made of.

        A ``ready: false`` answer (no power flow solved, no dynamic models) is
        returned, not raised: it is an ``ok: true`` document with a ``reason``.
        """
        self.start_dynamics()
        return self._checked(
            "dyn_plan_json",
            self._call("dyn_plan_json", session, _module=self._ts_dyn, load_model=load_model),
        )

    def eig(
        self,
        session: Any,
        load_model: str = "impedance",
        matrix_file: Path | None = None,
    ) -> dict[str, Any]:
        """Small-signal analysis at the solved operating point.

        ``matrix_file`` names a file inside the session's scratch folder the
        reduced state matrix is written to; only the keywords given are passed.
        """
        self.start_dynamics()
        keywords: dict[str, Any] = {"load_model": load_model}
        if matrix_file is not None:
            keywords["matrix_file"] = str(matrix_file)
        return self._checked(
            "eig_json", self._call("eig_json", session, _module=self._ts_dyn, **keywords)
        )

    def tds_init(self, session: Any, load_model: str = "impedance") -> dict[str, Any]:
        """Build the simulation and report the initialisation without stepping.

        An ``initialized: false`` answer is returned, not raised: it is an
        ``ok: true`` document with PSID's reason in ``notes``.
        """
        self.start_dynamics()
        return self._checked(
            "tds_init_json",
            self._call("tds_init_json", session, _module=self._ts_dyn, load_model=load_model),
        )

    def tds_run(
        self,
        session: Any,
        tf: float,
        step: float | None = None,
        disturbances: Sequence[Mapping[str, Any]] | None = None,
        load_model: str = "impedance",
        on_step: Callable[[float, Any], bool] | None = None,
    ) -> dict[str, Any]:
        """A time-domain run from 0 to ``tf`` seconds.

        ``disturbances`` is a list of disturbance documents, sent to Julia as
        one JSON string. ``on_step`` is called once for the initial point and
        once after every accepted step with ``(t, values)``, the values a numpy
        array of floats in the column plan's order; returning exactly ``False``
        stops the run. An exception it raises stops the run and is raised again
        here after Julia has returned; it never unwinds through Julia's frames.
        A ``status: "failed"`` answer is returned, not raised: the rows up to
        there are a result.
        """
        self.start_dynamics()
        keywords: dict[str, Any] = {"load_model": load_model}
        if step is not None:
            keywords["step"] = step
        if disturbances is not None:
            keywords["disturbances"] = json.dumps(list(disturbances))
        hook = _StepHook(on_step) if on_step is not None else None
        if hook is not None:
            keywords["on_step"] = hook
        answer: Any = None
        try:
            answer = self._call("tds_run_json", session, _module=self._ts_dyn, tf=tf, **keywords)
        finally:
            # The user's own exception comes out however the Julia call ended,
            # and the Julia answer or error is discarded for it.
            if hook is not None and hook.error is not None:
                raise hook.error from None
        return self._checked("tds_run_json", answer)

    def _checked(self, name: str, answer: Any) -> dict[str, Any]:
        """Parse a dynamics answer and raise on ``ok: false``.

        The Julia side answers ``{"ok": false, "stage", "error", "notes"}``
        for a failure a user can cause. It becomes one
        :class:`~tensa.core.errors.SiennaError` with the answer's ``error`` as
        the message and the answer's ``stage`` carried as an attribute, as
        Julia gave it; the bridge does not classify stages.
        """
        parsed = self._json(answer)
        if parsed.get("ok", True):
            return parsed
        stage = str(parsed.get("stage", ""))
        message = self._scrub(str(parsed.get("error", "the dynamics call failed")))
        log.debug("Julia dynamics %s refused at stage %s: %s", name, stage, message)
        raise SiennaError(message, stage=stage)

    @staticmethod
    def _json(answer: Any) -> dict[str, Any]:
        """Parse the JSON text the Julia side answered (a Julia string becomes a
        Python ``str`` with ``str(...)``)."""
        parsed: dict[str, Any] = json.loads(str(answer))
        return parsed

    def _call(self, name: str, *args: Any, _module: Any = None, **kwargs: Any) -> Any:
        """Call the module's function ``name`` and turn a Julia error into
        :class:`SiennaError`. Every call into Julia goes through here.

        ``_module`` is the Julia module object to call on; it defaults to the
        first module and is the dynamics module for the dynamics functions.
        The keyword is named with a leading underscore so it can never collide
        with a Julia keyword argument.
        """
        module = self._ts if _module is None else _module
        if module is None:
            raise EngineUnavailableError("sienna", "Julia has not been started")
        try:
            return getattr(module, name)(*args, **kwargs)
        except TypeError as exc:
            text = str(exc)
            if not text.startswith(_PYTHONCALL_PREFIX):
                raise
            # No method of the function takes these arguments: the caller's
            # mistake, not the case's, so it stays a TypeError.
            text = self._scrub(text[len(_PYTHONCALL_PREFIX) :])
            log.debug("Julia refused the arguments of %s: %s", name, text)
            raise TypeError(f"{name}: {_first_line(text, 'MethodError')}") from None
        except Exception as exc:
            if self._julia_error is None or not isinstance(exc, self._julia_error):
                raise
            text = self._scrub(str(exc))
            log.debug("Julia error in %s: %s", name, text)
            first = _first_line(text, type(exc).__name__)
            for prefix in _OWN_PREFIXES:
                if first.startswith(prefix):
                    first = first[len(prefix) :]
                    break
            raise SiennaError(first) from exc
