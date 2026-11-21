"""Write a variant of a PSS/E .dyr file for like-for-like engine comparison.

    python make_dyr_variant.py <in.dyr> <out.dyr> --keep GENROU,TGOV1 [--exdc2-to-ieeet1]

Keeps only the records of the named models. With --exdc2-to-ieeet1 an EXDC2 record
whose lead-lag is unity (TB == TC) is rewritten as the IEEET1 it then equals, which
both ANDES and PowerSystems read:
    EXDC2 : TR KA TA TB TC VRMAX VRMIN KE TE KF TF1 switch E1 SE1 E2 SE2
    IEEET1: TR KA TA       VRMAX VRMIN KE TE KF TF  switch E1 SE1 E2 SE2
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--keep", required=True)
    ap.add_argument("--exdc2-to-ieeet1", action="store_true")
    args = ap.parse_args()
    keep = {m.strip().upper() for m in args.keep.split(",")}
    out: list[str] = []
    counts: dict[str, int] = {}
    for rec in Path(args.src).read_text().split("/"):
        # A model name may be quoted with padding inside the quotes: 'EXDC2 '
        rec = re.sub(r"'([^']*)'", lambda m: m.group(1).strip(), rec)
        tokens = rec.replace(",", " ").split()
        if len(tokens) < 3 or not tokens[0].lstrip("-").isdigit():
            continue
        bus, model, ident, values = tokens[0], tokens[1].strip("'").strip().upper(), tokens[2], tokens[3:]
        if model == "EXDC2" and args.exdc2_to_ieeet1:
            tb, tc = float(values[3]), float(values[4])
            if tb != tc:
                raise SystemExit(f"EXDC2 at bus {bus}: TB != TC, not equal to an IEEET1")
            model, values = "IEEET1", values[:3] + values[5:]
        if model not in keep:
            continue
        counts[model] = counts.get(model, 0) + 1
        out.append(f"{bus} '{model}' {ident} " + " ".join(values) + " /")
    Path(args.dst).parent.mkdir(parents=True, exist_ok=True)
    Path(args.dst).write_text("\n".join(out) + "\n")
    print(f"{args.dst}: {counts}")


if __name__ == "__main__":
    main()
