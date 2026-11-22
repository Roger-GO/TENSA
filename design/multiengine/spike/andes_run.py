"""Phase 1 spike, ANDES side: power flow, eigenvalues and a line trip on a PSS/E case.

    python andes_run.py <case.raw> <case.dyr|-> <out_dir> <from_bus> <to_bus> [t_trip] [tf]

Writes pflow.json, eig.json and tds.json keyed by PSS/E identity (bus numbers), so
the Sienna side can be compared without knowing ANDES idx values.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import andes
import numpy as np


def load(raw: str, dyr: str | None, setup: bool):
    kwargs = {"setup": setup, "no_output": True, "default_config": True}
    if dyr:
        kwargs["addfile"] = dyr
    return andes.load(raw, **kwargs)


def main() -> None:
    raw, dyr, out_dir, fb, tb = sys.argv[1:6]
    dyr = None if dyr == "-" else dyr
    t_trip = float(sys.argv[6]) if len(sys.argv) > 6 else 1.0
    tf = float(sys.argv[7]) if len(sys.argv) > 7 else 10.0
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    andes.config_logger(stream_level=40)
    timings: dict[str, float] = {}

    # Power flow
    t0 = time.perf_counter()
    ss = load(raw, dyr, setup=True)
    timings["load_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    ss.PFlow.run()
    timings["pflow_s"] = time.perf_counter() - t0
    buses = {
        str(int(idx)): {"v": float(v), "a_deg": float(np.degrees(a))}
        for idx, v, a in zip(ss.Bus.idx.v, ss.Bus.v.v, ss.Bus.a.v)
    }
    models = {
        name: int(mdl.n) for name, mdl in ss.models.items() if getattr(mdl, "n", 0) > 0
    }
    (out / "pflow.json").write_text(
        json.dumps(
            {
                "engine": "andes",
                "version": andes.__version__,
                "converged": bool(ss.PFlow.converged),
                "iterations": int(ss.PFlow.niter),
                "buses": buses,
                "models": models,
            },
            indent=1,
        )
    )

    if dyr:
        # Eigenvalues, on a fresh System (EIG leaves the DAE initialised for TDS).
        se = load(raw, dyr, setup=True)
        se.PFlow.run()
        t0 = time.perf_counter()
        se.EIG.run()
        timings["eig_s"] = time.perf_counter() - t0
        mu = np.asarray(se.EIG.mu).ravel()
        (out / "eig.json").write_text(
            json.dumps(
                {
                    "n_states": int(se.dae.n),
                    "eigenvalues": sorted(
                        ([float(z.real), float(z.imag)] for z in mu),
                        key=lambda p: (-p[0], -abs(p[1])),
                    ),
                },
                indent=1,
            )
        )

        # Line trip
        st = load(raw, dyr, setup=False)
        line = None
        for idx, b1, b2 in zip(st.Line.idx.v, st.Line.bus1.v, st.Line.bus2.v):
            if {int(b1), int(b2)} == {int(fb), int(tb)}:
                line = idx
                break
        if line is None:
            sys.exit(f"no line between {fb} and {tb}")
        st.add("Toggle", {"model": "Line", "dev": line, "t": t_trip})
        st.setup()
        st.PFlow.run()
        st.TDS.config.tf = tf
        st.TDS.config.no_tqdm = 1
        t0 = time.perf_counter()
        st.TDS.run()
        timings["tds_s"] = time.perf_counter() - t0
        t = np.asarray(st.dae.ts.t)
        x = np.asarray(st.dae.ts.x)
        y = np.asarray(st.dae.ts.y)
        series: dict[str, list[float]] = {}
        for name in ("GENROU", "GENCLS"):
            mdl = getattr(st, name)
            if mdl.n == 0:
                continue
            for gen_idx, bus, addr_w, addr_d in zip(mdl.idx.v, mdl.bus.v, mdl.omega.a, mdl.delta.a):
                series[f"omega@bus{int(bus)}:{gen_idx}"] = x[:, addr_w].tolist()
                series[f"delta@bus{int(bus)}:{gen_idx}"] = x[:, addr_d].tolist()
        for bus, addr in zip(st.Bus.idx.v, st.Bus.v.a):
            series[f"v@bus{int(bus)}"] = y[:, addr].tolist()
        (out / "tds.json").write_text(
            json.dumps(
                {
                    "tripped_line": [int(fb), int(tb)],
                    "t_trip": t_trip,
                    "exit_code": int(getattr(st, "exit_code", 0)),
                    "t": t.tolist(),
                    "series": series,
                }
            )
        )

    (out / "timings.json").write_text(json.dumps(timings, indent=1))
    print(json.dumps({"case": Path(raw).name, "buses": len(buses), **timings}))


if __name__ == "__main__":
    main()
