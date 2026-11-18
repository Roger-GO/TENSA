"""Every machine control an example case carries is one its topology lists.

The Governors and Exciters tabs and the badges of the diagram are built from the topology's
``controllers``, which holds the models ``_CONTROLLER_MODEL_NAMES`` names and nothing else. A
case that uses an exciter, a governor or a stabiliser outside that list has machines the
diagram shows with no control, and a catalog entry that counts them (a governor on every
machine) says what the app does not show. So each case the catalog ships is opened and every
device of an exciter, turbine governor or power system stabiliser model it holds is looked for
in the topology it gives. So is every model of a renewable plant, from the converter down to
the pitch and torque control of a wind turbine: a case that says it has a wind turbine must
show one.
"""

from __future__ import annotations

from collections import Counter

import pytest

from tensa.core.example_catalog import Example, bundled_cases_dir, load_catalog
from tensa.core.examples import _andes_cases_dir
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

# The ANDES groups of the controls of a machine, and of a renewable plant (the converter, its
# electrical and plant control, and a wind turbine's drive train, aerodynamics, pitch and
# torque control). Measurements (BusFreq), calculations (ACEc), events (Toggle) and the
# machines themselves (GENROU, GENCLS: the topology's generators) are not controls and are
# not drawn as badges.
MACHINE_CONTROL_GROUPS = (
    "Exciter",
    "TurbineGov",
    "PSS",
    "RenGen",
    "RenExciter",
    "RenPlant",
    "RenGovernor",
    "RenAerodynamics",
    "RenPitch",
    "RenTorque",
)


def _files() -> list[tuple[str, Example]]:
    catalog = load_catalog()
    return [
        (example.id, example)
        for example in catalog.examples
        if example.provenance.kind in ("andes", "bundled") and example.files()
    ]


@pytest.mark.parametrize(("case_id", "example"), _files(), ids=[i for i, _ in _files()])
def test_every_machine_and_plant_control_of_the_case_is_in_its_topology(
    case_id: str, example: Example
) -> None:
    pytest.importorskip("andes")
    source = _andes_cases_dir() if example.provenance.kind == "andes" else bundled_cases_dir()
    assert source is not None
    wrapper = Wrapper()
    topology = wrapper.load_case(source / example.files()[0].path)
    ss = wrapper._ss
    assert ss is not None

    held = Counter(
        {
            name: model.n
            for name, model in ss.models.items()
            if model.n and model.group in MACHINE_CONTROL_GROUPS
        }
    )
    listed = Counter(entry.kind for entry in topology.controllers)
    assert {name: listed.get(name, 0) for name in held} == dict(held), case_id
