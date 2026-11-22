"""Write the reference fixtures the Sienna engine's Julia tests compare against.

For each PSS/E case ANDES ships, the fixture holds what does not depend on an engine
(the identity of the case file, from ``tensa.engines.identity``) and what the reference
engine computes (ANDES's power flow: voltage magnitude and angle at every bus). The
Julia tests in ``server/tests/julia`` load the same file with Sienna and must find the
same elements and the same solution.

The fixture also holds the voltage setpoint of every bus a generator regulates (the
generator's own ``VS``, which ANDES keeps as ``v0`` of its PV and Slack models).
PowerSystems.jl has no field for ``VS`` and takes the bus record's stored ``VM`` as the
setpoint instead, so the Julia tests hand these values to the Sienna adapter to solve
the same power flow ANDES does.

The fixture also holds, for every transformer, the ratio and phase shift the file gives,
and for every other branch its total line charging. PowerSystems.jl's reader departs
from the file on these (it snaps a ratio to the tap grid, and it keeps half the charging
of a branch between two voltage levels when it makes a transformer of it), so the Julia
tests hand these values to the Sienna adapter as well.

    python scripts/make_sienna_fixtures.py [out_dir]

The cases are read from the ANDES installation (``andes/cases``), so the fixtures name
them by their path there and carry no copy of the data. Regenerate after an ANDES
upgrade; the ANDES version is recorded in each fixture.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import andes

from tensa.engines.identity import CaseIdentity, read_identity

REPO = Path(__file__).resolve().parent.parent
CASES = Path(andes.__file__).resolve().parent / "cases"

# (fixture name, raw file, dyr file or None)
RUNS: list[tuple[str, str, str | None]] = [
    ("kundur", "kundur/kundur.raw", "kundur/kundur_full.dyr"),
    ("ieee14", "ieee14/ieee14.raw", "ieee14/ieee14.dyr"),
    ("ieee39", "ieee39/ieee39.raw", None),
    ("wscc9", "wscc9/wscc9.raw", None),
    ("npcc", "npcc/npcc.raw", "npcc/npcc_full.dyr"),
    ("wecc", "wecc/wecc.raw", "wecc/wecc_full.dyr"),
]


def dyr_models(path: Path) -> list[list[object]]:
    """The records of a .dyr file as [bus, model, id], skipping records that do not
    start with a bus number (ANDES accepts event records such as Toggle there)."""
    out: list[list[object]] = []
    for record in path.read_text(encoding="utf-8", errors="replace").split("/"):
        tokens = record.replace(",", " ").replace("'", " ").split()
        if len(tokens) < 3 or not tokens[0].lstrip("-").isdigit():
            continue
        out.append([int(tokens[0]), tokens[1], tokens[2]])
    return out


def v_setpoints(ss: andes.system.System, name: str) -> dict[str, float]:
    """The voltage setpoint of every bus an in-service PV or Slack generator regulates,
    keyed by bus number. Two generators on one bus that ask for different voltages stop
    the script, since there is no one setpoint to hand on."""
    out: dict[str, float] = {}
    for model in (ss.PV, ss.Slack):
        for bus, v0, u in zip(model.bus.v, model.v0.v, model.u.v, strict=True):
            if float(u) != 1.0:
                continue
            key = str(int(bus))
            value = float(v0)
            if key in out and abs(out[key] - value) > 1e-9:
                raise SystemExit(
                    f"{name}: bus {key} has in-service generators with different voltage "
                    f"setpoints ({out[key]} and {value})"
                )
            out[key] = value
    return out


def corrections(ss: andes.system.System, identity: CaseIdentity, name: str) -> dict[str, list[list[object]]]:
    """The file's ratio and phase shift of every two-winding transformer, as
    [from_bus, to_bus, ckt, tap, shift_rad], and the file's total line charging of every
    other branch, as [from_bus, to_bus, ckt, b_total], both in the identity's order.

    ANDES keeps a PSS/E file's branches in the identity's order and holds no circuit id,
    so ANDES line i is identity branch i. The script checks the bus pair of each and
    stops where the two differ, or where ANDES holds a branch the other way round."""
    branches = identity.branches
    if ss.Line.n < len(branches):
        raise SystemExit(f"{name}: ANDES holds {ss.Line.n} lines, the file has {len(branches)} branches")
    transformers: list[list[object]] = []
    line_charging: list[list[object]] = []
    for i, branch in enumerate(branches):
        bus1, bus2 = int(ss.Line.bus1.v[i]), int(ss.Line.bus2.v[i])
        if {bus1, bus2} != {branch.from_bus, branch.to_bus}:
            raise SystemExit(
                f"{name}: ANDES line {i} joins buses {bus1} and {bus2}, the file's branch {i} "
                f"joins {branch.from_bus} and {branch.to_bus}"
            )
        if (bus1, bus2) != (branch.from_bus, branch.to_bus):
            raise SystemExit(
                f"{name}: ANDES holds branch {i} ({branch.from_bus} to {branch.to_bus}, "
                f"circuit {branch.ckt}) from bus {bus1} to bus {bus2}"
            )
        if branch.transformer:
            transformers.append(
                [branch.from_bus, branch.to_bus, branch.ckt, float(ss.Line.tap.v[i]), float(ss.Line.phi.v[i])]
            )
        else:
            b_total = float(ss.Line.b.v[i]) + float(ss.Line.b1.v[i]) + float(ss.Line.b2.v[i])
            line_charging.append([branch.from_bus, branch.to_bus, branch.ckt, b_total])
    return {"transformers": transformers, "line_charging": line_charging}


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "server" / "tests" / "julia" / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    andes.config_logger(stream_level=50)
    for name, raw, dyr in RUNS:
        raw_path = CASES / raw
        identity = read_identity(raw_path)
        ss = andes.load(str(raw_path), setup=True, no_output=True, default_config=True)
        ss.PFlow.run()
        ref = int(ss.Bus.idx.v[0])
        a_ref = float(ss.Bus.a.v[0])
        pflow = {
            str(int(idx)): [float(v), math.remainder(float(a) - a_ref, 2 * math.pi)]
            for idx, v, a in zip(ss.Bus.idx.v, ss.Bus.v.v, ss.Bus.a.v, strict=True)
        }
        fixture = {
            "name": name,
            "raw": raw,
            "dyr": dyr,
            "andes_version": andes.__version__,
            "psse_revision": identity.version,
            "base_mva": identity.base_mva,
            "freq_hz": identity.freq_hz,
            "buses": list(identity.buses),
            "swing_buses": list(identity.swing_buses),
            "v_setpoints": v_setpoints(ss, name),
            "corrections": corrections(ss, identity, name),
            "branches": [[b.from_bus, b.to_bus, b.ckt, b.transformer] for b in identity.branches],
            "transformers3": [[list(t.buses), t.ckt] for t in identity.transformers3],
            "generators": [[g.bus, g.id] for g in identity.generators],
            "loads": [[d.bus, d.id] for d in identity.loads],
            "shunts": [[d.bus, d.id] for d in (*identity.fixed_shunts, *identity.switched_shunts)],
            "dyr_models": dyr_models(CASES / dyr) if dyr else [],
            "pflow": {
                "converged": bool(ss.PFlow.converged),
                "angle_reference_bus": ref,
                "buses": pflow,
            },
        }
        (out_dir / f"{name}.json").write_text(json.dumps(fixture, indent=1) + "\n", encoding="utf-8")
        print(
            f"{name}: rev {identity.version}, {len(identity.buses)} buses, {len(identity.branches)} branches, "
            f"{len(identity.generators)} generators, {len(identity.loads)} loads, "
            f"{len(fixture['dyr_models'])} dyr records, pflow converged {fixture['pflow']['converged']}"
        )


if __name__ == "__main__":
    main()
