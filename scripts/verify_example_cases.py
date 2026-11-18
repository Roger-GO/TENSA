#!/usr/bin/env python3
"""Run the example cases through a real TENSA server and check what comes out.

Usage:
    python scripts/verify_example_cases.py [ID ...] [--defaults] [--url URL]
        [--json PATH] [--markdown PATH] [--record-baselines]

For each case of the catalog that has a file (all of them, or the IDs given, or with
``--defaults`` the ones seeded into an empty workspace) the script starts its own
``tensa serve`` on a free port with a temporary workspace (or talks to the server at ``--url``),
and through the HTTP API

1. adds the case from the catalog and opens it (its size has to be the catalog's),
2. runs the power flow,
3. for a case with dynamics, runs 10 s of time domain with nothing acting on it (the events
   its file holds are taken out), runs the eigenvalue analysis, runs a small disturbance and
   compares the frequencies of its ring-down with the eigenvalues, and runs the case's own
   disturbance,

and compares the outputs with the case's reference file,
``server/src/tensa/examples/references/<id>.json`` (the schema is in
``tensa.core.example_references``). Every check is listed with what it was compared with, how
close it had to be and what was found. A check whose reference is ``regression-baseline`` is
TENSA's own earlier output, so it can catch a change and verifies nothing; the report says so.

Checks no reference file is needed for:

- the case adds, opens with the size the catalog states, and its power flow converges;
- the undisturbed run completes to its end time and the largest change of any state or bus
  voltage over it is under ``FLAT_TOLERANCE`` (a power flow solution is an equilibrium of the
  dynamic model, so nothing may move). It records every state the case lists, then the bus
  values, up to the API's limit of ``MAX_DAE_VARS`` variables a run; a case with more says
  so in its notes;
- the eigenvalue analysis returns modes;
- the ring-down of a 2% load step has its strongest oscillations at the frequency and with
  the damping of eigenvalues (within the reference's ``ring_down.tolerance_hz`` and
  ``tolerance_damping``, 0.05 each unless it says otherwise): this compares the linearisation
  with the simulation. Poles damped more than ``ring_down.max_damping_ratio`` are left out, and
  the run must not grow (``GROWTH_WINDOW``, ``GROWTH_LIMIT``);
- the case's disturbance run completes and its rotor angles end within
  ``disturbance.stable_below_deg`` of each other, and, where the reference says
  ``disturbance.settles_within_deg``, within that many degrees of the spread they began with.

The reports are a JSON document and a Markdown page; the exit status is 1 when any check
failed or any case could not be run, and 2 when the arguments or a reference file are wrong
or the server could not be started.
``--record-baselines`` writes what was measured into the ``regression-baseline`` values of the
reference files (the other kinds are never touched). ``--write-catalog`` writes the checks of
the cases that passed into the ``verification`` of their catalog entries (the entry's own
summary stays as it is, since only a person can say what the checks add up to).
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import importlib.util
import json
import math
import platform
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_SRC = REPO_ROOT / "server" / "src"
SCRIPTS = Path(__file__).resolve().parent

if importlib.util.find_spec("tensa") is None:
    sys.path.insert(0, str(SERVER_SRC))
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import numpy as np  # noqa: E402
from crosscheck_pf import format_json  # noqa: E402

from tensa.core.dae_vars import MAX_DAE_VARS  # noqa: E402
from tensa.core.disturbance import AlterSpec  # noqa: E402
from tensa.core.example_catalog import Example, examples_dir, load_catalog  # noqa: E402
from tensa.core.example_references import (  # noqa: E402
    MAP_QUANTITIES,
    DisturbancePlan,
    EventRef,
    ExampleReference,
    ReferenceCheck,
    ReferenceFileError,
    RingDownPlan,
    load_reference,
    references_dir,
)

# The most any state or bus voltage may move in an undisturbed run (per unit, or radians for
# an angle). ANDES initialises from the power flow solution, so a good initialisation moves
# by far less than this; a state that drifts by this much is not at its equilibrium.
FLAT_TOLERANCE = 1e-4
# The undisturbed run: TENSA's default end time, at its default step.
UNDISTURBED_TF = 10.0
# The synchronous machine models whose ``delta`` and ``omega`` the disturbance run measures.
SYNCHRONOUS_MODELS = frozenset({"GENROU", "GENCLS", "PLBVFU1"})
# The most variables one page of ``GET /dae-variables`` gives: the route's ``limit`` maximum
# (asked for no more, it gives 100).
LISTING_PAGE = 1000
# The ring-down run must not grow: the speeds' largest swing in its last ``GROWTH_WINDOW``
# seconds may be at most ``GROWTH_LIMIT`` times their largest swing in the first ones after the
# disturbance. A mode that grows by 0.04 per second or more would break it (one of +1 per
# second turns 1e-3 into 1e5 within the run); the undamped modes of a classical model do not.
GROWTH_WINDOW = 2.0
GROWTH_LIMIT = 2.0
# A tight bound on how long a server takes to bind, and on one request.
SERVER_START_TIMEOUT = 180.0
REQUEST_TIMEOUT = 900.0
# The line ``tensa serve`` prints, or uvicorn's, with the port the OS chose.
_SERVING = re.compile(r"(?:serving|running on) http://127\.0\.0\.1:(\d+)")

Log = Callable[[str], None]

# ----------------------------------------------------------------------------------------
# What a run reports
# ----------------------------------------------------------------------------------------


@dataclass
class Check:
    """One check, in the shape of the catalog's ``VerificationCheck`` plus what was measured."""

    name: str
    analysis: str
    kind: str  # a kind of the catalog's checks, or ``sanity`` for one that needs no reference
    reference: str
    tolerance: str
    result: str
    passed: bool
    measured: float | None = None
    expected: float | None = None


@dataclass
class CaseResult:
    id: str
    title: str
    file: str | None
    analyses: list[str]
    reference_file: str | None = None
    seconds: float = 0.0
    error: str | None = None
    notes: list[str] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.error is None and all(c.passed for c in self.checks)

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        return check

    def sanity(
        self,
        name: str,
        analysis: str,
        reference: str,
        tolerance: str,
        result: str,
        passed: bool,
    ) -> Check:
        return self.add(Check(name, analysis, "sanity", reference, tolerance, result, passed))


# ----------------------------------------------------------------------------------------
# Measuring (pure: these take what the API answered and need no server)
# ----------------------------------------------------------------------------------------


def trace_arrays(traces: dict[str, Any]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """The time axis and each variable of a ``traces`` answer as float arrays (null is NaN)."""
    t = np.asarray(traces["t"], dtype=float)
    series = {v["name"]: np.asarray(v["values"], dtype=float) for v in traces["variables"]}
    return t, series


def largest_change(series: dict[str, np.ndarray]) -> tuple[float, str | None]:
    """The largest ``|x(t) - x(0)|`` of any variable, and the variable it is of."""
    worst, name = 0.0, None
    for key, values in series.items():
        finite = values[np.isfinite(values)]
        if finite.size == 0:
            continue
        change = float(np.max(np.abs(finite - finite[0])))
        if change > worst:
            worst, name = change, key
    return worst, name


def disturbance_metrics(
    traces: dict[str, Any],
    delta_names: Sequence[str],
    omega_names: Sequence[str],
    voltage_names: Sequence[str],
    freq_hz: float,
) -> dict[str, float]:
    """The key numbers of a disturbance run.

    ``initial_angle_spread_deg``, ``max_angle_spread_deg`` and ``final_angle_spread_deg`` are
    the first, the largest and the final difference between the highest and the lowest rotor
    angle (a loaded network starts with machines tens of degrees apart, so the first and the
    last tell a run that ends where it began from one that drifted); ``min_voltage_pu`` the
    lowest bus voltage at any time; ``frequency_nadir_hz`` the lowest machine speed at any
    time, as a frequency (``freq_hz`` times the speed in per unit).
    """
    _, series = trace_arrays(traces)
    out: dict[str, float] = {}
    if delta_names:
        deltas = np.vstack([series[n] for n in delta_names])
        spread = np.nanmax(deltas, axis=0) - np.nanmin(deltas, axis=0)
        out["initial_angle_spread_deg"] = float(np.degrees(spread[0]))
        out["max_angle_spread_deg"] = float(np.degrees(np.nanmax(spread)))
        out["final_angle_spread_deg"] = float(np.degrees(spread[-1]))
    if voltage_names:
        out["min_voltage_pu"] = float(np.nanmin(np.vstack([series[n] for n in voltage_names])))
    if omega_names:
        out["frequency_nadir_hz"] = float(
            freq_hz * np.nanmin(np.vstack([series[n] for n in omega_names]))
        )
    return out


@dataclass(frozen=True)
class Pole:
    """One oscillation found in a signal: its frequency, damping ratio and share of the energy."""

    frequency_hz: float
    damping: float
    relative_energy: float


def ring_down_poles(
    t: np.ndarray,
    signals: Sequence[np.ndarray],
    start: float,
    band_hz: tuple[float, float],
    count: int,
    order_tol: float = 1e-4,
    max_order: int = 40,
    min_fraction: float = 0.01,
    max_damping: float | None = None,
) -> list[Pole]:
    """The strongest oscillations of some signals after ``start``, by the matrix pencil method.

    The signals are resampled onto an even grid from ``start`` and stacked into one block
    Hankel matrix, whose singular value decomposition keeps the ``M`` singular values above
    ``order_tol`` of the largest (at most ``max_order``): ``M`` is the number of exponentials
    the signals hold. The poles are the eigenvalues of the shift of its left singular
    vectors, and each pole's energy is the squared amplitude of its exponential in a least
    squares fit to the signals, so a pole that the signals hardly show is ranked last. The
    ``count`` strongest oscillatory poles inside ``band_hz`` that hold at least
    ``min_fraction`` of the strongest one's energy come back, strongest first, as a frequency
    and a damping ratio, which is what an eigenvalue has too. A pole damped more than
    ``max_damping`` is not taken: in a network with many modes a run of 20 s cannot tell a
    pole that dies within a second or two from its neighbours, so what it finds there is not
    a fair test of an eigenvalue.
    """
    keep = t >= start - 1e-9
    tt = t[keep]
    if tt.size < 30:
        return []
    dt = float(np.median(np.diff(tt)))
    grid = np.arange(tt[0], tt[-1] + dt / 2, dt)
    samples = [np.interp(grid, tt, np.asarray(s, dtype=float)[keep]) for s in signals]
    n = grid.size
    length = n // 3
    hankel = np.hstack([np.array([y[i : i + n - length] for i in range(length)]) for y in samples])
    u, sv, _ = np.linalg.svd(hankel, full_matrices=False)
    order = int(min(max_order, np.count_nonzero(sv > order_tol * sv[0])))
    if order < 2:
        return []
    basis = u[:, :order]
    z = np.linalg.eigvals(np.linalg.pinv(basis[:-1]) @ basis[1:])
    s = np.log(z.astype(complex)) / dt
    vandermonde = z[None, :] ** np.arange(n)[:, None]
    column_energy = np.sum(np.abs(vandermonde) ** 2, axis=0)
    energy = np.zeros(order)
    for y in samples:
        amplitude, *_ = np.linalg.lstsq(vandermonde, y.astype(complex), rcond=None)
        energy += np.abs(amplitude) ** 2 * column_energy
    # Strength is relative to the strongest oscillation in the band: a slow drift in a signal
    # is a repeated pole near 1, whose fitted amplitude is huge and means nothing.
    candidates = [
        i
        for i in range(order)
        if s[i].imag > 0
        and band_hz[0] <= abs(s[i].imag) / (2 * math.pi) <= band_hz[1]
        and (max_damping is None or -s[i].real / abs(s[i]) <= max_damping)
    ]
    if not candidates:
        return []
    top = float(max(energy[i] for i in candidates))
    poles = []
    for i in sorted(candidates, key=lambda i: -energy[i]):
        if energy[i] >= min_fraction * top:
            f = abs(s[i].imag) / (2 * math.pi)
            poles.append(Pole(float(f), float(-s[i].real / abs(s[i])), float(energy[i] / top)))
    return poles[:count]


def swing_peaks(
    t: np.ndarray, signals: Sequence[np.ndarray], start: float, window: float
) -> tuple[float, float]:
    """The largest ``|x(t) - x(0)|`` of any signal in the ``window`` seconds after ``start``,
    and in the last ``window`` seconds of the run."""
    first = [np.asarray(s, dtype=float) for s in signals]
    moved = [np.abs(s - s[0]) for s in first]

    def peak(mask: np.ndarray) -> float:
        values = [m[mask] for m in moved if mask.any()]
        return float(np.nanmax([v.max() for v in values])) if values else 0.0

    return (
        peak((t >= start) & (t <= start + window)),
        peak(t >= t[-1] - window),
    )


def oscillatory_modes(eig: dict[str, Any]) -> list[tuple[float, float]]:
    """The ``(frequency_hz, damping_ratio)`` of every oscillatory eigenvalue of an EIG answer."""
    return [
        (float(f), float(z))
        for f, z in zip(eig["frequencies_hz"], eig["damping_ratios"], strict=True)
        if f > 1e-6
    ]


def least_damped_mode(
    modes: Sequence[tuple[float, float]], window_hz: tuple[float, float]
) -> tuple[float, float] | None:
    """The oscillatory mode with the lowest damping ratio in a frequency window, or ``None``."""
    inside = [m for m in modes if window_hz[0] <= m[0] <= window_hz[1]]
    return min(inside, key=lambda m: m[1]) if inside else None


def match_poles(
    poles: Sequence[Pole],
    modes: Sequence[tuple[float, float]],
    tolerance_hz: float,
    tolerance_damping: float,
) -> list[dict[str, Any]]:
    """For each ring-down pole, the eigenvalue nearest to it and whether it is close enough.

    The nearest is the one with the smallest distance in the complex plane (the frequency in
    Hz and the damping ratio scaled to it), and it matches when its frequency and its damping
    ratio are each within their tolerance.
    """
    out = []
    for pole in poles:
        if modes:
            f, z = min(
                modes,
                key=lambda m: math.hypot(
                    m[0] - pole.frequency_hz, (m[1] - pole.damping) * pole.frequency_hz
                ),
            )
            gap_f, gap_z = abs(f - pole.frequency_hz), abs(z - pole.damping)
        else:
            f, z, gap_f, gap_z = math.nan, math.nan, math.inf, math.inf
        out.append(
            {
                "ring_down_hz": pole.frequency_hz,
                "ring_down_damping": pole.damping,
                "relative_energy": pole.relative_energy,
                "eigenvalue_hz": f,
                "eigenvalue_damping": z,
                "gap_hz": gap_f,
                "gap_damping": gap_z,
                "matched": gap_f <= tolerance_hz and gap_z <= tolerance_damping,
            }
        )
    return out


# ----------------------------------------------------------------------------------------
# Comparing with a reference file
# ----------------------------------------------------------------------------------------


@dataclass
class Measured:
    """What the runs of one case produced, for the reference checks to read."""

    pf: dict[str, Any] | None = None
    tds: dict[str, float] | None = None
    modes: list[tuple[float, float]] | None = None


def _measured_scalar(quantity: str, check: ReferenceCheck, m: Measured) -> float | None:
    if quantity == "pf.loss_mw":
        summary = (m.pf or {}).get("summary") or {}
        return summary.get("loss_p")
    if quantity == "pf.slack_p_mw":
        summary = (m.pf or {}).get("summary") or {}
        return summary.get("slack_p")
    if quantity.startswith("tds."):
        return (m.tds or {}).get(quantity.split(".", 1)[1])
    if quantity.startswith("eig.") and m.modes is not None and check.window_hz is not None:
        mode = least_damped_mode(m.modes, check.window_hz)
        if mode is None:
            return None
        return mode[0] if quantity == "eig.mode_frequency_hz" else mode[1]
    return None


def evaluate_reference_check(check: ReferenceCheck, m: Measured) -> Check:
    """Compare one reference value with what the runs measured."""
    base = {
        "name": check.name,
        "analysis": check.analysis,
        "kind": check.kind,
        "reference": check.reference
        + (
            " (a regression baseline: TENSA's own earlier output, not a verification)"
            if check.kind == "regression-baseline"
            else ""
        ),
        "tolerance": check.tolerance.text() + _unit_suffix(check.quantity),
    }
    if check.quantity in MAP_QUANTITIES:
        return _evaluate_map(check, m, base)
    measured = _measured_scalar(check.quantity, check, m)
    assert isinstance(check.expected, float | int)
    expected = float(check.expected)
    if measured is None:
        why = "the run did not give this number"
        if check.window_hz is not None:
            why = f"no oscillatory eigenvalue between {check.window_hz[0]:g} and {check.window_hz[1]:g} Hz"
        return Check(**base, result=why, passed=False, expected=expected)
    gap = abs(measured - expected)
    passed = check.tolerance.allows(expected, measured)
    result = (
        f"measured {measured:.6g}, expected {expected:.6g}, difference {gap:.3g}"
        f"{_unit_suffix(check.quantity)}"
    )
    return Check(**base, result=result, passed=passed, measured=measured, expected=expected)


def _unit_suffix(quantity: str) -> str:
    unit = {"_pu": " pu", "_deg": " deg", "_mw": " MW", "_hz": " Hz"}
    for ending, text in unit.items():
        if quantity.endswith(ending):
            return text
    return ""


def _evaluate_map(check: ReferenceCheck, m: Measured, base: dict[str, str]) -> Check:
    assert isinstance(check.expected, dict)
    pf = m.pf or {}
    if check.quantity == "pf.bus_voltage_pu":
        got = {k: float(v) for k, v in (pf.get("bus_voltages") or {}).items()}
    else:
        got = {k: math.degrees(float(v)) for k, v in (pf.get("bus_angles") or {}).items()}
    missing = sorted(set(check.expected) - set(got))
    if missing:
        shown = ", ".join(missing[:5]) + (" ..." if len(missing) > 5 else "")
        return Check(
            **base,
            result=f"{len(missing)} buses are not in the result: {shown}",
            passed=False,
        )
    worst_bus, worst = "", 0.0
    outside = 0
    for bus, expected in check.expected.items():
        gap = abs(got[bus] - expected)
        if gap > check.tolerance.bound(expected):
            outside += 1
        if gap >= worst:
            worst_bus, worst = bus, gap
    unit = _unit_suffix(check.quantity)
    result = (
        f"largest difference {worst:.3g}{unit} (bus {worst_bus}) over {len(check.expected)} buses"
    )
    if outside:
        result += f"; {outside} outside the tolerance"
    return Check(**base, result=result, passed=outside == 0, measured=worst)


# ----------------------------------------------------------------------------------------
# The server and the API
# ----------------------------------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, method: str, path: str, status: int, detail: str) -> None:
        super().__init__(f"{method} {path} answered {status}: {detail}")
        self.method, self.path, self.status, self.detail = method, path, status, detail


class Api:
    """The few calls of the HTTP API the harness makes, over ``urllib`` (no dependency).

    The server is on this machine, so a proxy the environment names is not used for it.
    """

    def __init__(self, url: str) -> None:
        self.base = url.rstrip("/") + "/api"
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method: str, path: str, body: Any = None, **query: Any) -> Any:
        url = self.base + path
        if query:
            words = {k: str(v).lower() if isinstance(v, bool) else str(v) for k, v in query.items()}
            url += "?" + urllib.parse.urlencode(words)
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url, data=data, method=method, headers={"Content-Type": "application/json"}
        )
        try:
            with self._opener.open(request, timeout=REQUEST_TIMEOUT) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            with contextlib.suppress(ValueError):
                detail = str(json.loads(detail).get("detail", detail))
            raise ApiError(method, path, exc.code, detail) from exc
        return json.loads(payload) if payload else None

    def get(self, path: str, **query: Any) -> Any:
        return self.call("GET", path, **query)

    def post(self, path: str, body: Any = None, **query: Any) -> Any:
        return self.call("POST", path, {} if body is None else body, **query)

    def delete(self, path: str) -> Any:
        return self.call("DELETE", path)


@contextlib.contextmanager
def running_server(workspace: Path) -> Iterator[str]:
    """Start ``tensa serve`` on a port the OS chooses, yield its URL, and stop it again.

    Only the process started here is stopped, by its pid: ``terminate`` first, which has the
    server end its sessions and their workers, and ``kill`` if that takes over 30 s.
    """
    command = [
        sys.executable,
        "-m",
        "tensa",
        "serve",
        "--bind",
        "127.0.0.1",
        "--workspace",
        str(workspace),
        "--max-sessions",
        "2",
        "--no-warm-cache",
    ]
    proc = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    lines: queue.Queue[str] = queue.Queue()
    log: list[str] = []

    def drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:  # also keeps the pipe from filling
            log.append(line)
            lines.put(line)

    threading.Thread(target=drain, daemon=True).start()
    try:
        deadline = time.monotonic() + SERVER_START_TIMEOUT
        port: int | None = None
        while port is None:
            if proc.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("tensa serve did not start:\n" + "".join(log[-20:]))
            try:
                match = _SERVING.search(lines.get(timeout=1))
            except queue.Empty:
                continue
            if match:
                port = int(match.group(1))
        url = f"http://127.0.0.1:{port}"
        while True:  # the address is printed just before uvicorn accepts connections
            try:
                Api(url).get("/health")
                break
            except (ApiError, urllib.error.URLError, ConnectionError):
                if proc.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError(
                        "tensa serve did not answer:\n" + "".join(log[-20:])
                    ) from None
                time.sleep(0.1)
        yield url
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


# ----------------------------------------------------------------------------------------
# One case
# ----------------------------------------------------------------------------------------


class Session:
    """A session of the server with one case loaded, and what the runs of it need."""

    def __init__(self, api: Api, primary: str, addfiles: list[str]) -> None:
        self.api = api
        self.primary = primary
        self.addfiles = addfiles
        self.id = api.post("/sessions")["session_id"]
        self.topology = api.post(
            f"/sessions/{self.id}/case",
            {"primary_path": primary, "addfiles": addfiles or None},
        )

    def close(self) -> None:
        with contextlib.suppress(ApiError, OSError):
            self.api.delete(f"/sessions/{self.id}")

    def fresh(self, remove_events: Sequence[EventRef], keep_events: bool) -> list[dict[str, Any]]:
        """Reload the case and take out the events of its file; the events still there."""
        self.topology = self.api.post(f"/sessions/{self.id}/reload")
        if not keep_events:
            for event in remove_events:
                model, idx = (urllib.parse.quote(str(x), safe="") for x in (event.model, event.idx))
                self.api.delete(f"/sessions/{self.id}/elements/{model}/{idx}")
            self.topology = self.api.get(f"/sessions/{self.id}/topology")
        return [e for e in self.topology.get("events", []) if e.get("source") == "case"]

    def disturb(self, specs: Sequence[Any]) -> None:
        if specs:
            body = {"disturbances": [s.model_dump(mode="json") for s in specs]}
            self.api.post(f"/sessions/{self.id}/disturbances", body)

    def pflow(self) -> dict[str, Any]:
        return dict(self.api.post(f"/sessions/{self.id}/pflow"))

    def tds(self, tf: float, names: Sequence[str], h: float | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"tf": tf, "dae_vars": list(names)}
        if h is not None:
            body["h"] = h
        return dict(self.api.post(f"/sessions/{self.id}/tds", body))

    def eig(self) -> dict[str, Any]:
        return dict(self.api.post(f"/sessions/{self.id}/eig"))


def event_text(events: Sequence[dict[str, Any]]) -> str:
    return "; ".join(f"{e.get('kind')} {e.get('name')!r} at {e.get('t')} s" for e in events)


def completes(result: dict[str, Any], tf: float) -> tuple[bool, str]:
    final = float(result.get("final_t", math.nan))
    ok = bool(result.get("converged")) and abs(final - tf) <= 1e-6
    return (
        ok,
        f"converged {result.get('converged')}, ended at {final:.6g} s of {tf:g} s",
    )


@dataclass(frozen=True)
class Variables:
    """The ANDES variables the runs record, by what they are used for."""

    flat: list[str]  # every state and bus voltage and angle, for the undisturbed run
    delta: list[str]  # rotor angles of the synchronous machines
    omega: list[str]  # their speeds
    voltage: list[str]  # bus voltage magnitudes
    dropped: int  # states and bus values left out of ``flat`` by the API's limit


def list_variables(api: Api, session_id: str) -> list[dict[str, Any]]:
    """Every variable of the loaded case that ``GET /dae-variables`` lists, page by page.

    The route answers 100 at a time unless asked for more and lists the models in order, the
    buses first (a voltage and an angle each), so the first 100 hold no machine of a case of
    50 buses or more and only some of the states of a smaller one.
    """
    items: list[dict[str, Any]] = []
    while True:
        page = api.get(
            f"/sessions/{session_id}/dae-variables", limit=LISTING_PAGE, offset=len(items)
        )
        items += page["items"]
        # An empty page ends it too, so a listing shorter than its total cannot loop forever.
        if not page["items"] or len(items) >= int(page["total"]):
            return items


def choose_variables(listing: Sequence[dict[str, Any]]) -> Variables:
    """The variables the runs record, from ``GET /dae-variables``."""
    flat = [v["name"] for v in listing if v["kind"] == "x"]
    flat += [v["name"] for v in listing if v["model"] == "Bus" and v["var"] in ("v", "a")]
    machines = [v for v in listing if v["model"] in SYNCHRONOUS_MODELS]
    return Variables(
        flat=flat[:MAX_DAE_VARS],
        delta=[v["name"] for v in machines if v["var"] == "delta"],
        omega=[v["name"] for v in machines if v["var"] == "omega"],
        voltage=[v["name"] for v in listing if v["model"] == "Bus" and v["var"] == "v"],
        dropped=max(0, len(flat) - MAX_DAE_VARS),
    )


def verify_case(
    api: Api,
    example: Example,
    reference: ExampleReference | None,
    *,
    replace_file: bool,
    log: Log = lambda text: None,
) -> tuple[CaseResult, Measured]:
    """Run every analysis of one case and check it. Never raises: a failure is in the result."""
    result = CaseResult(
        id=example.id,
        title=example.title,
        file=None,
        analyses=list(example.analyses),
        reference_file=f"references/{example.id}.json" if reference is not None else None,
    )
    measured = Measured()
    started = time.monotonic()
    try:
        _verify(api, example, reference, replace_file, result, measured, log)
    except ApiError as exc:
        result.error = str(exc)
    except Exception as exc:  # a harness fault must not stop the other cases
        result.error = f"{type(exc).__name__}: {exc}"
    finally:
        result.seconds = round(time.monotonic() - started, 2)
    return result, measured


def _verify(
    api: Api,
    example: Example,
    reference: ExampleReference | None,
    replace_file: bool,
    result: CaseResult,
    measured: Measured,
    log: Log,
) -> None:
    session: Session | None = None
    try:
        if reference is None:
            result.notes.append(
                "No reference file: only the checks that need none were made. "
                f"Write references/{example.id}.json (scripts/crosscheck_pf.py writes the power flow part)."
            )
        # 1. Add from the catalog.
        log("add")
        try:
            added = api.post(f"/examples/{example.id}/add", overwrite=replace_file)
            primary = added["primary"]
            extra = [f["name"] for f in added["files"][1:]]
            warnings = list(added.get("warnings") or [])
            what = "added to the workspace" + (
                " over the copy there" if added["files"][0]["replaced"] else ""
            )
            if warnings:
                result.notes.extend(f"The server warned: {w}" for w in warnings)
        except ApiError as exc:
            if exc.status != 409:
                raise
            # Not ours to replace: use the workspace's own copy and say so.
            primary = Path(example.provenance.path or "").name
            extra = [Path(f.path).name for f in example.files() if not f.primary]
            what = "already in the workspace, and used as it is"
            result.notes.append(
                "The workspace already held this case's file, which was not replaced: what was "
                "checked is that copy."
            )
        result.file = primary
        result.sanity(
            "Case adds from the catalog",
            "pf",
            "the example catalog",
            "the file is added",
            f"{primary} {what}",
            True,
        )
        # 2. Open.
        log("open")
        session = Session(api, primary, extra)
        buses = len(session.topology["buses"])
        want = example.size.buses if example.size else buses
        result.sanity(
            "Opens with the size the catalog states",
            "pf",
            "the example catalog (size.buses)",
            "equal",
            f"{buses} buses, the catalog says {want}",
            buses == want,
        )
        # 3. Power flow.
        log("power flow")
        pf = session.pflow()
        measured.pf = pf
        result.sanity(
            "Power flow converges",
            "pf",
            "TENSA's power flow (ANDES)",
            "converged within the iteration limit",
            f"converged {pf['converged']} in {pf.get('iterations')} iterations, "
            f"mismatch {float(pf.get('mismatch', math.nan)):.2g}",
            bool(pf["converged"]),
        )
        if "tds" in example.analyses and pf["converged"]:
            _dynamic(session, example, reference, result, measured, log)
        elif "tds" in example.analyses:
            result.notes.append(
                "The power flow did not converge, so the time-domain and eigenvalue runs were skipped."
            )
        _reference_checks(reference, result, measured)
    finally:
        if session is not None:
            session.close()


def _dynamic(
    session: Session,
    example: Example,
    reference: ExampleReference | None,
    result: CaseResult,
    measured: Measured,
    log: Log,
) -> None:
    api = session.api
    remove = reference.remove_events if reference else []
    plan = (reference.disturbance if reference else None) or DisturbancePlan(
        description="the events of the case file"
    )
    ring = reference.ring_down if reference else RingDownPlan.model_validate({})
    names = choose_variables(list_variables(api, session.id))
    if names.dropped:
        result.notes.append(
            f"The undisturbed run records the first {MAX_DAE_VARS} states and bus values only."
        )
    freq = float(session.topology.get("freq_hz") or 60.0)

    # Undisturbed run.
    log("undisturbed run")
    left = session.fresh(remove, keep_events=False)
    if left:
        result.sanity(
            "The events of the file are taken out for the undisturbed runs",
            "tds",
            "the case's topology (events)",
            "no event of the file is left",
            "left: " + event_text(left) + ". Name them under remove_events in the reference.",
            False,
        )
    session.pflow()
    run = session.tds(UNDISTURBED_TF, names.flat)
    ok, text = completes(run, UNDISTURBED_TF)
    result.sanity(
        "Undisturbed 10 s run completes",
        "tds",
        "TENSA's time-domain run at its default step",
        f"ends at {UNDISTURBED_TF:g} s",
        text,
        ok,
    )
    if run.get("traces"):
        change, name = largest_change(trace_arrays(run["traces"])[1])
        result.sanity(
            "Undisturbed run stays at its power flow solution",
            "tds",
            "an equilibrium does not move: the power flow solution is the initial state",
            f"{FLAT_TOLERANCE:g} (largest change of any recorded state or bus voltage)",
            f"largest change {change:.3g}" + (f" ({name})" if name else ""),
            change <= FLAT_TOLERANCE,
        )

    # Eigenvalues.
    modes: list[tuple[float, float]] | None = None
    if "eig" in example.analyses:
        log("eigenvalues")
        session.fresh(remove, keep_events=False)
        session.pflow()
        eig = session.eig()
        modes = oscillatory_modes(eig)
        measured.modes = modes
        real = [e["real"] for e in eig["eigenvalues"]]
        result.sanity(
            "Eigenvalue analysis returns the modes",
            "eig",
            "TENSA's eigenvalue analysis (ANDES)",
            "at least one mode",
            f"{eig['mode_count']} modes, {len(modes) // 2 or len(modes)} oscillatory pairs, "
            f"largest real part {max(real):.3g}",
            eig["mode_count"] > 0,
        )
        _ring_down(session, ring, remove, names, modes, result, log)

    # The case's own disturbance.
    log("disturbance")
    events = session.fresh(remove, keep_events=True)
    specs = plan.specs
    if not (specs or events):
        result.sanity(
            "The case has a disturbance to run",
            "tds",
            "the reference file (disturbance), or the events of the case file",
            "a disturbance is defined",
            "none: the file holds no event and the reference gives none",
            False,
        )
        return
    session.disturb(specs)
    session.pflow()
    room = max(0, MAX_DAE_VARS - len(names.delta) - len(names.omega))
    wanted = [*names.delta, *names.omega, *names.voltage[:room]]
    if len(names.voltage) > room:
        result.notes.append(
            f"The disturbance run records the voltage of the first {room} buses only "
            f"(the API records at most {MAX_DAE_VARS} variables)."
        )
    run = session.tds(plan.tf, wanted, plan.h)
    ok, text = completes(run, plan.tf)
    what = plan.description + (f", at a step of {plan.h:.6g} s" if plan.h is not None else "")
    result.sanity(
        "Disturbance run completes",
        "tds",
        "TENSA's time-domain run: " + what,
        f"ends at {plan.tf:g} s",
        text,
        ok,
    )
    if run.get("traces"):
        metrics = disturbance_metrics(
            run["traces"], names.delta, names.omega, names.voltage[:room], freq
        )
        measured.tds = metrics
        final = metrics.get("final_angle_spread_deg")
        if final is not None:
            initial = metrics["initial_angle_spread_deg"]
            result.sanity(
                "Disturbance run stays stable",
                "tds",
                "rotor angles end together (no loss of synchronism)",
                f"final angle spread under {plan.stable_below_deg:g} deg",
                f"final spread {final:.3g} deg, largest {metrics['max_angle_spread_deg']:.3g} deg, "
                f"lowest voltage {metrics.get('min_voltage_pu', math.nan):.4g} pu, "
                f"lowest machine frequency {metrics.get('frequency_nadir_hz', math.nan):.4g} Hz",
                final < plan.stable_below_deg,
            )
            if plan.settles_within_deg is not None:
                result.sanity(
                    "Disturbance run ends where it began",
                    "tds",
                    "a disturbance that is cleared and leaves the network as it was: the rotor "
                    "angles come back to the spread they had before it",
                    f"final angle spread within {plan.settles_within_deg:g} deg of the initial one",
                    f"initial spread {initial:.4g} deg, final {final:.4g} deg "
                    f"(difference {abs(final - initial):.3g} deg)",
                    abs(final - initial) <= plan.settles_within_deg,
                )


def _ring_down(
    session: Session,
    plan: RingDownPlan,
    remove: Sequence[EventRef],
    names: Variables,
    modes: Sequence[tuple[float, float]],
    result: CaseResult,
    log: Log,
) -> None:
    log("ring-down")
    name = "Ring-down of a small disturbance has the frequency and damping of eigenvalues"
    how = (
        "matrix pencil poles of the machines' speeds in a time-domain run, against the "
        "eigenvalues of the same case at the same operating point"
    )
    session.fresh(remove, keep_events=False)
    specs: list[Any] = list(plan.specs)
    stepped = None
    if not specs:
        loads = [x for x in session.topology["loads"] if x.get("kind") == "PQ"]
        if not loads:
            result.sanity(
                name,
                "eig",
                how,
                "a PQ load to step",
                "the case has no PQ load; give ring_down.specs",
                False,
            )
            return
        load = max(loads, key=lambda x: abs(x["params"].get("p0", 0.0)))
        stepped = load["idx"]
        # In a time-domain run a load is a constant impedance (ANDES's default), which reads
        # its equivalent resistance ``Req``; ``Ppf`` is read only by a constant power load.
        specs = [
            AlterSpec(
                model="PQ",
                dev_idx=stepped,
                src="Req",
                t=plan.start_t,
                method="*",
                amount=1.0 / (1.0 + plan.load_step),
            )
        ]
    if not names.omega:
        result.sanity(
            name, "eig", how, "machines with a speed", "the case has no synchronous machine", False
        )
        return
    session.disturb(specs)
    session.pflow()
    run = session.tds(plan.tf, names.omega)
    ok, text = completes(run, plan.tf)
    if not ok or not run.get("traces"):
        result.sanity(name, "eig", how, f"the run reaches {plan.tf:g} s", text, False)
        return
    t, series = trace_arrays(run["traces"])
    speeds = [series[n] for n in names.omega]
    if len(speeds) > 1:  # speeds relative to their mean leave the swings between machines
        mean = np.mean(np.vstack(speeds), axis=0)
        speeds = [s - mean for s in speeds]
    early, late = swing_peaks(t, speeds, plan.start_t, GROWTH_WINDOW)
    result.sanity(
        "The small disturbance does not grow",
        "eig",
        f"the largest swing of the machines' speeds relative to their mean (a case with no "
        f"governor drifts together, which is no mode) in the first {GROWTH_WINDOW:g} s after the "
        f"disturbance and in the last {GROWTH_WINDOW:g} s of the {plan.tf:g} s run: a growing "
        "mode makes the second larger",
        f"the last swing at most {GROWTH_LIMIT:g} times the first",
        f"first {early:.3g} pu, last {late:.3g} pu",
        late <= GROWTH_LIMIT * early,
    )
    poles = ring_down_poles(
        t, speeds, plan.start_t, plan.band_hz, plan.modes, max_damping=plan.max_damping_ratio
    )
    tolerance = f"{plan.tolerance_hz:g} Hz and {plan.tolerance_damping:g} in damping ratio"
    cause = f"step of load {stepped}" if stepped is not None else "the disturbance of the reference"
    source = f"{how}; {cause}, run to {plan.tf:g} s"
    if plan.max_damping_ratio is not None:
        source += f"; poles damped over {plan.max_damping_ratio:g} are not compared"
    if not poles:
        result.sanity(
            name,
            "eig",
            source,
            tolerance,
            f"no oscillation between {plan.band_hz[0]:g} and {plan.band_hz[1]:g} Hz in the run",
            False,
        )
        return
    matches = match_poles(poles, modes, plan.tolerance_hz, plan.tolerance_damping)
    detail = "; ".join(
        f"{m['ring_down_hz']:.3f} Hz, damping {m['ring_down_damping']:.3f} is eigenvalue "
        f"{m['eigenvalue_hz']:.3f} Hz, {m['eigenvalue_damping']:.3f} "
        f"({m['gap_hz']:.3f} Hz and {m['gap_damping']:.3f} apart)"
        for m in matches
    )
    result.add(
        Check(
            name,
            "eig",
            "ring-down",
            source,
            tolerance,
            detail,
            all(m["matched"] for m in matches),
            measured=max(m["gap_hz"] for m in matches),
        )
    )


def _reference_checks(
    reference: ExampleReference | None, result: CaseResult, measured: Measured
) -> None:
    if reference is None:
        return
    for check in reference.checks:
        result.add(evaluate_reference_check(check, measured))


# ----------------------------------------------------------------------------------------
# Reports
# ----------------------------------------------------------------------------------------


def build_report(
    results: Sequence[CaseResult],
    health: dict[str, Any],
    url: str,
    own_server: bool,
    seconds: float,
) -> dict[str, Any]:
    checks = [c for r in results for c in r.checks]
    verified = [c for c in checks if c.kind not in ("sanity", "regression-baseline")]
    return {
        "generated": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "tensa": health.get("version"),
        "andes": health.get("andes_version"),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "server": {"url": url, "started_by_the_script": own_server},
        "seconds": round(seconds, 1),
        "passed": all(r.passed for r in results),
        "counts": {
            "cases": len(results),
            "cases_failed": sum(not r.passed for r in results),
            "checks": len(checks),
            "checks_failed": sum(not c.passed for c in checks),
            "against_a_reference": len(verified),
            "regression_baselines": sum(c.kind == "regression-baseline" for c in checks),
            "sanity": sum(c.kind == "sanity" for c in checks),
        },
        "cases": [{**asdict(r), "passed": r.passed} for r in results],
    }


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def render_markdown(report: dict[str, Any]) -> str:
    """The Markdown page of a report."""
    counts = report["counts"]
    lines = [
        "# Example case verification",
        "",
        f"TENSA {report['tensa']} with ANDES {report['andes']}, Python {report['python']}, "
        f"{report['platform']}, {report['generated']}.",
        "",
        f"**{'All checks passed' if report['passed'] else 'There are failed checks'}**: "
        f"{counts['cases']} cases, {counts['checks']} checks, {counts['checks_failed']} failed, "
        f"{counts['cases_failed']} cases not passing. {counts['against_a_reference']} checks "
        "compare with an independent reference (an independent solver, a published value, a "
        "stored solution, or the eigenvalues for a ring-down). "
        f"{counts['regression_baselines']} are regression baselines, TENSA's own earlier output: "
        f"they catch a change and verify nothing. {counts['sanity']} are sanity checks that "
        "need no reference.",
        "",
        "| Case | Result | Checks | Seconds |",
        "| --- | --- | --- | --- |",
    ]
    for case in report["cases"]:
        failed = sum(not c["passed"] for c in case["checks"])
        lines.append(
            f"| {case['id']} | {'pass' if case['passed'] else 'FAIL'} | "
            f"{len(case['checks'])} ({failed} failed) | {case['seconds']} |"
        )
    for case in report["cases"]:
        lines += ["", f"## {case['id']}: {_cell(case['title'])}", ""]
        lines.append(
            f"File {case['file'] or 'none'}; analyses: {', '.join(case['analyses']) or 'none'}; "
            f"reference file {case['reference_file'] or 'none'}."
        )
        if case["error"]:
            lines += [
                "",
                f"**The case could not be run to the end:** {_cell(case['error'])}",
            ]
        for note in case["notes"]:
            lines += ["", f"Note: {_cell(note)}"]
        if case["checks"]:
            lines += [
                "",
                "| Check | Kind | Compared with | Tolerance | Result | Pass |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
            for c in case["checks"]:
                lines.append(
                    f"| {_cell(c['name'])} | {c['kind']} | {_cell(c['reference'])} | "
                    f"{_cell(c['tolerance'])} | {_cell(c['result'])} | "
                    f"{'pass' if c['passed'] else 'FAIL'} |"
                )
    lines.append("")
    return "\n".join(lines)


def record_baselines(
    results: Sequence[CaseResult], measurements: dict[str, Measured], directory: Path
) -> list[str]:
    """Write what was measured into the ``regression-baseline`` checks of the reference files."""
    written = []
    for result in results:
        path = directory / f"{result.id}.json"
        if not path.is_file():
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for check in document.get("checks", []):
            if check.get("kind") != "regression-baseline" or check["quantity"] in MAP_QUANTITIES:
                continue
            ref = ReferenceCheck.model_validate(check)
            now = _measured_scalar(ref.quantity, ref, measurements[result.id])
            if now is not None and check["expected"] != now:
                check["expected"] = float(f"{now:.8g}")
                changed = True
        if changed:
            path.write_text(format_json(document) + "\n", encoding="utf-8")
            written.append(path.name)
    return written


def catalog_checks(result: CaseResult) -> list[dict[str, Any]]:
    """The checks of a case as the catalog's ``verification`` lists them.

    The catalog's kinds do not include ``sanity``, so the checks that need no reference are
    left out (the entry's summary says that they were made); a regression baseline stays, with
    the report's words that it is TENSA's own earlier output.
    """
    return [
        {
            "name": c.name,
            "kind": c.kind,
            "reference": c.reference,
            "tolerance": c.tolerance,
            "result": c.result,
            "passed": c.passed,
        }
        for c in result.checks
        if c.kind != "sanity"
    ]


def update_catalog(results: Sequence[CaseResult], path: Path) -> list[str]:
    """Put each passing case's checks into ``verification.checks`` of its catalog entry.

    Returns the ids written. An entry with no ``verification.summary`` yet is refused, and so is
    a case that did not pass: the catalog states what was found, and a failed run is no such
    statement. The file is written the way it is kept (two-space JSON).
    """
    document = json.loads(path.read_text(encoding="utf-8"))
    entries = {entry["id"]: entry for entry in document["examples"]}
    written = []
    for result in results:
        entry = entries.get(result.id)
        if entry is None:
            continue
        if not result.passed:
            raise ValueError(f"{result.id} did not pass, so its catalog entry is not updated")
        summary = (entry.get("verification") or {}).get("summary")
        if not summary:
            raise ValueError(
                f"{result.id} has no verification summary: write it in the catalog, then run again"
            )
        entry["verification"] = {"summary": summary, "checks": catalog_checks(result)}
        written.append(result.id)
    if written:
        path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return written


# ----------------------------------------------------------------------------------------
# Command line
# ----------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run example cases through a TENSA server and check the outputs.",
        epilog="Exit status: 0 all passed, 1 a check failed or a case could not be run, "
        "2 the arguments or a reference file are wrong, or the server could not be started.",
    )
    parser.add_argument(
        "ids",
        nargs="*",
        metavar="ID",
        help="example ids (default: every case with a file)",
    )
    parser.add_argument(
        "--defaults",
        action="store_true",
        help="only the cases seeded into an empty workspace",
    )
    parser.add_argument("--url", help="use the server at this URL; none is started")
    parser.add_argument("--json", type=Path, help="write the JSON report here")
    parser.add_argument(
        "--markdown",
        type=Path,
        help="write the Markdown report here (default: print it)",
    )
    parser.add_argument(
        "--record-baselines",
        action="store_true",
        help="write what was measured into the regression-baseline values of the reference files",
    )
    parser.add_argument(
        "--write-catalog",
        action="store_true",
        help="write the checks of the cases that passed into their catalog entries",
    )
    return parser


def select_examples(ids: Sequence[str], defaults: bool) -> list[Example]:
    catalog = load_catalog()
    if ids:
        chosen = []
        for example_id in ids:
            example = catalog.get(example_id)
            if example is None:
                raise ValueError(f"no example case {example_id!r}")
            if not example.has_file:
                raise ValueError(f"{example_id!r} has no file, only links")
            chosen.append(example)
        return chosen
    if defaults:
        return catalog.defaults()
    return [e for e in catalog.examples if e.has_file]


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # A SIGTERM ends the script through its ``finally`` blocks, which is what stops the server
    # it started (the default action would leave that server running).
    with contextlib.suppress(ValueError):  # not the main thread
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        examples = select_examples(args.ids, args.defaults)
        references = {e.id: load_reference(e.id) for e in examples}
    except (ValueError, ReferenceFileError) as exc:
        print(f"verify_example_cases: {exc}", file=sys.stderr)
        return 2

    def log_for(example_id: str) -> Log:
        return lambda text: print(f"  {example_id}: {text}", file=sys.stderr, flush=True)

    started = time.monotonic()
    results: list[CaseResult] = []
    measurements: dict[str, Measured] = {}
    with contextlib.ExitStack() as stack:
        try:
            if args.url:
                url, own = args.url, False
            else:
                workspace = Path(
                    stack.enter_context(tempfile.TemporaryDirectory(prefix="tensa-verify-"))
                )
                url, own = stack.enter_context(running_server(workspace)), True
            health = Api(url).get("/health")
        except (RuntimeError, ApiError, OSError) as exc:
            print(f"verify_example_cases: {exc}", file=sys.stderr)
            return 2
        api = Api(url)
        for example in examples:
            print(f"{example.id}", file=sys.stderr, flush=True)
            result, measured = verify_case(
                api,
                example,
                references[example.id],
                replace_file=own,
                log=log_for(example.id),
            )
            results.append(result)
            measurements[example.id] = measured
            print(
                f"  {example.id}: {'pass' if result.passed else 'FAIL'} in {result.seconds} s",
                file=sys.stderr,
                flush=True,
            )
    report = build_report(results, health, url, own, time.monotonic() - started)
    if args.json:
        args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    page = render_markdown(report)
    if args.markdown:
        args.markdown.write_text(page, encoding="utf-8")
    else:
        sys.stdout.write(page)
    if args.record_baselines:
        for name in record_baselines(results, measurements, references_dir()):
            print(f"recorded baselines in {name}", file=sys.stderr)
    if args.write_catalog:
        try:
            for name in update_catalog(results, examples_dir() / "catalog.json"):
                print(f"wrote the checks of {name} into the catalog", file=sys.stderr)
        except ValueError as exc:
            print(f"verify_example_cases: {exc}", file=sys.stderr)
            return 2
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
