"""Write the recorded samples of ``server/tests/unit/sienna_samples/`` again
through ``JuliaBridge``.

For when the Julia module changes. For each of the nine cases it writes the
corrections document (``<name>.corrections.json``) and the report, topology
and power flow JSON (``<name>.report.json``, ``.topology.json``,
``.pflow.json``), each as Julia answered it (the string, not re-serialised),
plus ``versions.json``; the corrections document is written by Python, one\nindent deep. The corrections go to Julia as ``SiennaState`` sends
them, through the same function (``julia_corrections``: a MATPOWER branch is
named by its row number in the file). ANDES's cases folder is the one the
installed ANDES carries. Julia works in a temporary folder that is removed
afterwards.

Needs ``TENSA_JULIA`` and ``TENSA_SIENNA_PROJECT`` (or a Julia and a project
TENSA finds) and takes a few minutes. Prints one line per case and exits
non-zero on any failure::

    python scripts/make_sienna_samples.py [output folder]

The output folder defaults to ``server/tests/unit/sienna_samples``.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from tensa.core.examples import _andes_cases_dir
from tensa.engines.case_facts import corrections_document, read_case_facts
from tensa.engines.sienna.bridge import JuliaBridge
from tensa.engines.sienna.state import julia_corrections

_DEFAULT_OUT = Path(__file__).resolve().parents[1] / "server" / "tests" / "unit" / "sienna_samples"

CASES: dict[str, tuple[str, str | None]] = {
    "kundur": ("kundur/kundur.raw", None),
    "kundur_dyr": ("kundur/kundur.raw", "kundur/kundur_full.dyr"),
    "ieee14": ("ieee14/ieee14.raw", None),
    "ieee14_dyr": ("ieee14/ieee14.raw", "ieee14/ieee14.dyr"),
    "ieee39": ("ieee39/ieee39.raw", None),
    "wscc9": ("wscc9/wscc9.raw", None),
    "npcc": ("npcc/npcc.raw", None),
    "wecc": ("wecc/wecc.raw", None),
    "case14_m": ("matpower/case14.m", None),
}


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def _answer(bridge: JuliaBridge, function: str, *args: Any) -> str:
    """The JSON text the Julia module's ``function`` answered, as it is."""
    return str(bridge._call(function, *args))  # noqa: SLF001 - the text, not the parse


def _make_one(
    bridge: JuliaBridge, name: str, raw: Path, dyr: Path | None, scratch: Path, out: Path
) -> None:
    document = corrections_document(read_case_facts(raw))
    setpoints: dict[str, Any] = dict(document["v_setpoints"])  # type: ignore[call-overload]
    v_setpoints = {bus: float(vs) for bus, vs in setpoints.items()}
    session = bridge.load_case(raw, dyr, scratch, v_setpoints, julia_corrections(raw, document))
    _write(out / f"{name}.corrections.json", json.dumps(document, indent=1))
    _write(out / f"{name}.report.json", _answer(bridge, "report_json", session))
    _write(out / f"{name}.topology.json", _answer(bridge, "topology_json", session))
    _write(out / f"{name}.pflow.json", _answer(bridge, "pflow_json", session))


def main(argv: list[str]) -> int:
    out = Path(argv[0]) if argv else _DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)
    cases_dir = _andes_cases_dir()
    if cases_dir is None:
        print("ANDES's cases folder was not found")
        return 1
    bridge = JuliaBridge()
    try:
        bridge.start()
        _write(out / "versions.json", _answer(bridge, "versions_json"))
    except Exception as exc:  # noqa: BLE001 - reported, and the exit status says it
        print(f"Julia: FAILED ({exc})")
        return 1
    failures = 0
    with tempfile.TemporaryDirectory(prefix="tensa-sienna-samples-") as scratch:
        for name, (raw_rel, dyr_rel) in CASES.items():
            raw = cases_dir / raw_rel
            dyr = cases_dir / dyr_rel if dyr_rel else None
            try:
                _make_one(bridge, name, raw, dyr, Path(scratch), out)
            except Exception as exc:  # noqa: BLE001 - reported, and the exit status says it
                print(f"{name}: FAILED ({exc})")
                failures += 1
            else:
                print(f"{name}: ok")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
