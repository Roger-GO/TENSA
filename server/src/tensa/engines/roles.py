"""The role of a PSS/E dynamic model name, shared by every engine's adapter.

A dynamic model is a machine, an exciter, a governor, a stabiliser or a renewable
plant controller; anything else is ``other``. The tables are checked before the
prefix rule, so a table name that starts with ``RE`` or ``WT`` keeps its role.
"""

from __future__ import annotations

ROLES: tuple[str, ...] = ("machine", "exciter", "governor", "pss", "renewable", "other")

_MACHINES = frozenset({"GENROU", "GENCLS", "GENSAL", "GENSAE", "GENROE"})

_EXCITERS = frozenset(
    {
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
    }
)

_GOVERNORS = frozenset(
    {
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
    }
)

_PSSES = frozenset({"IEEEST", "STAB1", "ST2CUT", "PSS2A", "PSS2B", "PSS2C"})

_RENEWABLES = frozenset({"REGCA1", "REECB1", "REPCA1", "REECA1", "DERA1"})

_TABLES: tuple[tuple[frozenset[str], str], ...] = (
    (_MACHINES, "machine"),
    (_EXCITERS, "exciter"),
    (_GOVERNORS, "governor"),
    (_PSSES, "pss"),
    (_RENEWABLES, "renewable"),
)


def role_of_model(model: str) -> str:
    """The role of the dynamic model ``model``, one of :data:`ROLES`."""
    name = model.strip().upper()
    for table, role in _TABLES:
        if name in table:
            return role
    if name.startswith(("RE", "WT")):
        return "renewable"
    return "other"
