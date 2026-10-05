"""What a converged power flow did that ANDES does not say.

Two things change a power-flow solution and leave ANDES's log silent (contract 10
in ``server/ANDES_VERSIONS.md``). With reactive-power limits enforced, a PV or
Slack generator whose reactive output reaches ``qmin`` or ``qmax`` is switched to a
PQ bus and held there. A PQ load whose bus voltage leaves the load's ``vmin`` to
``vmax`` range (0.8 to 1.2 pu unless the case says otherwise) is turned into a
constant impedance, so it draws less than its set-point and the solution differs
from the one the user asked for (ANDES's ``pq2z`` setting, on by default). The only
record of either is the flags the limiters keep (contract 8): ``qlim.zl`` and
``qlim.zu`` on the generators, ``vcmp.zl`` and ``vcmp.zu`` on the loads.

After an explicit power flow the worker reads those flags and says what it finds
through the ``tensa.notice`` logger, which the message capture listens to beside
``andes``, so both show in the Messages tab as warnings. A run that did not
converge says nothing here: its limiters are cleared, and ANDES reports the failure.
The power flow a time-domain run starts for itself, and one a snapshot restore runs,
are not read: the user asked for neither.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal

from tensa.core.messages import NOTICE_LOGGER

log = logging.getLogger(NOTICE_LOGGER)

# A notice names this many devices and counts the rest; a case with hundreds of
# loads past their limits is not helped by a message that lists them all.
MAX_NAMED = 8

# A limiter flag is 0.0 or 1.0; anything above this counts as set.
_SET = 0.5


@dataclass(frozen=True)
class QLimitHit:
    """A generator held at a reactive limit."""

    model: str
    idx: Any
    limit: Literal["qmin", "qmax"]


@dataclass(frozen=True)
class ImpedanceLoad:
    """A load treated as a constant impedance, with the voltage that made it one."""

    idx: Any
    voltage: float
    side: Literal["below", "above"]
    limit: float


def _in_service(model: Any, i: int) -> bool:
    u = getattr(getattr(model, "u", None), "v", None)
    return True if u is None else bool(float(u[i]) > _SET)


def q_limit_hits(ss: Any) -> list[QLimitHit]:
    """The in-service PV and Slack generators the last power flow held at a limit."""
    hits: list[QLimitHit] = []
    for model_name in ("PV", "Slack"):
        model = getattr(ss, model_name, None)
        limiter = getattr(model, "qlim", None)
        zl, zu = getattr(limiter, "zl", None), getattr(limiter, "zu", None)
        idx = getattr(getattr(model, "idx", None), "v", None)
        if model is None or zl is None or zu is None or idx is None:
            continue
        for i, device in enumerate(idx):
            if not _in_service(model, i):
                continue
            if float(zu[i]) > _SET:
                hits.append(QLimitHit(model_name, device, "qmax"))
            elif float(zl[i]) > _SET:
                hits.append(QLimitHit(model_name, device, "qmin"))
    return hits


def impedance_loads(ss: Any) -> list[ImpedanceLoad]:
    """The in-service loads the last power flow turned into constant impedances."""
    pq = getattr(ss, "PQ", None)
    vcmp = getattr(pq, "vcmp", None)
    zl, zu = getattr(vcmp, "zl", None), getattr(vcmp, "zu", None)
    idx = getattr(getattr(pq, "idx", None), "v", None)
    voltage = getattr(getattr(pq, "v", None), "v", None)
    vmin = getattr(getattr(pq, "vmin", None), "v", None)
    vmax = getattr(getattr(pq, "vmax", None), "v", None)
    if pq is None or zl is None or zu is None or idx is None or voltage is None:
        return []
    found: list[ImpedanceLoad] = []
    for i, device in enumerate(idx):
        if not _in_service(pq, i):
            continue
        if float(zl[i]) > _SET and vmin is not None:
            found.append(ImpedanceLoad(device, float(voltage[i]), "below", float(vmin[i])))
        elif float(zu[i]) > _SET and vmax is not None:
            found.append(ImpedanceLoad(device, float(voltage[i]), "above", float(vmax[i])))
    return found


def _named(items: list[str]) -> str:
    shown = ", ".join(items[:MAX_NAMED])
    more = len(items) - MAX_NAMED
    return shown if more <= 0 else f"{shown} and {more} more"


def q_limit_message(hits: list[QLimitHit]) -> str | None:
    """The sentence for the generators held at a limit, or ``None`` when none were."""
    if not hits:
        return None
    n = len(hits)
    held = _named([f"{h.model} {h.idx} at {h.limit}" for h in hits])
    return (
        f"Reactive limits: {n} generator{'s were' if n != 1 else ' was'} switched from PV to PQ "
        f"and held at a limit, so the voltage there is no longer held ({held})."
    )


def impedance_message(loads: list[ImpedanceLoad]) -> str | None:
    """The sentence for the loads turned into impedances, or ``None`` when none were."""
    if not loads:
        return None
    n = len(loads)
    named = _named([f"{x.idx} at {x.voltage:.3f} pu, {x.side} {x.limit:g}" for x in loads])
    return (
        f"{n} load{'s are' if n != 1 else ' is'} treated as constant impedance, not constant "
        f"power, because the voltage at {'their bus' if n != 1 else 'its bus'} is outside "
        f"the load's vmin and vmax, so {'they draw' if n != 1 else 'it draws'} less than "
        f"the set-point (ANDES's pq2z setting): {named}."
    )


def log_pflow_notices(ss: Any) -> None:
    """Say what the converged power flow just solved did to generators and loads.

    Reads the limiter flags of ``ss`` and logs a warning for each of the two
    effects it finds. Never raises: a notice is an extra, and the power flow it
    follows has already succeeded.
    """
    try:
        for text in (q_limit_message(q_limit_hits(ss)), impedance_message(impedance_loads(ss))):
            if text is not None:
                log.warning(text)
    except Exception:  # noqa: BLE001 - a notice must never fail the power flow
        logging.getLogger("tensa.pflow_notices").debug("could not read the limiter flags", exc_info=True)
