"""Compare the spike outputs of two engines for one case.

    python compare.py <andes_dir> <sienna_dir> [out.md]

Power flow: per-bus voltage and angle difference (angles referred to the same bus).
Eigenvalues: oscillatory modes matched nearest-first, frequency and damping side by side.
Time domain: each series interpolated on a common grid, largest and RMS difference.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import numpy as np


def load(d: Path, name: str):
    p = d / name
    if not p.exists():
        return None
    data = json.loads(p.read_text(encoding="utf-8"))
    return None if isinstance(data, dict) and "error" in data and len(data) == 1 else data


def modes(eigs: list[list[float]]) -> list[tuple[float, float, complex]]:
    out = []
    for re_, im in eigs:
        if im > 1e-6:
            z = complex(re_, im)
            out.append((im / (2 * math.pi), -re_ / abs(z), z))
    return sorted(out, key=lambda m: m[0])


def series_of(tds: dict) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Normalise both layouts to key -> (t, y), with generator keys reduced to their bus."""
    out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    shared_t = np.asarray(tds["t"]) if "t" in tds else None
    for key, val in tds["series"].items():
        if isinstance(val, dict):
            t, y = np.asarray(val["t"], dtype=float), np.asarray(val["y"], dtype=float)
        else:
            t, y = shared_t, np.asarray(val, dtype=float)
        short = re.sub(r":.*$", "", key)
        if short in out:  # second machine on the same bus: keep the full key
            short = key
        out[short] = (t, y)
    return out


def main() -> None:
    a_dir, s_dir = Path(sys.argv[1]), Path(sys.argv[2])
    lines: list[str] = [f"# {a_dir.name}: ANDES vs Sienna", ""]

    pa, ps = load(a_dir, "pflow.json"), load(s_dir, "pflow.json")
    if pa and ps:
        common = sorted(set(pa["buses"]) & set(ps["buses"]), key=int)
        ref = common[0]
        shift = pa["buses"][ref]["a_deg"] - ps["buses"][ref]["a_deg"]
        dv = [abs(pa["buses"][b]["v"] - ps["buses"][b]["v"]) for b in common]
        da = [abs(pa["buses"][b]["a_deg"] - ps["buses"][b]["a_deg"] - shift) for b in common]
        lines += [
            "## Power flow",
            f"- buses: ANDES {len(pa['buses'])}, Sienna {len(ps['buses'])}, common {len(common)}",
            f"- converged: ANDES {pa['converged']}, Sienna {ps['converged']}",
            f"- largest voltage difference: {max(dv):.2e} pu (bus {common[int(np.argmax(dv))]})",
            f"- largest angle difference: {max(da):.2e} deg (bus {common[int(np.argmax(da))]}), angles referred to bus {ref}",
            "",
        ]
    else:
        lines += ["## Power flow", "- missing on one side", ""]

    ea, es = load(a_dir, "eig.json"), load(s_dir, "eig.json")
    if ea and es:
        ma, ms = modes(ea["eigenvalues"]), modes(es["eigenvalues"])
        lines += [
            "## Eigenvalues",
            f"- states: ANDES {ea['n_states']}, Sienna {es['n_states']}",
            f"- oscillatory modes: ANDES {len(ma)}, Sienna {len(ms)}",
            f"- largest real part: ANDES {max(e[0] for e in ea['eigenvalues']):.4g}, Sienna {max(e[0] for e in es['eigenvalues']):.4g}",
            "",
            "| ANDES f (Hz) | ANDES damping | Sienna f (Hz) | Sienna damping | distance |",
            "|---|---|---|---|---|",
        ]
        left = list(ms)
        for f, zeta, z in ma:
            if not left:
                lines.append(f"| {f:.4f} | {zeta:.4f} | - | - | - |")
                continue
            j = min(range(len(left)), key=lambda k: abs(left[k][2] - z))
            f2, zeta2, z2 = left.pop(j)
            lines.append(f"| {f:.4f} | {zeta:.4f} | {f2:.4f} | {zeta2:.4f} | {abs(z - z2):.3g} |")
        for f2, zeta2, _ in left:
            lines.append(f"| - | - | {f2:.4f} | {zeta2:.4f} | - |")
        lines.append("")
    else:
        lines += ["## Eigenvalues", "- missing on one side", ""]

    ta, ts = load(a_dir, "tds.json"), load(s_dir, "tds.json")
    if ta and ts:
        sa, ss = series_of(ta), series_of(ts)
        common = sorted(set(sa) & set(ss))
        lines += [
            "## Time domain (line trip)",
            f"- series: ANDES {len(sa)}, Sienna {len(ss)}, common {len(common)}",
            f"- only ANDES: {sorted(set(sa) - set(ss))[:8]}",
            f"- only Sienna: {sorted(set(ss) - set(sa))[:8]}",
            "",
            "| series | start ANDES | start Sienna | largest difference | RMS difference | swing ANDES |",
            "|---|---|---|---|---|---|",
        ]
        # Rotor angles are compared relative to the first machine: ANDES reports them in
        # the synchronous frame (they drift when frequency moves), Sienna in the frame of
        # its reference, so only differences between machines mean the same in both.
        deltas = [k for k in common if k.startswith("delta")]
        ref_key = deltas[0] if deltas else None
        for key in common:
            (t1, y1), (t2, y2) = sa[key], ss[key]
            grid = np.linspace(max(t1[0], t2[0]), min(t1[-1], t2[-1]), 2001)
            a, b = np.interp(grid, t1, y1), np.interp(grid, t2, y2)
            if key.startswith("delta"):
                if key == ref_key:
                    continue
                a = a - np.interp(grid, *sa[ref_key])
                b = b - np.interp(grid, *ss[ref_key])
                key = f"{key} - {ref_key}"
            d = a - b
            lines.append(
                f"| {key} | {y1[0]:.5f} | {y2[0]:.5f} | {np.max(np.abs(d)):.3e} | "
                f"{math.sqrt(float(np.mean(d * d))):.3e} | {np.ptp(a):.3e} |"
            )
        lines.append("")
    else:
        lines += ["## Time domain", "- missing on one side", ""]

    tia, tis = load(a_dir, "timings.json"), load(s_dir, "timings.json")
    if tia and tis:
        lines += ["## Wall time (s)", f"- ANDES: {tia}", f"- Sienna: {tis}", ""]

    text = "\n".join(lines)
    if len(sys.argv) > 3:
        Path(sys.argv[3]).write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
