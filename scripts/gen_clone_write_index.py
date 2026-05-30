#!/usr/bin/env python3
"""Unit 0 spike generator: build the clone-write-index from live ANDES.

Combines ``_PARAMS_BY_MODEL`` (authoritative ANDES param names per whitelisted
controller model) with ``andes/io/psse-dyr.yaml`` (the PSS/E .dyr field order +
ANDES-param -> PSS/E-field map) to produce, for every editable numeric param:

  - xlsx edit op: always available (sheet=model, column=param name)
  - dyr  edit op: available iff the param maps to a plain (non-transformed)
                  PSS/E field that appears in the model's `inputs` order

Regenerate (from the repo root) when ANDES is upgraded::

    PYTHONPATH=server/src python scripts/gen_clone_write_index.py

The drift guard ``server/tests/unit/spike/test_clone_write_index.py`` fails if
the committed JSON falls out of sync with live ANDES.
"""

from __future__ import annotations

import json
import os

import andes
import yaml

from andes_app.core.wrapper import _CONTROLLER_MODEL_NAMES, _PARAMS_BY_MODEL

ANDES_DIR = os.path.dirname(andes.__file__)
DYR_YAML = os.path.join(ANDES_DIR, "io", "psse-dyr.yaml")

with open(DYR_YAML) as fh:
    DYR = yaml.safe_load(fh)


def dyr_field_for(model: str, param: str) -> dict | None:
    """Return {field, field_index} if `param` is a plain in-place .dyr edit."""
    spec = DYR.get(model)
    if spec is None:
        return None
    outputs = spec.get("outputs", {})
    inputs = spec.get("inputs", [])
    pss_field = outputs.get(param)
    if pss_field is None:
        return None
    # A `;` means the file stores a transformed quantity (e.g. M = 2*H), so an
    # in-place edit of the file field would NOT equal the ANDES param value.
    if ";" in str(pss_field):
        return None
    if pss_field not in inputs:
        return None
    return {"field": pss_field, "field_index": inputs.index(pss_field)}


def build() -> dict:
    models: dict[str, dict] = {}
    for model in sorted(_CONTROLLER_MODEL_NAMES):
        metas = _PARAMS_BY_MODEL.get(model)
        if not metas:
            continue
        params: dict[str, dict] = {}
        for meta in metas:
            # Editable params are the numeric scalars; idx/name and reference
            # params (kind != 'number') bind identity/topology and are immutable.
            if meta.kind != "number":
                continue
            dyr = dyr_field_for(model, meta.name)
            params[meta.name] = {
                "xlsx": {"column": meta.name},
                "dyr": dyr,
            }
        models[model] = {
            "xlsx": {"sheet": model, "idx_column": "idx"},
            "dyr": (
                {"inputs": DYR[model]["inputs"], "locator_fields": ["BUS", "ID"]}
                if model in DYR
                else None
            ),
            "params": params,
        }
    return {
        "schema_version": 1,
        "description": (
            "Per (model, param) clone-on-write edit primitives for the R15 "
            "dynamic-controller whitelist. Generated from live ANDES "
            "_PARAMS_BY_MODEL + andes/io/psse-dyr.yaml."
        ),
        "formats": {
            "xlsx": "ANDES-native: one sheet per model, one row per device, "
            "columns are param names; locate row by idx_column, set cell at column.",
            "dyr": "PSS/E line-based: a record is `BUS 'MODEL' ID f0 f1 ... /`; "
            "fields follow `inputs` order; replace field at field_index.",
            "raw": "PSS/E steady-state: holds NO dynamic-controller params; "
            "controller edits never route here.",
        },
        "models": models,
    }


if __name__ == "__main__":
    idx = build()
    out = os.path.join(
        os.path.dirname(__file__), "..", "docs", "spikes", "2026-05-29-clone-write-index.json"
    )
    out = os.path.normpath(out)
    with open(out, "w") as fh:
        json.dump(idx, fh, indent=2, sort_keys=False)
        fh.write("\n")
    # Console summary
    total = sum(len(m["params"]) for m in idx["models"].values())
    dyr_ok = sum(
        1 for m in idx["models"].values() for p in m["params"].values() if p["dyr"]
    )
    print(f"wrote {out}")
    print(f"models={len(idx['models'])} editable_params={total} dyr_editable={dyr_ok}")
    for name, m in idx["models"].items():
        n = len(m["params"])
        d = sum(1 for p in m["params"].values() if p["dyr"])
        print(f"  {name}: {n} params, {d} dyr-editable, dyr_record={'yes' if m['dyr'] else 'no'}")
