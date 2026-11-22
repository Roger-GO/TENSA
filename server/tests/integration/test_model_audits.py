"""Like-for-like audits of the 14 common dynamic models (spec section 14).

One audit per PSS/E benchmark that PowerSimulationsDynamics 0.16.2 ships under
``test/benchmarks/psse/`` of its installed package: the benchmark's own
``.raw`` and ``.dyr`` are loaded in both engines through the API, so neither
engine's data is retyped by hand. ANDES streams its run over the WebSocket and
Sienna runs in batch, both results go through ``POST /results/convert`` and
are compared through ``POST /compare``, exactly as
``server/tests/integration/test_engines_agree.py`` does for GENROU, and the
electromechanical modes of ``POST /sessions/{id}/eig`` are held to four
significant digits where both engines answer an eigenvalue analysis.

The benchmarks are not copied into the repository (they belong to PSID's
tests). ``_benchmark_files`` finds the installed package folder by running the
engine's Julia once and copies the files of one benchmark into the test's
temporary workspace. Where Julia cannot run, the whole module is skipped with
the Sienna-unavailable reason, as the other Sienna integration tests are.

The ``AUDITS`` table drives the audits. Each row states the benchmark folder,
the files, the models audited (one, or the three of RENA), the disturbance as
the API takes it (mapped from what the PSID test of the benchmark applies),
the run length (the PSID test's, at most 20 s), the bounds and the expected
outcome: ``"agree"``, or ``"differ:<id>"`` naming an entry of
``known_differences.json`` whose evidence test is in
``test_known_differences.py``. The rows that agree are recorded in
``model_audits.json``.

Like for like means both engines hold the same system, so where a benchmark
holds something the two engines read or model differently and that is not the
audited model, the audit gives both engines the same thing instead (each
change is a function below with its reason and measurement): the infinite bus
becomes a machine of large inertia, a GENSAL the GENROU ANDES makes of it, the
TVC system's transformer ratio is written on its first winding, an ESAC1A or
a governor beside the audited model loses what makes it differ. Both runs are
made at steps their own integration error does not show at
(``_ANDES_STEP``, ``_SIENNA_STEP``), and both eigenvalue analyses before the
runs (ANDES linearises the System at the end of a run).

Markers: ``integration`` and ``sienna``; skipped where the Sienna engine is
not available.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.stream import decode_batch
from tensa.engines.sienna.environment import sienna_unavailable_reason
from tests._ws import websocket_session

_REASON = sienna_unavailable_reason()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(_REASON is not None, reason=f"the Sienna engine is not available: {_REASON}"),
]

@dataclass(frozen=True)
class Audit:
    """One row of the audit table: one PSS/E benchmark, run in both engines.

    ``disturbance`` is one disturbance in the API's shape (``kind`` ``fault``
    or ``toggle`` with the target's key). ``bounds`` is
    ``(rotor_speed_max, rotor_speed_rel, voltage_max, voltage_rms, freq_hz,
    damping)``: rotor-speed rows are held to ``rotor_speed_max`` pu and to
    ``rotor_speed_rel`` of the swing, post-clearing voltage rows to
    ``voltage_max`` pu max and ``voltage_rms`` pu RMS, and each matched
    electromechanical mode to ``freq_hz`` Hz in frequency (when it is not
    ``None``, which only a small-signal known difference that moves the
    frequencies leaves it) and, when ``damping`` is not ``None``, to
    ``damping`` in damping ratio. For a ``differ:`` row the time-domain
    bounds are a sanity floor above the measured difference, so the
    difference must be the known one. ``expect`` is ``"agree"``,
    ``"differ:<known-difference id>"`` or ``"refused:<what the engine
    says>"``.
    """

    audit_id: str
    folder: str
    raw: str
    dyr: str
    models: tuple[str, ...]
    disturbance: dict[str, Any]
    t_end: float
    bounds: tuple[float, float, float, float, float | None, float | None]
    expect: str
    note: str


# The bounds of an audit that agrees are worked out from what the audit
# measured (_MEASURED): _MARGIN times each figure, rounded up to one
# significant digit, so that a real difference in the model fails, and never
# tighter than what the runs and the power flow can resolve:
# - rotor speed: both runs are converged to under 1e-6 pu at their steps
#   (_ANDES_STEP, _SIENNA_STEP), so no bound in pu is under _STEP_ERROR_PU,
#   and no share of the swing under _STEP_ERROR_PU over that swing;
# - modes: both engines linearise at a power flow solved to 1e-6 (ANDES's
#   default tolerance), so no frequency or damping bound is under _MODE_FLOOR.
_MARGIN: Final = 10.0
_STEP_ERROR_PU: Final = 1e-6
_MODE_FLOOR: Final = 1e-6


@dataclass(frozen=True)
class Measured:
    """What an audit that agrees measured, with the steps above: the largest
    rotor speed difference over its machines (pu), the largest share of a
    machine's swing and that machine's swing (pu), the largest post-clearing
    voltage difference and RMS difference (pu), and the largest frequency
    (Hz) and damping difference of a matched electromechanical mode (``None``
    where the case has none)."""

    rotor_speed: float
    share: float
    swing: float
    voltage_max: float
    voltage_rms: float
    freq_hz: float | None
    damping: float | None


_MEASURED: Final = {
    "genrou": Measured(1.988e-7, 1.46e-4, 1.363e-3, 1.865e-6, 1.440e-7, 1.30e-8, 7.20e-9),
    "gencls": Measured(9.262e-7, 7.16e-4, 1.294e-3, 3.696e-6, 1.799e-6, 8.64e-9, 1.32e-12),
    "esst1a": Measured(6.001e-6, 7.83e-4, 7.663e-3, 3.941e-5, 7.555e-6, 1.10e-7, 5.63e-8),
    "sexs": Measured(1.926e-7, 2.62e-4, 7.343e-4, 2.168e-6, 1.694e-7, 1.28e-8, 7.17e-9),
    "ieeest": Measured(1.752e-7, 2.52e-4, 6.941e-4, 7.469e-7, 2.070e-7, 1.28e-8, 7.17e-9),
    # The converter chain's one machine stands for the infinite bus and swings
    # by 8.8e-6 pu, so its share of the swing is held at the step error over
    # that swing; the case has no electromechanical mode.
    "renewable": Measured(3.721e-8, 4.22e-3, 8.812e-6, 8.840e-6, 5.396e-7, None, None),
}


def _round_up(value: float) -> float:
    """``value`` rounded up to one significant digit."""
    exponent = math.floor(math.log10(value))
    return float(f"{math.ceil(round(value / 10.0**exponent, 9))}e{exponent}")


def agree_bounds(measured: Measured) -> tuple[float, float, float, float, float, float]:
    """An agreeing audit's bounds from what it measured (see _MARGIN)."""

    def mode(value: float | None) -> float:
        return _MODE_FLOOR if value is None else max(_round_up(_MARGIN * value), _MODE_FLOOR)

    return (
        max(_round_up(_MARGIN * measured.rotor_speed), _STEP_ERROR_PU),
        _round_up(max(_MARGIN * measured.share, _STEP_ERROR_PU / measured.swing)),
        _round_up(_MARGIN * measured.voltage_max),
        _round_up(_MARGIN * measured.voltage_rms),
        mode(measured.freq_hz),
        mode(measured.damping),
    )


# TGOV1, GAST and HYGOV: the known differences tgov1-torque, gast-torque and
# hygov-torque (Sienna's governors hand the machine P_m / omega) raise Sienna's
# damping by the equivalent of D += P_m0 per machine and barely move the
# frequencies. The audit holds the frequencies to test_engines_agree.py's
# 1e-3 Hz (measured: at most 1.0e-4 Hz, HYGOV's 1.39 Hz mode), leaves the
# damping bound None (the difference is asserted against the entry instead),
# and holds the run to a sanity floor, so the difference must be the known one,
# not chaos: 3e-4 pu on rotor speed (above the spike's measured 2.1e-4 on
# Kundur) and 5% of the swing. Measured on the benchmarks, the audited machine
# then the machine of large inertia: TGOV1 1.0e-5 pu (0.6% of the swing) and
# 3.7e-7 pu (0.7%); GAST 1.5e-5 pu (0.9%) and 6.6e-7 pu (1.4%); HYGOV 1.4e-5
# pu (2.2%) and 1.9e-6 pu (0.6%). Post-clearing voltage at most 2.5e-4 pu, RMS
# 7.1e-5 pu (GAST).
_GOVERNOR_TORQUE_BOUNDS: Final = (3e-4, 5e-2, 1e-3, 2e-4, 1e-3, None)
# ESAC1A: the known difference esac1a-rate-feedback changes the exciter's
# modes (Sienna has a 0.839 Hz mode of damping 0.63 that ANDES lacks), so no
# mode bound applies, and the run is held to a sanity floor above what was
# measured: rotor speed 5.7e-4 pu (36% of the swing of 1.6e-3) on the GENROU
# machine and 2.8e-5 pu (38% of 7.5e-5) on the machine of large inertia,
# post-clearing voltage 2.1e-2 pu max and 6.1e-3 pu RMS.
_ESAC1A_BOUNDS: Final = (1e-3, 0.5, 3e-2, 1e-2, None, None)
# EXST1: the known difference exst1-output-limiter is not small-signal, so the
# modes are held as an agreement is (measured: 1.3e-7 Hz and 8.8e-8 in
# damping, held as agree_bounds would hold them), and the run to a sanity
# floor above what was measured: after the trip Sienna's field voltage
# reaches VT * VRMAX and ANDES's never does, and rotor speed differs by 4.5e-4
# pu (5.3% of the swing of 8.4e-3) on the GENROU machine; with VRMAX out of
# reach in both engines the same run differs by 3.3e-6 pu.
_EXST1_BOUNDS: Final = (1e-3, 0.1, 1e-2, 2e-3, 2e-6, _MODE_FLOOR)
# EXAC1: the known difference exac1-transducer moves the modes (by up to
# 0.025 Hz on the benchmark), so no mode bound applies, and the run is held to
# a sanity floor above what was measured: rotor speed 1.0e-4 pu (1.4% of the
# swing of 7.1e-3) and voltage 3.6e-4 pu RMS over the whole run; with TR 0 in
# both engines the same run differs by 8.4e-6 pu.
_EXAC1_BOUNDS: Final = (1e-3, 0.05, 1e-2, 2e-3, None, None)

# The PSID tests of the three-bus benchmarks trip the line between buses 1 and
# 2 at 1.0 s (BranchTrip(1.0, Line, "BUS 1-BUS 2-i_1")); the API's nearest
# kind is a Toggle on that line, keyed branch:101-102-1. The EXST1, EXAC1 and
# ESST1A benchmarks trip the line between buses 1 and 4 of the TVC system
# (branch:1-4-1), and the RENA benchmark the line between buses 1 and 3
# (branch:101-103-1). A Toggle trips at t and never closes, which is what the
# PSID tests do.
_TRIP_101_102: Final = {"kind": "toggle", "target": "branch:101-102-1", "t": 1.0}
_TRIP_1_4: Final = {"kind": "toggle", "target": "branch:1-4-1", "t": 1.0}
_TRIP_101_103: Final = {"kind": "toggle", "target": "branch:101-103-1", "t": 1.0}

AUDITS: Final = (
    Audit(
        audit_id="genrou",
        folder="GENROU",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_GENROU.dyr",
        models=("GENROU",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # test_case15_genrou.jl: tspan = (0.0, 20.0)
        bounds=agree_bounds(_MEASURED["genrou"]),
        expect="agree",
        note="The control audit: GENROU alone on the benchmark's network.",
    ),
    Audit(
        audit_id="gencls",
        folder="GENCLS",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_GENCLS.dyr",
        models=("GENCLS",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # the GENCLS benchmark shares the GENROU test's shape
        bounds=agree_bounds(_MEASURED["gencls"]),
        expect="agree",
        note="Classical machine on the same network.",
    ),
    Audit(
        audit_id="esac1a",
        folder="AC1A",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_ESAC1A.dyr",
        models=("ESAC1A",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # test_case20_ac1a.jl: tspan = (0.0, 20.0)
        bounds=_ESAC1A_BOUNDS,
        expect="differ:esac1a-rate-feedback",
        note="ANDES's ESAC1A never subtracts its rate feedback; Sienna's is IEEE 421.5's.",
    ),
    Audit(
        audit_id="esst1a",
        folder="ESST1A",
        raw="TVC_System_32.raw",
        dyr="TVC_System.dyr",
        models=("ESST1A",),
        disturbance=_TRIP_1_4,
        t_end=20.0,  # test_case55_esst1a.jl: (0.0, 20.0)
        bounds=agree_bounds(_MEASURED["esst1a"]),
        expect="agree",
        # The shipped TVC_System.dyr names EXST1; test_case55_esst1a.jl
        # replaces it with an ESST1A built in code. The audit's .dyr is the
        # shipped file with the EXST1 record replaced by the ESST1A record of
        # the test's esst1a_avr(), in PSS/E column order; see _esst1a_dyr.
        note="The .dyr carries the ESST1A record of test_case55_esst1a.jl's esst1a_avr().",
    ),
    Audit(
        audit_id="exac1",
        folder="EXAC1",
        raw="TVC_System_32.raw",
        dyr="TVC_System.dyr",
        models=("EXAC1",),
        disturbance=_TRIP_1_4,
        t_end=20.0,  # test_case40_exac1.jl: (0.0, 20.0)
        bounds=_EXAC1_BOUNDS,
        expect="differ:exac1-transducer",
        note="ANDES's EXAC1 never uses its transducer lag TR; Sienna's is IEEE 421.5's.",
    ),
    Audit(
        audit_id="exst1",
        folder="EXST1",
        raw="TVC_System_32.raw",
        dyr="TVC_System.dyr",
        models=("EXST1",),
        disturbance=_TRIP_1_4,
        t_end=20.0,  # test_case39_exst1.jl: (0.0, 20.0)
        bounds=_EXST1_BOUNDS,
        expect="differ:exst1-output-limiter",
        note="Run with VRMIN -1 (_exst1_dyr); ANDES's output limiter never acts, Sienna's does.",
    ),
    Audit(
        audit_id="sexs",
        folder="SEXS",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_SEXS.dyr",
        models=("SEXS",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # test_case26_SEXS.jl: tspan = (0.0, 20.0)
        bounds=agree_bounds(_MEASURED["sexs"]),
        expect="agree",
        note="The benchmark's GENROU machine carries the SEXS.",
    ),
    Audit(
        audit_id="ieeest",
        folder="IEEEST",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_IEEEST.dyr",
        models=("IEEEST",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # test_case30_ieeest.jl: tspan = (0.0, 20.0)
        bounds=agree_bounds(_MEASURED["ieeest"]),
        expect="agree",
        note="The benchmark's GENROU machine carries a SEXS and the IEEEST.",
    ),
    Audit(
        audit_id="gast",
        folder="GAST",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_GAST.dyr",
        models=("GAST",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # test_case21_gast.jl: (0.0, 20.0)
        bounds=_GOVERNOR_TORQUE_BOUNDS,
        expect="differ:gast-torque",
        note="Sienna's GasTG hands the machine P_m / omega; the ESAC1A beside it runs without rate feedback.",
    ),
    Audit(
        audit_id="hygov",
        folder="HYGOV",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_HYGOV.dyr",
        models=("HYGOV",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # test_case31_hygov.jl: (0.0, 20.0)
        bounds=_GOVERNOR_TORQUE_BOUNDS,
        expect="differ:hygov-torque",
        note="Sienna's HydroTurbineGov hands the machine P_m / omega, ANDES's HYGOV P_m.",
    ),
    Audit(
        audit_id="tgov1",
        folder="TGOV1",
        raw="ThreeBusMulti.raw",
        dyr="ThreeBus_TGOV1.dyr",
        models=("TGOV1",),
        disturbance=_TRIP_101_102,
        t_end=20.0,  # test_case22_SteamTurbineGov1.jl: (0.0, 20.0)
        bounds=_GOVERNOR_TORQUE_BOUNDS,
        expect="differ:tgov1-torque",
        note="The known difference: Sienna hands the machine P_m / omega, ANDES P_m.",
    ),
    Audit(
        audit_id="renewable",
        folder="RENA",
        raw="ThreeBusRenewable.raw",
        dyr="ThreeBus_REN_A_DEFAULT_FLAG.dyr",
        models=("REGCA1", "REECB1", "REPCA1"),
        disturbance=_TRIP_101_103,
        t_end=5.0,  # test_case29_renewablemodels.jl: tspan = (0.0, 5.0)
        bounds=agree_bounds(_MEASURED["renewable"]),
        expect="agree",
        # The chain's three models are one audit: neither engine can run
        # REECB1 or REPCA1 without REGCA1 (the converter is the injector).
        # The shipped record carries a quoted flag token ('0 ') that ANDES's
        # PSS/E reader rejects, so the audit writes a sanitized copy beside
        # the byte-identical originals; see _write_rena_dyr.
        note="One audit for the converter chain; the .dyr is sanitized of its quoted flag.",
    ),
)

_AUDIT_IDS: Final = frozenset(audit.audit_id for audit in AUDITS)

# The band that holds the electromechanical modes: the spike's 0.64, 1.10 and
# 1.13 Hz modes and the governor mode at 0.07 Hz, and no slower mode.
_MODE_BAND_HZ: Final = (0.05, 2.5)

# The audits whose case has no electromechanical mode in either engine (see
# test_audit_modes).
_NO_ELECTROMECHANICAL_MODE: Final = frozenset({"renewable"})

# Four significant digits on a real or imaginary part, as
# test_known_differences.py holds.
_FOUR_DIGITS: Final = 5e-5


def _ok(response: Any) -> Any:
    assert response.status_code == 200, response.text
    return response.json()


def _psid_pkg_dir() -> Path:
    """The installed PowerSimulationsDynamics package folder, found by running
    the engine's Julia once with the same environment variables the Sienna
    tests use: ``TENSA_JULIA`` for the interpreter and
    ``TENSA_SIENNA_PROJECT`` for the project, the names the Sienna
    environment reads."""
    julia = os.environ.get("TENSA_JULIA", "julia")
    project = os.environ.get("TENSA_SIENNA_PROJECT")
    command = [julia]
    if project:
        command.append("--project=" + project)
    command += ["-e", "import PowerSimulationsDynamics as P; print(pkgdir(P))"]
    out = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    return Path(out.stdout.strip())


def _esst1a_dyr(text: str) -> str:
    """The ESST1A benchmark's .dyr: the shipped TVC_System.dyr of the ESST1A
    folder names EXST1, and test_case55_esst1a.jl replaces that AVR in code
    with the ESST1A of its ``esst1a_avr()``. The audit carries the same
    replacement as a record, in the PSS/E ESST1A column order (UEL flags,
    PSS flags, Tr, Vimax, Vimin, Tc, Tb, Tc1, Tb1, Ka, Ta, Vamax, Vamin,
    Vrmax, Vrmin, Kc, Kf, Tf, Klr, Ilr), with the test's values:
    flags 1 and 1, Tr 0.01, Vi limits 5 and -5, Tc = Tb1 = 14.142135623731,
    Tb = Tc1 = 20, Ka 200, Ta 0.1, Va limits 6.3 and 2.1, Vr limits 6 and 0,
    Kc 0.5, Kf 0.01, Tf 0.01, Klr 0.01, Ilr 2.8."""
    esst1a = (
        "2 'ESST1A' 1  1 1 0.01 5.0 -5.0 14.142135623731 20.0 "
        "14.142135623731 20.0 200.0 0.1 6.3 2.1 6.0 0.0 0.5 0.01 0.01 0.01 2.8 /"
    )
    records = [r.strip() for r in text.split("/") if r.strip()]
    kept = [r for r in records if re.split(r"[\s,]+", r)[1].strip("'") != "EXST1"]
    assert len(kept) == len(records) - 1
    return "".join(f"{r} /\n" for r in kept) + esst1a + "\n"


# The column of VRMIN among the values of a PSS/E EXST1 record (after the bus,
# the model and the id): TR VIMAX VIMIN TC TB KA TA VRMAX VRMIN.
_EXST1_VRMIN_COLUMN: Final = 8
# The VRMIN the EXST1 audit runs with, in place of the benchmark's 0.
_EXST1_AUDIT_VRMIN: Final = -1.0


def _exst1_dyr(text: str) -> str:
    """The EXST1 benchmark's .dyr with the EXST1's VRMIN at
    ``_EXST1_AUDIT_VRMIN``.

    The benchmark gives VRMIN 0, KC 0 and KF 0. ANDES's EXST1 decides whether
    the field voltage is at a limit from the output of its rate feedback
    washout, not from the regulator's output (the known difference
    ``exst1-output-limiter``); with KF 0 that output is 0 throughout, equal to
    the lower limit VRMIN - KC * Ifd = 0, so ANDES holds the field voltage at
    0, fails its initialisation (the residual of ``vout`` is the field
    voltage, 2.0 pu) and loses synchronism at 5.5 s. With VRMIN -1 in both
    engines ANDES initialises, and the regulator's output (about 2 pu) never
    reaches that limit in Sienna either, so the audit compares the rest of the
    exciter."""
    out = []
    for record in text.split("/"):
        parts = record.replace(",", " ").split()
        if len(parts) >= 3 and parts[1].strip("'") == "EXST1":
            values = parts[3:]
            assert len(values) == 12 and float(values[_EXST1_VRMIN_COLUMN]) == 0.0, record
            values[_EXST1_VRMIN_COLUMN] = str(_EXST1_AUDIT_VRMIN)
            record = f"\n{parts[0]} 'EXST1' {parts[2]} " + " ".join(values) + " "
        out.append(record)
    return "/".join(out)


# The column of VMIN among the values of a PSS/E REECB1 record (after the bus,
# the model and the id): five flags, then Vdip Vup Trv dbd1 dbd2 Kqv Iqh1 Iql1
# Vref0 Tp QMax QMin VMAX VMIN.
_REECB1_VMIN_COLUMN: Final = 18
# The VMIN the renewable audit runs with, in place of the benchmark's 0.9.
_REECB1_AUDIT_VMIN: Final = -1.0


def _write_rena_dyr(source: Path, target: Path) -> None:
    """The RENA benchmark's .dyr, with the quoted flag token of its REPCA1
    record ('0 ') replaced by a plain 0, and the REECB1's VMIN at
    ``_REECB1_AUDIT_VMIN``.

    ANDES's PSS/E reader parses every value of a renewable record as a number
    and rejects the quote; PSID's own parser takes it. The REECB1 runs with
    VFLAG 0 and QFLAG 0, where the voltage PI that VMIN and VMAX limit is out
    of the path to the current command in both engines; ANDES still
    initialises that PI's output at 0, finds it below VMIN 0.9, and reports
    the whole initialisation as failed, which TENSA reports as a run that did
    not converge. A VMIN below 0 leaves the path as it was and lets ANDES's
    initialisation pass."""
    text = source.read_text(encoding="utf-8")
    assert "'0 '" in text
    text = text.replace("'0 '", "0")
    out = []
    for record in text.split("/"):
        parts = record.replace(",", " ").split()
        if len(parts) >= 3 and parts[1].strip("'") == "REECB1":
            values = parts[3:]
            assert len(values) == 30 and float(values[_REECB1_VMIN_COLUMN]) == 0.9, record
            values[_REECB1_VMIN_COLUMN] = str(_REECB1_AUDIT_VMIN)
            record = f"\n{parts[0]} 'REECB1' {parts[2]} " + " ".join(values) + " "
        out.append(record)
    target.write_text("/".join(out), encoding="utf-8")


def _disturbance_for(client: TestClient, sid: str, disturbance: dict[str, Any]) -> dict[str, Any]:
    """The audit's disturbance as the disturbance route takes it for this
    session: a Toggle names the element by the engine's own model and idx,
    which the session's key listing gives for the audit's key."""
    keys = _ok(client.get(f"/api/sessions/{sid}/keys"))["keys"]
    entry = next((e for e in keys if e["key"] == disturbance["target"]), None)
    assert entry is not None, f"{disturbance['target']} is not an element of the case"
    return {"kind": "toggle", "model": entry["model"], "dev_idx": entry["idx"], "t": disturbance["t"]}


# The inertia, in seconds on the machine base, given to a GENCLS record the
# benchmark writes with none (H = 0, PSS/E's infinite bus). PowerSystems reads
# such a record as a voltage Source; ANDES has no infinite bus, and a GENCLS
# with no inertia leaves its time-domain run without a solution (it ends
# unconverged on every benchmark). Both engines are given the same machine of
# large inertia instead, so the two hold one network: like for like, which is
# what an audit compares, at the cost of the PSS/E results the benchmark's own
# CSV holds for the infinite bus.
_INFINITE_BUS_H: Final = 1000.0


# The steps of the two runs: ANDES's fixed step and the largest step of
# Sienna's (IDA's dtmax). At the steps an engine runs by default the error of
# its own integration is what an audit would measure:
# - Sienna at its default of 1/30 s: on the GENROU benchmark it differs from
#   Sienna at 1/240 s by 3.0e-5 pu in rotor speed (2.2% of the swing, at 2.5 s,
#   as the oscillation peaks); at 1/240 s it lies 1.9e-7 pu from ANDES at 1/960
#   s.
# - ANDES at 1/120 s (test_engines_agree.py's step): on the GENCLS benchmark,
#   whose 1.44 Hz mode has a damping ratio of 0.0002 and rings for the whole 20
#   s, the trapezoidal rule's phase error grows to 1.15e-5 pu against ANDES at
#   1/480 s by 19.9 s; ANDES at 1/480 s lies 9.3e-7 pu from Sienna at 1/240 s
#   and 8.6e-7 pu from Sienna at 1/960 s, and Sienna at those two steps 3.4e-7
#   pu apart.
# At these steps both runs are converged to under 1e-6 pu, so what is left is
# the two engines' models.
_ANDES_STEP: Final = 1 / 480
_SIENNA_STEP: Final = 1 / 240


def _with_inertia(dyr_text: str) -> str:
    """``dyr_text`` with every GENCLS record of no inertia given
    ``_INFINITE_BUS_H`` (and no damping), the rest of the file as it was."""
    records = dyr_text.split("/")
    out = []
    for record in records:
        parts = record.replace(",", " ").split()
        if len(parts) >= 5 and parts[1].strip("'") == "GENCLS" and float(parts[3]) == 0.0:
            record = f"\n {parts[0]} 'GENCLS' {parts[2]} {_INFINITE_BUS_H} 0.0 "
        out.append(record)
    return "/".join(out)


def _gensal_as_genrou(dyr_text: str) -> str:
    """``dyr_text`` with every GENSAL record written as the GENROU that ANDES
    makes of it, the rest of the file as it was.

    ANDES has no GENSAL: its reader runs a GENSAL record as a GENROU with the
    q axis given the d axis's transient values (``andes/io/psse-dyr.yaml``:
    ``xq1: Xd1``, ``Tq10: Td10``, ``xq2: Xd2``), where Sienna runs the salient
    pole machine. The TVC benchmarks audit an exciter (EXAC1, EXST1, ESST1A)
    on such a machine, so both engines are given that GENROU, which the GENROU
    audit holds them to, and the audit compares the exciter alone. A GENSAL
    record holds ``T'do T''do T''qo H D Xd Xq X'd X''d Xl S(1.0) S(1.2)``; a
    GENROU record ``T'do T''do T'qo T''qo H D Xd Xq X'd X'q X''d Xl S(1.0)
    S(1.2)``."""
    out = []
    for record in dyr_text.split("/"):
        parts = record.replace(",", " ").split()
        if len(parts) >= 3 and parts[1].strip("'") == "GENSAL":
            assert len(parts) == 15, record
            bus, _, machine_id = parts[:3]
            td0p, td0pp, tq0pp, h, d, xd, xq, xdp, xdpp, xl, s10, s12 = parts[3:]
            values = (td0p, td0pp, td0p, tq0pp, h, d, xd, xq, xdp, xdp, xdpp, xl, s10, s12)
            record = f"\n{bus} 'GENROU' {machine_id} " + " ".join(values) + " "
        out.append(record)
    return "/".join(out)


# The column of KF among the values of a PSS/E ESAC1A record (after the bus,
# the model and the id): TR TB TC KA TA VAMAX VAMIN TE KF.
_ESAC1A_KF_COLUMN: Final = 8


def _esac1a_without_rate_feedback(dyr_text: str) -> str:
    """``dyr_text`` with the rate feedback gain KF of every ESAC1A record set
    to 0, the rest of the file as it was.

    ANDES's ESAC1A has no rate feedback (the known difference
    ``esac1a-rate-feedback``, which the ESAC1A audit shows), so the governor
    audits whose benchmark machine carries an ESAC1A (GAST, TGOV1) give both
    engines the exciter without it: like for like, the ESAC1A then agrees to
    five digits in the modes, and what the audit compares is the governor."""
    out = []
    for record in dyr_text.split("/"):
        parts = record.replace(",", " ").split()
        if len(parts) >= 3 and parts[1].strip("'") == "ESAC1A":
            assert len(parts) == 22, record
            values = parts[3:]
            values[_ESAC1A_KF_COLUMN] = "0.0"
            record = f"\n{parts[0]} 'ESAC1A' {parts[2]} " + " ".join(values) + " "
        out.append(record)
    return "/".join(out)


# The governors of the benchmarks. Each differs between the engines by its
# known difference (``<model>-torque``), so an audit of something else gives
# both engines the machine without the governor the benchmark puts beside it:
# the TVC benchmarks of EXAC1, EXST1 and ESST1A carry a HYGOV.
_GOVERNORS: Final = ("GAST", "HYGOV", "TGOV1")


def _without_other_governors(dyr_text: str, audited: tuple[str, ...]) -> str:
    """``dyr_text`` without the records of the governors not in ``audited``."""
    out = []
    for record in dyr_text.split("/"):
        parts = record.replace(",", " ").split()
        if len(parts) >= 2 and parts[1].strip("'") in _GOVERNORS and parts[1].strip("'") not in audited:
            continue
        out.append(record)
    return "/".join(out)


# The two windings of the TVC system's step-up transformer (bus 2 to bus 4):
# WINDV1 1.0 on 13.8 kV and WINDV2 1.04 on 230 kV, a ratio of 1/1.04. ANDES
# reads WINDV1 alone, and Sienna the file's ratio (decision 27 of
# design/multiengine/decisions.md), so the two engines hold networks 4% apart
# in that ratio and differed by 3.7e-2 pu RMS on the voltages of buses 3 and 4
# whatever the exciter. The audit writes the same ratio on the first winding
# (WINDV1 1/1.04, WINDV2 1), which both engines read alike.
_TVC_WINDINGS: Final = (("1.00000,  13.800,", "0.961538461538,  13.800,"), ("1.04000, 230.000", "1.00000, 230.000"))


def _tvc_ratio_on_winding_one(raw_text: str) -> str:
    for old, new in _TVC_WINDINGS:
        assert raw_text.count(old) == 1, old
        raw_text = raw_text.replace(old, new)
    return raw_text


def _benchmark_files(audit: Audit, workspace: Path) -> dict[str, Any]:
    """Copy the audit's benchmark files into ``workspace`` and answer the case
    payload ``test_engines_agree.py`` posts. What the audit changes in them,
    for both engines alike, is in the functions it calls: the infinite bus
    (``_with_inertia``), the GENSAL (``_gensal_as_genrou``), the rate feedback
    of an ESAC1A beside the audited model (``_esac1a_without_rate_feedback``),
    a governor beside it (``_without_other_governors``), the TVC system's
    transformer ratio (``_tvc_ratio_on_winding_one``) and what an audit row's
    own function says (``_esst1a_dyr``, ``_exst1_dyr``, ``_write_rena_dyr``)."""
    folder = _psid_pkg_dir() / "test" / "benchmarks" / "psse" / audit.folder
    raw_source = folder / audit.raw
    dyr_source = folder / audit.dyr
    assert raw_source.is_file(), f"benchmark file missing: {raw_source}"
    assert dyr_source.is_file(), f"benchmark file missing: {dyr_source}"
    raw_name = f"{audit.audit_id}.raw"
    dyr_name = f"{audit.audit_id}.dyr"
    if audit.raw.startswith("TVC"):
        (workspace / raw_name).write_text(_tvc_ratio_on_winding_one(raw_source.read_text()))
    else:
        shutil.copyfile(raw_source, workspace / raw_name)
    if audit.audit_id == "esst1a":
        (workspace / dyr_name).write_text(_esst1a_dyr(dyr_source.read_text()))
    elif audit.audit_id == "exst1":
        (workspace / dyr_name).write_text(_exst1_dyr(dyr_source.read_text()))
    elif audit.audit_id == "renewable":
        _write_rena_dyr(dyr_source, workspace / dyr_name)
    else:
        shutil.copyfile(dyr_source, workspace / dyr_name)
    text = _gensal_as_genrou(_with_inertia((workspace / dyr_name).read_text()))
    if "ESAC1A" not in audit.models:
        text = _esac1a_without_rate_feedback(text)
    text = _without_other_governors(text, audit.models)
    (workspace / dyr_name).write_text(text)
    return {"primary_path": raw_name, "addfiles": [dyr_name]}


def _stream_andes(client: TestClient, sid: str, t_end: float) -> dict[str, Any]:
    """ANDES's run as a traces payload, streamed at ``_ANDES_STEP`` as
    test_engines_agree.py streams its run."""
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", "tf": t_end, "h": _ANDES_STEP}))
        start = json.loads(ws.receive_text())
        assert start["type"] == "stream_start", start
        names = start["metadata"]["var_columns"]
        times: list[float] = []
        rows: list[list[float]] = []
        while True:
            message = ws.receive()
            if message.get("text") is not None:
                done = json.loads(message["text"])
                assert done["type"] == "done" and done["converged"] is True, done
                break
            t, values = decode_batch(message["bytes"])
            times.extend(float(v) for v in t)
            rows.extend(values.tolist())
    return {
        "t": times,
        "variables": [
            {"name": name, "values": [row[i] for row in rows]} for i, name in enumerate(names)
        ],
        "truncated": False,
    }


def _convert(client: TestClient, sid: str, engine: str, kind: str, result: Any) -> dict[str, Any]:
    keys = _ok(client.get(f"/api/sessions/{sid}/keys"))["keys"]
    converted = _ok(
        client.post(
            "/api/results/convert",
            json={"kind": kind, "engine": engine, "result": result, "keys": keys},
        )
    )
    return converted["document"]  # type: ignore[no-any-return]


def _compare(client: TestClient, reference: dict[str, Any], comparison: dict[str, Any]) -> Any:
    return _ok(client.post("/api/compare", json={"reference": reference, "comparison": comparison}))


def _document_of(document: dict[str, Any], series: list[dict[str, Any]]) -> dict[str, Any]:
    """``document`` with its series replaced, its tables left out."""
    return {**document, "series": series, "tables": {}}


def _after(document: dict[str, Any], quantity: str, t0: float) -> dict[str, Any]:
    """The document's series of one quantity, from ``t0`` on."""
    series = []
    for s in document["series"]:
        if s["quantity"] != quantity:
            continue
        kept = [(t, y) for t, y in zip(s["t"], s["y"], strict=True) if t >= t0]
        series.append({**s, "t": [t for t, _ in kept], "y": [y for _, y in kept]})
    return _document_of(document, series)


def _rows(compared: dict[str, Any], quantity: str) -> list[dict[str, Any]]:
    rows = [row for row in compared["series"] if row["quantity"] == quantity]
    for row in rows:
        print(
            f"{quantity:12} {row['key']:22} max {row['max_diff']:.3e} at {row['max_diff_t']:.3f} s,"
            f" rms {row['rms_diff']:.3e}, swing {row['swing_ref']:.3e}"
        )
    return rows


def _electromechanical_pairs(compared_eig: dict[str, Any]) -> list[dict[str, Any]]:
    """The matched eigenvalue pairs of a POST /compare answer (its
    ``eigenvalues``) whose reference frequency is in the electromechanical
    band."""
    return [
        row
        for row in compared_eig["eigenvalues"]
        if _MODE_BAND_HZ[0] <= row["frequency_hz_ref"] <= _MODE_BAND_HZ[1]
    ]


def _unmatched_in_band(compared_eig: dict[str, Any], documents: dict[str, Any]) -> list[dict[str, Any]]:
    """The eigenvalues the comparison left unmatched, either side, whose
    frequency is in the electromechanical band. The answer gives their
    indices into each document's eig table."""
    out = []
    for field, engine in (
        ("unmatched_eigenvalues_reference", "andes"),
        ("unmatched_eigenvalues_comparison", "sienna"),
    ):
        table = documents[engine]["tables"]["eig"]["eigenvalues"]
        for index in compared_eig[field]:
            row = table[index]
            if _MODE_BAND_HZ[0] <= row["frequency_hz"] <= _MODE_BAND_HZ[1]:
                out.append({"engine": engine, **row})
    return out


@pytest.fixture(scope="module", params=sorted(_AUDIT_IDS), ids=sorted(_AUDIT_IDS))
def audit_run(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """One audit, run in both engines: the two results documents, the two eig
    documents, their comparisons and the client."""
    audit_id = str(request.param)
    audit = next(a for a in AUDITS if a.audit_id == audit_id)
    workspace = tmp_path_factory.mktemp(f"audit-{audit_id}") / "ws"
    workspace.mkdir(mode=0o700)
    case = _benchmark_files(audit, workspace)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
        # Each engine's session waits while the other runs (Sienna's Julia
        # starts and runs for minutes); the default 180 s could reap it.
        idle_timeout_seconds=3600.0,
    )
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        for engine in ("andes", "sienna"):
            created = client.post("/api/sessions", json={"engine": engine})
            assert created.status_code == 201, created.text
            sid = str(created.json()["session_id"])
            _ok(client.post(f"/api/sessions/{sid}/case", json=case))
            # Before the power flow: an ANDES System takes a disturbance only
            # before setup, which the power flow commits.
            _ok(
                client.post(
                    f"/api/sessions/{sid}/disturbances",
                    json={"disturbances": [_disturbance_for(client, sid, audit.disturbance)]},
                )
            )
            assert _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))["converged"] is True
            sessions[engine] = sid

        # The eigenvalues come before the runs. ANDES linearises the System it
        # holds, which after a run is the one at the run's end with the
        # disturbance in effect (on the GENROU benchmark, the network with
        # line 101-102 out: 1.1323 Hz, damping 0.0530, where the power-flow
        # point gives 1.3725 Hz, 0.0799); Sienna linearises a copy at the
        # power-flow point whatever ran before. Asked before the runs, both
        # describe the same system.
        eig_documents: dict[str, Any] = {}
        for engine in ("andes", "sienna"):
            eig = _ok(
                client.post(
                    f"/api/sessions/{sessions[engine]}/eig",
                    json={} if engine == "andes" else {"load_model": "impedance"},
                )
            )
            eig_documents[engine] = _convert(client, sessions[engine], engine, "eig", eig)

        andes_traces = _stream_andes(client, sessions["andes"], audit.t_end)
        sienna_run = _ok(
            client.post(
                f"/api/sessions/{sessions['sienna']}/tds",
                json={"tf": audit.t_end, "load_model": "impedance", "h": _SIENNA_STEP},
            )
        )
        assert sienna_run["converged"] is True

        documents = {
            "andes": _convert(client, sessions["andes"], "andes", "tds", andes_traces),
            "sienna": _convert(client, sessions["sienna"], "sienna", "tds", sienna_run["traces"]),
        }
        compared = _compare(client, documents["andes"], documents["sienna"])
        compared_eig = _compare(client, eig_documents["andes"], eig_documents["sienna"])
        yield {
            "audit": audit,
            "documents": documents,
            "eig_documents": eig_documents,
            "compare": compared,
            "compare_eig": compared_eig,
            "client": client,
        }


def _expectation(audit: Audit) -> str:
    kind, _, detail = audit.expect.partition(":")
    assert kind in ("agree", "differ", "refused"), audit.expect
    if kind == "agree":
        assert not detail, audit.expect
    else:
        assert detail, audit.expect
    return kind


def test_audit_rotor_speeds(audit_run: dict[str, Any]) -> None:
    """Each rotor-speed row is held to the audit's absolute bound and to its
    fraction of the swing, as test_engines_agree.py holds the GENROU case."""
    audit: Audit = audit_run["audit"]
    if _expectation(audit) == "refused":
        pytest.fail(f"audit {audit.audit_id} is refused: {audit.expect}")
    rotor_speed_max, rotor_speed_rel = audit.bounds[0], audit.bounds[1]
    rows = _rows(audit_run["compare"], "rotor_speed")
    # Every machine of the case: the audited one and the machine of large
    # inertia that stands for the benchmark's infinite bus (_with_inertia),
    # whose speed hardly moves and is held to the same bounds.
    assert rows, f"no rotor speed compared for {audit.audit_id}"
    for row in rows:
        assert row["swing_ref"] > 0.0, row
        assert row["max_diff"] <= rotor_speed_max, row
        assert row["max_diff"] <= rotor_speed_rel * row["swing_ref"], row


def test_audit_voltages(audit_run: dict[str, Any]) -> None:
    """Where the engines agree, the whole run's largest voltage difference is
    at the disturbance instant (the engines record either side of the step);
    a known difference can put it anywhere. The comparison from 0.1 s after
    the disturbance on is held to the audit's bounds."""
    audit: Audit = audit_run["audit"]
    kind = _expectation(audit)
    if kind == "refused":
        pytest.fail(f"audit {audit.audit_id} is refused: {audit.expect}")
    client: TestClient = audit_run["client"]
    docs = audit_run["documents"]
    t_event = float(audit.disturbance["t"])
    for row in _rows(audit_run["compare"], "voltage"):
        if kind == "agree":
            assert row["max_diff_t"] == pytest.approx(t_event, abs=1e-6), row
    t0 = t_event + 0.1
    after = _compare(client, _after(docs["andes"], "voltage", t0), _after(docs["sienna"], "voltage", t0))
    rows = _rows(after, "voltage")
    # Three buses in the three-bus benchmarks, four in the TVC system.
    assert len(rows) == (4 if audit.raw.startswith("TVC") else 3)
    voltage_max, voltage_rms = audit.bounds[2], audit.bounds[3]
    for row in rows:
        assert row["max_diff"] <= voltage_max, row
        assert row["rms_diff"] <= voltage_rms, row


def test_audit_bus_count(audit_run: dict[str, Any]) -> None:
    """Every bus of the benchmark is compared: three in the three-bus cases,
    four in the TVC system cases."""
    audit: Audit = audit_run["audit"]
    expected = 4 if audit.raw.startswith("TVC") else 3
    assert len(_rows(audit_run["compare"], "voltage")) == expected


def test_audit_modes(audit_run: dict[str, Any]) -> None:
    """The electromechanical modes of the two engines' eigenvalue answers.

    An ``agree`` audit holds every matched pair in the band to the audit's
    frequency and damping bounds and allows no unmatched mode in the band on
    either side. A ``differ:`` audit asserts the opposite shape its entry
    predicts: at least one mode in the band differs by more than four
    significant digits (a matched pair, or a mode one engine has and the
    other does not), the matched frequencies stay within the row's frequency
    bound where it gives one, and test_known_differences.py covers the
    difference."""
    audit: Audit = audit_run["audit"]
    kind = _expectation(audit)
    if kind == "refused":
        pytest.fail(f"audit {audit.audit_id} is refused: {audit.expect}")
    compared_eig = audit_run["compare_eig"]
    for engine, document in audit_run["eig_documents"].items():
        modes = sorted(
            (round(r["frequency_hz"], 5), round(r["damping_ratio"], 5))
            for r in document["tables"]["eig"]["eigenvalues"]
            if r["frequency_hz"] > 0.0
        )
        print(f"modes {engine:8} {modes}")
    if audit.audit_id in _NO_ELECTROMECHANICAL_MODE:
        # The converter chain's case: its one machine is the infinite bus's
        # stand-in, so neither engine has an electromechanical mode, and what
        # falls in the band by frequency is the converter's own pair, damped
        # almost critically (ANDES -50.0 +/- 4.40j, zeta 0.996; Sienna
        # -45.2 +/- 8.70j, zeta 0.982). The two pairs differ and why is not
        # known, so the chain is not recorded as audited (test_model_audits_table
        # lists it as unresolved); this holds that there is no lightly damped
        # mode on either side, which is the account the table gives.
        for engine, document in audit_run["eig_documents"].items():
            in_band = [
                r
                for r in document["tables"]["eig"]["eigenvalues"]
                if _MODE_BAND_HZ[0] <= r["frequency_hz"] <= _MODE_BAND_HZ[1]
            ]
            assert all(r["damping_ratio"] > 0.9 for r in in_band), (engine, in_band)
        return
    pairs = _electromechanical_pairs(compared_eig)
    assert pairs, f"no electromechanical modes compared for {audit.audit_id}"
    for row in pairs:
        print(
            f"mode {row['frequency_hz_ref']:.5f} Hz: frequency diff "
            f"{abs(row['frequency_hz_new'] - row['frequency_hz_ref']):.3e} Hz, damping diff "
            f"{abs(row['damping_ratio_new'] - row['damping_ratio_ref']):.3e}"
        )
    unmatched = _unmatched_in_band(compared_eig, audit_run["eig_documents"])
    freq_hz, damping = audit.bounds[4], audit.bounds[5]
    if kind == "differ" and _entry_of(audit).small_signal:
        four_digit_breaks = [
            row
            for row in pairs
            if abs(row["damping_ratio_new"] - row["damping_ratio_ref"])
            > _FOUR_DIGITS * max(abs(row["damping_ratio_ref"]), 1e-12)
            or abs(row["frequency_hz_new"] - row["frequency_hz_ref"])
            > _FOUR_DIGITS * max(abs(row["frequency_hz_ref"]), 1e-12)
        ]
        assert four_digit_breaks or unmatched, (
            f"{audit.expect} predicts a mode that differs beyond four digits; "
            "test_known_differences.py covers it"
        )
        if freq_hz is not None:
            for row in pairs:
                assert abs(row["frequency_hz_new"] - row["frequency_hz_ref"]) <= freq_hz, row
        return
    # An agreement, or a known difference the modes do not see (its entry
    # says it is not small-signal): every mode in the band matches.
    assert freq_hz is not None, audit.audit_id
    assert unmatched == []
    for row in pairs:
        assert abs(row["frequency_hz_new"] - row["frequency_hz_ref"]) <= freq_hz, row
        if damping is not None:
            assert abs(row["damping_ratio_new"] - row["damping_ratio_ref"]) <= damping, row


def _entry_of(audit: Audit) -> Any:
    """The known-difference register entry a ``differ:`` row names."""
    from tensa.engines.fidelity import KNOWN_DIFFERENCES

    entry_id = audit.expect.split(":", 1)[1]
    return next(entry for entry in KNOWN_DIFFERENCES if entry.id == entry_id)


def test_audit_expectation_registered(audit_run: dict[str, Any]) -> None:
    """The row's expectation has a valid form, and a ``differ:`` id is in the
    known-difference register (the unit test holds the whole table to the
    register; this pins the one row that ran)."""
    audit: Audit = audit_run["audit"]
    kind = _expectation(audit)
    if kind == "differ":
        from tensa.engines.fidelity import KNOWN_DIFFERENCES

        entry_id = audit.expect.split(":", 1)[1]
        assert any(entry.id == entry_id for entry in KNOWN_DIFFERENCES), audit.expect
