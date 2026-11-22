"""Cross-check of the identity reader against ANDES itself (unit P3-B1).

For each case ANDES ships, the identity the reader gives must agree with what
ANDES loads: same buses, same number of loads and generators, and the same
unordered bus pairs for the non-transformer lines in file order.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tensa.core.examples import _andes_cases_dir
from tensa.engines.identity import read_identity


def _andes_case(relative: str) -> Path:
    cases_dir = _andes_cases_dir()
    if cases_dir is None:
        pytest.skip("ANDES cases folder not found")
    path = Path(cases_dir) / relative
    if not path.is_file():
        pytest.skip(f"ANDES case file missing: {relative}")
    return path


REAL_CASES = (
    "kundur/kundur.raw",
    "ieee14/ieee14.raw",
    "wscc9/wscc9_3wxfr.raw",
    "ieee39/ieee39.raw",
    "npcc/npcc.raw",
    "wecc/wecc.raw",
)


@pytest.mark.integration
@pytest.mark.parametrize("relative", REAL_CASES)
def test_identity_matches_andes(relative: str) -> None:
    andes = pytest.importorskip("andes")
    path = _andes_case(relative)
    identity = read_identity(path)
    ss = andes.load(str(path), setup=False, no_output=True, default_config=True)

    if identity.transformers3:
        # ANDES turns a three-winding transformer into a star bus and three
        # lines, so its Bus list holds one bus the file does not number and its
        # Line list three lines with no file record; only the checks that do
        # hold are made: the file's buses are a subset of ANDES's, and the
        # non-transformer lines still line up in order.
        assert set(identity.buses) <= set(ss.Bus.idx.v)
    else:
        assert set(identity.buses) == set(ss.Bus.idx.v)

    assert len(identity.loads) == ss.PQ.n
    assert len(identity.generators) == ss.PV.n + ss.Slack.n

    n_branch = sum(1 for branch in identity.branches if not branch.transformer)
    for position in range(n_branch):
        branch = identity.branches[position]
        andes_pair = {ss.Line.bus1.v[position], ss.Line.bus2.v[position]}
        assert andes_pair == {branch.from_bus, branch.to_bus}
