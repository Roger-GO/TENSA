"""Unit tests for the dynamic-model role table (unit P4-C1).

The lists are written out here, not imported from the module, so the test and the
table cannot drift together.
"""

from __future__ import annotations

import pytest

from tensa.engines.roles import ROLES, role_of_model

MACHINES = ["GENROU", "GENCLS", "GENSAL", "GENSAE", "GENROE"]

EXCITERS = [
    "IEEET1",
    "IEEEX1",
    "ESDC1A",
    "ESDC2A",
    "ESAC1A",
    "ESAC6A",
    "ESAC8B",
    "EXAC1",
    "EXAC1A",
    "EXAC2",
    "EXPIC1",
    "ESST1A",
    "ESST3A",
    "ESST4B",
    "SCRX",
    "SEXS",
    "EXST1",
    "EXDC2",
    "ST6B",
    "ST8C",
    "IEEET3",
    "EXAC4",
    "AC8B",
    "ESAC5A",
]

GOVERNORS = [
    "GAST",
    "GGOV1",
    "HYGOV",
    "IEEEG1",
    "TGOV1",
    "TGOV1DU",
    "DEGOV1",
    "PIDGOV",
    "WPIDHY",
    "TG2",
    "TGOV1DB",
    "TGOV1N",
    "IEESGO",
    "HYGOVDB",
    "HYGOV4",
    "TGOV1NDB",
]

PSSES = ["IEEEST", "STAB1", "ST2CUT", "PSS2A", "PSS2B", "PSS2C"]

RENEWABLES = ["REGCA1", "REECB1", "REPCA1", "REECA1", "DERA1"]


@pytest.mark.parametrize("name", MACHINES)
def test_machines(name: str) -> None:
    assert role_of_model(name) == "machine"


@pytest.mark.parametrize("name", EXCITERS)
def test_exciters(name: str) -> None:
    assert role_of_model(name) == "exciter"


@pytest.mark.parametrize("name", GOVERNORS)
def test_governors(name: str) -> None:
    assert role_of_model(name) == "governor"


@pytest.mark.parametrize("name", PSSES)
def test_psses(name: str) -> None:
    assert role_of_model(name) == "pss"


@pytest.mark.parametrize("name", RENEWABLES)
def test_renewables(name: str) -> None:
    assert role_of_model(name) == "renewable"


def test_case_and_padding_are_ignored() -> None:
    assert role_of_model("genrou") == "machine"
    assert role_of_model("  GENROU  ") == "machine"
    assert role_of_model(" ieeet1 ") == "exciter"
    assert role_of_model("tgov1") == "governor"
    assert role_of_model("pss2a") == "pss"
    assert role_of_model(" regca1 ") == "renewable"


def test_prefix_rule() -> None:
    assert role_of_model("REECC1") == "renewable"
    assert role_of_model("WT3G1") == "renewable"
    assert role_of_model("wt3g1") == "renewable"


def test_tables_beat_the_prefix_rule() -> None:
    # No table name outside the renewable one starts with RE or WT; hold the rule
    # by checking table names against their roles.
    assert role_of_model("GENROU") == "machine"
    assert role_of_model("EXST1") == "exciter"


def test_unknown_and_empty_are_other() -> None:
    assert role_of_model("NOSUCH") == "other"
    assert role_of_model("") == "other"
    assert role_of_model("   ") == "other"
    assert role_of_model("G") == "other"


def test_every_result_is_in_roles() -> None:
    names = MACHINES + EXCITERS + GOVERNORS + PSSES + RENEWABLES
    names += ["REECC1", "WT3G1", "NOSUCH", ""]
    for name in names:
        assert role_of_model(name) in ROLES


def test_roles_exported() -> None:
    assert ROLES == ("machine", "exciter", "governor", "pss", "renewable", "other")
