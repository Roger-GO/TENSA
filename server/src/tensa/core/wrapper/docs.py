"""ANDES's own documentation of its models, and the list of the models it ships.

ANDES can print, for any model it ships, the documentation of that model: its
parameters, variables and equations (``andes doc <model>``, which calls
``System.<model>.doc()``). This module answers that text and the list of the
models, grouped as ANDES groups them.

Both read a fresh, empty ``andes.System()`` built for the call, as ``andes doc``
does, never the session's own System: they need no loaded case, and a call
observes and changes nothing of the session (no setup, no edit, no disturbance
closed off). ``setup()`` is not called on that System, and nothing is kept
from one call to the next. A fresh System takes well under a second in a
worker that has ANDES imported. There is no per-run setting here, so the
put-back rule of ``core/pflow_options.py`` does not apply.

They run in the worker only: the server process does not import ANDES.

The list is read off ``System.groups`` (``System.supported_models()`` answers a
printed table, not data). ANDES 2.0.0 registers a deprecated group under a
second name as the same object (``ACTopology`` for ``ACNode``), which would list
``Bus`` twice, so a group is listed under its own ``class_name`` only; a group
with no models (``Experimental``, ``Undefined``) is left out. A name is checked
against that list before anything is looked up on the System, and the model is
then taken from ``System.models`` by that name: a name such as ``config``,
``PFlow``, ``dae`` or ``__class__`` is no model and reaches no attribute.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from tensa.core.errors import ModelDocError, ModelDocUnavailableError
from tensa.core.wrapper.base import WrapperBase

if TYPE_CHECKING:
    from andes.system import System


def _fresh_system() -> System:
    """A fresh, empty ``andes.System``, as ``andes doc`` builds one."""
    from andes.system import System

    return System()


def _grouped_models(system: Any) -> dict[str, list[str]]:
    """The model class names of ``system`` by group, in ANDES's own order.

    A group registered under a name that is not its own (a deprecated alias) is
    skipped, and so is a group with no models.
    """
    groups: dict[str, list[str]] = {}
    for name, group in system.groups.items():
        if getattr(group, "class_name", name) != name:
            continue
        models = [str(model) for model in group.models]
        if models:
            groups[str(name)] = models
    return groups


class DocsMixin(WrapperBase):
    """The models ANDES ships and the documentation it prints for each."""

    def supported_models(self) -> dict[str, list[str]]:
        """Every model ANDES ships, as ``{group: [model, ...]}``.

        A plain dict of lists of str, read off a fresh System; the session's
        case is not touched and none is needed.
        """
        return _grouped_models(_fresh_system())

    def model_doc(self, model: str) -> str:
        """ANDES's documentation text for ``model``, as ``doc()`` returns it.

        The plain-text form ANDES prints (``export="plain"``, 78 columns): a
        heading naming the model and its group, the description, then tables
        of the parameters, the variables, the equations and the services, as
        the model has them. Nothing is reformatted.

        Raises ``ModelDocError`` for a name that is not in
        :meth:`supported_models`, checked before anything is read off the
        System, and ``ModelDocUnavailableError`` when ANDES fails to write the
        documentation of a model it lists.
        """
        system = _fresh_system()
        known = {name for names in _grouped_models(system).values() for name in names}
        if model not in known:
            raise ModelDocError(f"unknown ANDES model {model!r}")
        target = system.models[model]
        try:
            text = target.doc()
        except Exception as exc:  # noqa: BLE001 - any failure of ANDES's documenter
            raise ModelDocUnavailableError(
                f"ANDES could not write the documentation of {model!r}: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        return str(text)
