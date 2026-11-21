"""Write the reference fixtures the Sienna engine's Julia tests compare against.

For each PSS/E case ANDES ships, the fixture holds what does not depend on an engine
(the identity of the case file, from ``tensa.engines.identity``) and what the reference
engine computes (ANDES's power flow: voltage magnitude and angle at every bus). The
Julia tests in ``server/tests/julia`` load the same file with Sienna and must find the
same elements and the same solution.

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

from tensa.engines.identity import read_identity

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
            for idx, v, a in zip(ss.Bus.idx.v, ss.Bus.v.v, ss.Bus.a.v)
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
