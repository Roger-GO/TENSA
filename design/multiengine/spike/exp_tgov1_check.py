"""Check the TGOV1 audit: Sienna's governor outputs torque = P_m / omega, ANDES torque = P_m.

Linearised, P_m / omega adds a damping torque of P_m0 per unit speed on each machine.
If that is the whole difference, ANDES with D raised by P_m0 (machine base) on every
GENROU must reproduce Sienna's eigenvalues for the GENROU + TGOV1 case.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import andes
import numpy as np

raw, dyr, sienna_eig = sys.argv[1:4]
andes.config_logger(stream_level=40)


def modes(mu):
    out = []
    for z in mu:
        if z.imag > 1e-6:
            out.append((z.imag / (2 * math.pi), -z.real / abs(z)))
    return sorted(out)


def run(extra_damping: bool):
    ss = andes.load(raw, addfile=dyr, setup=False, no_output=True, default_config=True)
    if extra_damping:
        mva = ss.config.mva
        for i, gen in enumerate(ss.GENROU.gen.v):
            k = list(ss.PV.idx.v).index(gen) if gen in ss.PV.idx.v else None
            if k is not None:
                p0 = ss.PV.p0.v[k]
            else:
                p0 = None  # slack: filled after power flow below
            ss.GENROU.D.v[i] = np.nan if p0 is None else p0 * mva / ss.GENROU.Sn.v[i]
        if np.isnan(ss.GENROU.D.v).any():
            # get the slack machine's output from a power flow on a second System
            s2 = andes.load(raw, addfile=dyr, setup=True, no_output=True, default_config=True)
            s2.PFlow.run()
            p_slack = float(s2.Slack.p.v[0])
            for i in range(ss.GENROU.n):
                if np.isnan(ss.GENROU.D.v[i]):
                    ss.GENROU.D.v[i] = p_slack * mva / ss.GENROU.Sn.v[i]
        print("D set to (machine base):", [round(float(d), 4) for d in ss.GENROU.D.v])
    ss.setup()
    ss.PFlow.run()
    ss.EIG.run()
    return modes(np.asarray(ss.EIG.mu).ravel())


base = run(False)
damped = run(True)
sienna = modes([complex(a, b) for a, b in json.loads(Path(sienna_eig).read_text())["eigenvalues"]])
print(f"{'':>4} {'ANDES':>18} {'ANDES + D=Pm0':>18} {'Sienna':>18}")
for k in range(max(len(base), len(sienna))):
    row = [m[k] if k < len(m) else (float('nan'),) * 2 for m in (base, damped, sienna)]
    print(f"{k:>4} " + " ".join(f"{f:8.4f} Hz {z:6.4f}" for f, z in row))
