"""A time-domain run exported as a COMTRADE record, over HTTP.

The unit tests check the record against signals made up for them. This one runs
ANDES: a fault on the IEEE 14-bus case, recorded by a batch run, sent to
``POST /comtrade`` as the run returned it, and read back from the archive with
the reader of ``tests/_comtrade.py``. What the record holds must be what the run
returned, to the resolution of the format.

Markers: ``integration``.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tests._comtrade import read_comtrade_zip

pytestmark = pytest.mark.integration

FAULT_ON = 0.3
FAULT_OFF = 0.4


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
def live(tmp_path: Path) -> Iterator[tuple[TestClient, str]]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for name in ("ieee14.raw", "ieee14.dyr"):
        shutil.copy2(_cases() / "ieee14" / name, workspace / name)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as client:
        created = client.post("/api/sessions")
        assert created.status_code == 201, created.text
        sid = str(created.json()["session_id"])
        loaded = client.post(
            f"/api/sessions/{sid}/case",
            json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
        )
        assert loaded.status_code in (200, 201), loaded.text
        yield client, sid


def test_a_faulted_run_is_exported_as_the_record_of_what_it_returned(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live
    fault = {"kind": "fault", "bus_idx": 9, "tf": FAULT_ON, "tc": FAULT_OFF, "xf": 0.05, "rf": 0}
    added = client.post(f"/api/sessions/{sid}/disturbances", json={"disturbances": [fault]})
    assert added.status_code == 200, added.text

    names = ["omega GENROU 1", "v Bus 3", "a Bus 3"]
    catalogue = client.get(f"/api/sessions/{sid}/dae-variables", params={"limit": 1000}).json()
    units = {item["name"]: item["unit"] for item in catalogue["items"] if item["name"] in names}
    run = client.post(f"/api/sessions/{sid}/tds", json={"tf": 1.0, "h": 0.02, "dae_vars": names})
    assert run.status_code == 200, run.text
    traces = run.json()["traces"]
    t = np.array(traces["t"])

    exported = client.post(
        "/api/comtrade",
        json={
            "t": traces["t"],
            "channels": [{**series, "unit": units[series["name"]]} for series in traces["variables"]],
            "name": "ieee14_fault-bus-9",
            "station": "ieee14",
            "start_time": "2026-10-05T09:00:00",
            "trigger_t": FAULT_ON,
        },
    )

    assert exported.status_code == 200, exported.text
    name, record = read_comtrade_zip(exported.content)
    assert name == "ieee14_fault-bus-9"
    assert record.station == "ieee14"
    assert record.trigger.isoformat() == "2026-10-05T09:00:00.300000"
    # ANDES steps onto the fault's instants, so the samples are not evenly
    # spaced and the record declares no rate: a reader goes by the time stamps.
    assert np.ptp(np.diff(t)) > 1e-3
    assert (record.nrates, record.rates) == (0, [(0.0, len(t))])
    assert np.abs(record.t - (t - t[0])).max() <= 0.5e-6

    assert [c.name for c in record.channels] == names
    assert [c.unit for c in record.channels] == [units[n] for n in names]
    for channel, series in zip(record.channels, traces["variables"], strict=True):
        returned = np.array(series["values"], dtype=np.float64)
        assert np.abs(channel.values - returned).max() <= channel.a / 2 * (1 + 1e-9)
    # And it is the fault: the voltage at bus 3 sags while it is on.
    voltage = record.channel("v Bus 3").values
    during = (record.t > FAULT_ON) & (record.t < FAULT_OFF)
    assert voltage[during].min() < 0.8 < voltage[0]
