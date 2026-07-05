"""Fault study: load IEEE-14, fault bus 7, run a 5 s TDS, report the result.

Run with a server already serving a workspace that contains ieee14_full.xlsx:

    tensa serve --workspace ~/andes-cases --port 8000
    python examples/run_fault_study.py [case_filename]
"""

from __future__ import annotations

import sys

from tensa_client import AndesApp

CASE = sys.argv[1] if len(sys.argv) > 1 else "ieee14_full.xlsx"

app = AndesApp("http://127.0.0.1:8000")

with app.session() as s:
    print(f"Loading {CASE} ...")
    s.load_case(CASE)

    print("Registering fault at bus 7 (t = 1.0 → 1.1 s)")
    s.add_fault(bus_idx="7", tf=1.0, tc=1.1)

    pf = s.run_pflow()
    print(f"Power flow converged: {pf['converged']}")

    print("Running 5 s time-domain simulation ...")
    tds = s.run_tds(tf=5.0)
    print(f"TDS converged: {tds['converged']}")

    op = s.operating_point()
    voltages = op.get("bus_voltages") or {}
    if voltages:
        worst_bus = min(voltages, key=lambda k: voltages[k])
        print(f"Lowest final bus voltage: {voltages[worst_bus]:.4f} pu at bus {worst_bus}")
