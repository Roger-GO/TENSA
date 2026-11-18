#!/usr/bin/env python3
"""Write the dynamic WSCC 9-bus example case, ``wscc9.xlsx``, from the data of the book.

Usage:
    python scripts/build_wscc9.py [-o FILE] [--check]

The WSCC 3-machine, 9-bus system of P. M. Anderson and A. A. Fouad, "Power System Control and
Stability" (2nd ed., IEEE Press and Wiley-Interscience, 2003), Chapter 2, Example 2.6. ANDES
ships the network of this system (``wscc9/wscc9.xlsx``) with no machines, and no ``.dyr`` of it
exists, so TENSA writes its own file: the network of the book, the three machines of its
Example 2.6 as classical models (``GENCLS``), and nothing else (no exciter, no governor, no
event). Every number below is one the book prints (as the reproductions named in the
catalog give them, per unit on the 100 MVA base), and the file is this script's output, so
there is one place to read it and to change it. The numbers are checked against the book in
``server/tests/unit/test_wscc9_build.py`` (the reduced admittance matrix and the initial
state of Example 2.6, as the arXiv note by Wang, Liu and Sun prints them) and against
independent computations by ``scripts/crosscheck_pf.py`` and ``scripts/crosscheck_classical.py``.

The workbook holds what ANDES's own writer (``andes.io.xlsx.write``) holds, one sheet for each
model, but not its ``_config`` sheet: ANDES applies that sheet when it loads a file, so it
would pin every ANDES setting for whoever opens the case. The file stores the power flow
solution (rounded to six places) as the initial state, as the ANDES cases do, and carries a
fixed timestamp in the workbook's properties and in its archive, so that the same data gives the
same bytes on a machine with the same zlib, pandas and xlsxwriter, and the catalog can hold the
file's SHA-256.

``--check`` builds the file into a temporary place and exits 1 when the one at the output path
holds other data (the checksum the catalog holds is that file's). Bytes that differ with the
same data in every sheet, as another zlib or another release of the writer gives, exit 0 and
say so.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import io
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "server" / "src" / "tensa" / "examples" / "cases" / "wscc9.xlsx"

# The moment written into the file in place of the time it was built (the day the file was
# first written; changing it changes the file's checksum).
FIXED_TIME = (2026, 11, 17, 0, 0, 0)

BASE_MVA = 100.0
FREQUENCY_HZ = 60.0

# How many places the stored power flow solution is rounded to. It is the starting point of the
# user's own power flow, which converges from it in one step, and it must not depend on the
# last digits of a platform's arithmetic.
SOLUTION_PLACES = 6

# Buses: idx -> nominal voltage in kV. The generator buses are the machines' terminals
# (16.5, 18 and 13.8 kV) and the others the 230 kV network.
BUSES: dict[int, float] = {
    1: 16.5,
    2: 18.0,
    3: 13.8,
    4: 230.0,
    5: 230.0,
    6: 230.0,
    7: 230.0,
    8: 230.0,
    9: 230.0,
}

# Lines: (bus1, bus2, r, x, b), per unit on 100 MVA; b is the total line charging.
LINES: tuple[tuple[int, int, float, float, float], ...] = (
    (4, 5, 0.0100, 0.0850, 0.1760),
    (4, 6, 0.0170, 0.0920, 0.1580),
    (5, 7, 0.0320, 0.1610, 0.3060),
    (6, 9, 0.0390, 0.1700, 0.3580),
    (7, 8, 0.0085, 0.0720, 0.1490),
    (8, 9, 0.0119, 0.1008, 0.2090),
)

# Generator step-up transformers: (low-voltage bus, 230 kV bus, x) per unit on 100 MVA, at
# their nominal ratio (the book gives a reactance only).
TRANSFORMERS: tuple[tuple[int, int, float], ...] = (
    (1, 4, 0.0576),
    (2, 7, 0.0625),
    (3, 9, 0.0586),
)

# Loads: bus -> (P, Q) in MW and MVAr. The book holds them as constant impedances.
LOADS: dict[int, tuple[float, float]] = {5: (125.0, 50.0), 6: (90.0, 30.0), 8: (100.0, 35.0)}

# Generators: bus -> (P in MW, voltage set-point in pu). Bus 1 is the slack, so its P is only
# what the book's solution gives (71.64 MW), which a power flow recomputes.
GENERATORS: dict[int, tuple[float, float]] = {1: (71.64, 1.04), 2: (163.0, 1.025), 3: (85.0, 1.025)}

# Machines (classical model): bus -> (H in s, x'd in pu), both on the 100 MVA base, as the book
# tabulates them. No damping, no armature resistance.
MACHINES: dict[int, tuple[float, float]] = {
    1: (23.64, 0.0608),
    2: (6.40, 0.1198),
    3: (3.01, 0.1813),
}


def line_idx(bus1: int, bus2: int) -> str:
    """The idx of the line or transformer between two buses.

    Numbered from 0 in the order of ``LINES`` then ``TRANSFORMERS``, as ANDES numbers the
    branches of its own ``wscc9.xlsx`` (the six lines, then the three transformers), so that
    what refers to a branch of that case by its idx finds the same branch here.
    """
    pairs = [(a, b) for a, b, *_ in (*LINES, *TRANSFORMERS)]
    for number, pair in enumerate(pairs):
        if pair in ((bus1, bus2), (bus2, bus1)):
            return f"Line_{number}"
    raise KeyError((bus1, bus2))


def build_system(solution: dict[str, Any] | None = None) -> Any:
    """An ANDES ``System`` holding the case, not set up.

    ``solution`` (from ``solve``) puts the power flow solution in as the initial state; with
    none, every bus starts at 1 pu and 0 degrees.
    """
    import andes

    system = andes.System(no_output=True, default_config=True)
    system.config.mva = BASE_MVA
    system.config.freq = FREQUENCY_HZ
    system.add("Area", {"idx": 1, "name": "1"})
    for idx, kv in BUSES.items():
        bus = {"idx": idx, "name": f"Bus {idx}", "Vn": kv, "area": 1}
        if solution is not None:
            bus.update(v0=solution["v"][idx], a0=solution["a"][idx])
        system.add("Bus", bus)
    for number, (bus, (p_mw, vset)) in enumerate(GENERATORS.items(), start=1):
        model = "Slack" if number == 1 else "PV"
        params = {
            "idx": bus,
            "name": f"Gen {bus}",
            "bus": bus,
            "Sn": BASE_MVA,
            "Vn": BUSES[bus],
            "v0": vset,
            "p0": p_mw / BASE_MVA,
        }
        if model == "Slack":
            params["a0"] = 0.0
        if solution is not None:
            params["q0"] = solution["q"][bus]
            if model == "Slack":
                params["p0"] = solution["p_slack"]
        system.add(model, params)
    for number, (bus, (p_mw, q_mvar)) in enumerate(LOADS.items()):
        system.add(
            "PQ",
            {
                "idx": f"PQ_{number}",
                "name": f"Load {bus}",
                "bus": bus,
                "Vn": BUSES[bus],
                "p0": p_mw / BASE_MVA,
                "q0": q_mvar / BASE_MVA,
            },
        )
    for bus1, bus2, r, x, b in LINES:
        system.add(
            "Line",
            {
                "idx": line_idx(bus1, bus2),
                "name": f"Line {bus1}-{bus2}",
                "bus1": bus1,
                "bus2": bus2,
                "Sn": BASE_MVA,
                "Vn1": BUSES[bus1],
                "Vn2": BUSES[bus2],
                "r": r,
                "x": x,
                "b": b,
            },
        )
    for low, high, x in TRANSFORMERS:
        system.add(
            "Line",
            {
                "idx": line_idx(low, high),
                "name": f"Transformer {low}-{high}",
                "bus1": low,
                "bus2": high,
                "Sn": BASE_MVA,
                "Vn1": BUSES[low],
                "Vn2": BUSES[high],
                "x": x,
                "trans": 1,
            },
        )
    for bus, (h, xd1) in MACHINES.items():
        system.add(
            "GENCLS",
            {
                "idx": bus,
                "name": f"GENCLS {bus}",
                "bus": bus,
                "gen": bus,
                "Sn": BASE_MVA,
                "Vn": BUSES[bus],
                "fn": FREQUENCY_HZ,
                "D": 0.0,
                "M": 2.0 * h,
                "ra": 0.0,
                "xd1": xd1,
            },
        )
    return system


def solve(system: Any) -> dict[str, Any]:
    """The power flow solution of a ``System`` (set up here), rounded for the file."""
    import numpy as np

    system.setup()
    system.PFlow.config.tol = 1e-10
    system.PFlow.run()
    if not system.PFlow.converged:
        raise SystemExit("build_wscc9: the power flow of the case did not converge")
    places = SOLUTION_PLACES
    ids = list(system.Bus.idx.v)
    v = {i: round(float(x), places) for i, x in zip(ids, system.Bus.v.v, strict=True)}
    a = {i: round(float(x), places) for i, x in zip(ids, system.Bus.a.v, strict=True)}
    q: dict[int, float] = {}
    p_slack = 0.0
    for name in ("Slack", "PV"):
        model = getattr(system, name)
        for k, bus in enumerate(model.bus.v):
            q[int(bus)] = round(float(np.asarray(model.q.v)[k]), places)
            if name == "Slack":
                p_slack = round(float(np.asarray(model.p.v)[k]), places)
    return {"v": v, "a": a, "q": q, "p_slack": p_slack}


def _workbook(system: Any, path: Path) -> None:
    """Write one sheet for each model that has devices, as ``andes.io.xlsx.write`` does."""
    import pandas as pd

    with pd.ExcelWriter(path, engine="xlsxwriter") as writer:
        for name, model in system.models.items():
            if model.n:
                model.as_df(vin=True).to_excel(writer, sheet_name=name, freeze_panes=(1, 0))
        writer.book.set_properties({"created": datetime.datetime(*FIXED_TIME)})


def _fixed_archive(raw: bytes) -> bytes:
    """The same workbook with every timestamp in it replaced by ``FIXED_TIME``."""
    stamp = "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(*FIXED_TIME)
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as src, zipfile.ZipFile(out, "w") as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == "docProps/core.xml":
                text = data.decode("utf-8")
                text = re.sub(
                    r"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:)",
                    rf"\g<1>{stamp}\g<2>",
                    text,
                )
                data = text.encode("utf-8")
            entry = zipfile.ZipInfo(info.filename, date_time=FIXED_TIME)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            dst.writestr(entry, data)
    return out.getvalue()


def build_file(path: Path) -> str:
    """Write the case to ``path`` and give the SHA-256 of what was written."""
    solution = solve(build_system())
    system = build_system(solution)
    system.setup()
    with tempfile.TemporaryDirectory(prefix="tensa-wscc9-") as tmp:
        raw_path = Path(tmp) / "wscc9.xlsx"
        _workbook(system, raw_path)
        content = _fixed_archive(raw_path.read_bytes())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return hashlib.sha256(content).hexdigest()


def _same_data(left: Path, right: Path) -> bool:
    """Whether two workbooks hold the same sheets with the same values."""
    import pandas as pd

    a = pd.read_excel(left, sheet_name=None)
    b = pd.read_excel(right, sheet_name=None)
    if list(a) != list(b):
        return False
    try:
        for name, frame in a.items():
            pd.testing.assert_frame_equal(frame, b[name])
    except AssertionError:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "-o", "--output", type=Path, default=DEFAULT_OUTPUT, help="the file to write"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="build into a temporary place and compare with the output file",
    )
    args = parser.parse_args(argv)
    if importlib.util.find_spec("andes") is None:
        print("build_wscc9: ANDES is not installed in this Python", file=sys.stderr)
        return 2
    if args.check:
        with tempfile.TemporaryDirectory(prefix="tensa-wscc9-check-") as tmp:
            built_path = Path(tmp) / "wscc9.xlsx"
            built = build_file(built_path)
            have = (
                hashlib.sha256(args.output.read_bytes()).hexdigest() if args.output.exists() else ""
            )
            if built == have:
                print(f"{args.output} is what this script builds ({built})")
                return 0
            if have and _same_data(args.output, built_path):
                print(
                    f"{args.output} holds the data this script builds, in other bytes "
                    f"({have}, not {built}): the zlib, pandas or xlsxwriter here is not the "
                    "one that wrote it"
                )
                return 0
        print(f"build_wscc9: {args.output} is not what this script builds ({built})")
        return 1
    digest = build_file(args.output)
    print(f"wrote {args.output} (sha256 {digest})")
    return 0


if __name__ == "__main__":
    with contextlib.suppress(AttributeError):
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    sys.exit(main())
