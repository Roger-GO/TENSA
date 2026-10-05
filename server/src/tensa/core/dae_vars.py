"""The ANDES variables a time-domain run can record, beyond the five streamed groups.

ANDES names every differential (``dae.x_name``) and algebraic (``dae.y_name``)
variable of the loaded models ``<variable> <Model> <idx>``: ``omega GENROU 1``,
``vf GENROU 2``, ``v EXST1 1``. :func:`dae_variables` lists them from the models'
own definitions, so the list is there as soon as a case is loaded: ANDES fills
``dae.x_name`` only when the first time-domain step is set up, after which
disturbances can no longer be added. A run names the ones it wants in
``dae_vars`` (see :func:`resolve_dae_vars`), and the stream gives each one a
column named exactly that (see ``tensa.core.stream``).

One thing keeps the list from being the models' definitions as they stand: a
static generator that a dynamic one replaces (a ``PV`` or ``Slack`` with a
``GENROU`` on its bus) loses its algebraic variables when ANDES sets up the
time-domain run, and the run reads nothing there. :func:`dae_variables` leaves
them out, deciding as ANDES's ``DAECompactor`` does (contract 9 in
``server/ANDES_VERSIONS.md``).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from tensa.core.errors import TdsRequestError, short_repr

if TYPE_CHECKING:
    from andes.system import System

# The most variables one run records. A column costs 8 bytes a row in a stream
# frame and the browser keeps every column of every retained run in memory.
MAX_DAE_VARS = 1000

DaeKind = Literal["x", "y"]


@dataclass(frozen=True)
class DaeVariable:
    """One variable of one device, as ANDES lists it in ``dae.x_name`` / ``dae.y_name``."""

    #: ``"<variable> <Model> <idx>"`` with ANDES's own spelling, the key a run is asked for it by.
    name: str
    #: ``"x"`` for a state (it has a differential equation), ``"y"`` for an algebraic variable.
    kind: DaeKind
    model: str
    var: str
    idx: int | str
    #: ANDES's own unit and description of the variable; ``None`` where it gives none.
    unit: str | None = None
    info: str | None = None


def dae_var_name(model: str, var: str, idx: int | str) -> str:
    """The name ANDES gives variable ``var`` of device ``idx`` of ``model``.

    Mirrors ``andes.system.helpers._set_xy_name``: the model name is not repeated
    when a string idx already holds it, and underscores become spaces.
    """
    label = idx if isinstance(idx, str) and model in idx else f"{model} {idx}"
    return f"{var} {str(label).replace('_', ' ')}"


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _replaced_devices(system: System) -> dict[str, set[int]]:
    """``{model name: {uid, ...}}`` of the static devices an online dynamic one replaces.

    What ``DAECompactor._detect_replaced_devices`` finds when ANDES sets up the
    time-domain run, found without changing anything: a dynamic model's
    ``IdxParam`` flagged ``replaces`` names the static device it stands in for,
    and only an online device (``u == 1``) replaces.
    """
    replaced: dict[str, set[int]] = {}
    for model in system.find_models("tds").values():
        online = getattr(model, "u", None)
        for param in model.idx_params.values():
            if not getattr(param, "replaces", False):
                continue
            group = system.groups[param.model]
            for position in range(model.n):
                if online is not None and online.v[position] != 1:
                    continue
                target = param.v[position]
                if target is None:
                    continue
                try:
                    target_model = group.idx2model(target)
                    uid = target_model.idx2uid(target)
                except (KeyError, IndexError):
                    continue
                replaced.setdefault(target_model.class_name, set()).add(int(uid))
    return replaced


def dae_variables(system: System, *, include_replaced: bool = False) -> list[DaeVariable]:
    """Every state and algebraic variable of the loaded models' devices.

    In the order of the models, each model's states before its algebraic
    variables, then variable by variable over the devices in idx order. Needs no
    ``setup()``. ``include_replaced`` keeps the algebraic variables of replaced
    static devices (see the module docstring), which :func:`resolve_dae_vars`
    asks for to tell a client why such a name is refused.
    """
    replaced = {} if include_replaced else _replaced_devices(system)
    out: list[DaeVariable] = []
    seen: set[str] = set()
    for model_name, model in system.find_models(("pflow", "tds")).items():
        idx_values = list(model.idx.v)
        skip = replaced.get(model_name, set())
        for kind, variables in (("x", model.states), ("y", model.algebs)):
            for var_name, var in variables.items():
                unit = _text(getattr(var, "unit", None))
                info = _text(getattr(var, "info", None))
                for uid, idx in enumerate(idx_values):
                    if kind == "y" and uid in skip:
                        continue
                    name = dae_var_name(model_name, var_name, idx)
                    if name in seen:
                        continue
                    seen.add(name)
                    out.append(
                        DaeVariable(
                            name=name,
                            kind=kind,  # type: ignore[arg-type]
                            model=model_name,
                            var=var_name,
                            idx=idx,
                            unit=unit,
                            info=info,
                        )
                    )
    return out


def search_dae_variables(
    variables: Iterable[DaeVariable],
    *,
    query: str | None = None,
    kind: DaeKind | None = None,
    model: str | None = None,
) -> list[DaeVariable]:
    """The variables that match every filter given, in their own order.

    ``query`` is split on whitespace and every word must appear in the name,
    whatever its case (``omega gen`` finds ``omega GENROU 1``). ``model`` is a
    model name and matches it exactly, whatever its case.
    """
    words = (query or "").lower().split()
    wanted_model = model.lower() if model else None
    out: list[DaeVariable] = []
    for variable in variables:
        if kind is not None and variable.kind != kind:
            continue
        if wanted_model is not None and variable.model.lower() != wanted_model:
            continue
        if words:
            lowered = variable.name.lower()
            if not all(word in lowered for word in words):
                continue
        out.append(variable)
    return out


def resolve_dae_vars(system: System, names: Sequence[str]) -> list[DaeVariable]:
    """The variables a run asked for by ``names``, each once, in the order asked.

    A name appearing twice counts once. Raises :class:`TdsRequestError`, before
    anything has been written to the System, for more than :data:`MAX_DAE_VARS`
    names and for any name that is not a variable of the loaded case, saying so
    and, for the algebraic variables of a replaced static device, why.
    """
    unique = list(dict.fromkeys(names))
    if len(unique) > MAX_DAE_VARS:
        raise TdsRequestError(
            f"'dae_vars' names {len(unique)} variables; a run records at most {MAX_DAE_VARS}"
        )
    known = {variable.name: variable for variable in dae_variables(system)}
    missing = [name for name in unique if name not in known]
    if missing:
        every = {variable.name for variable in dae_variables(system, include_replaced=True)}
        replaced = [name for name in missing if name in every]
        unknown = [name for name in missing if name not in every]
        parts: list[str] = []
        if unknown:
            parts.append(
                f"{short_repr(unknown, 80)} {'is' if len(unknown) == 1 else 'are'} not "
                "ANDES variable(s) of the loaded case; list them with "
                "GET /sessions/{id}/dae-variables"
            )
        if replaced:
            parts.append(
                f"{short_repr(replaced, 80)} belong(s) to a static device that a dynamic "
                "one replaces, so the simulation has no such variable"
            )
        raise TdsRequestError("; ".join(parts))
    return [known[name] for name in unique]


def as_dict(variable: DaeVariable) -> dict[str, Any]:
    """``variable`` as the plain dict that crosses the worker's pipe."""
    return {
        "name": variable.name,
        "kind": variable.kind,
        "model": variable.model,
        "var": variable.var,
        "idx": variable.idx,
        "unit": variable.unit,
        "info": variable.info,
    }


__all__ = [
    "MAX_DAE_VARS",
    "DaeKind",
    "DaeVariable",
    "as_dict",
    "dae_var_name",
    "dae_variables",
    "resolve_dae_vars",
    "search_dae_variables",
]
