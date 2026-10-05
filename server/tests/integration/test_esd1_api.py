"""An ESD1 battery through the element builder, on real ANDES.

Drives the app over an httpx ASGITransport with a real ``SessionManager`` and
worker subprocesses. ``tests/unit/test_esd1.py`` pins each refusal to its reason;
these check what the refusals rest on and what the UI help says: that a battery
added to a loaded case sets up and runs, that its state of charge follows the
megawatts it delivers over ``En`` whatever its ``Sn``, that its limits are per
unit of ``Sn`` while its set-point and output are per unit of the system base
(contract 12 in ``server/ANDES_VERSIONS.md``), and that an add ANDES would have
accepted and then failed on is refused and leaves nothing behind.

Markers: ``integration``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

KUNDUR = "kundur_full.xlsx"
# Where the battery goes in the Kundur system: a 230 kV bus with no generator.
BUS = 7
SOC = "pIG_y ESD1 1"
RECORD = [SOC, "Ipout_y ESD1 1", f"v Bus {BUS}"]


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for case in ("kundur/kundur_full.xlsx", "ieee14/ieee14.raw", "ieee14/ieee14_esd1.xlsx"):
        shutil.copy2(_cases() / case, workspace / Path(case).name)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=3,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=3, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _session(ac: httpx.AsyncClient, case: str) -> str:
    created = await ac.post("/api/sessions")
    assert created.status_code == 201, created.text
    sid = str(created.json()["session_id"])
    loaded = await ac.post(f"/api/sessions/{sid}/case", json={"primary_path": case})
    assert loaded.status_code == 200, loaded.text
    return sid


async def _add(ac: httpx.AsyncClient, sid: str, model: str, params: dict[str, Any]) -> httpx.Response:
    return await ac.post(f"/api/sessions/{sid}/elements", json={"model": model, "params": params})


async def _bus_voltage(ac: httpx.AsyncClient) -> float:
    """The voltage the battery's bus has before anything is added to it.

    A static generator that holds this voltage asks for next to no reactive
    power, so the battery that takes it over starts within its current limit.
    """
    sid = await _session(ac, KUNDUR)
    pf = await ac.post(f"/api/sessions/{sid}/pflow", json={})
    assert pf.status_code == 200, pf.text
    voltage = float(pf.json()["bus_voltages"][str(BUS)])
    await ac.delete(f"/api/sessions/{sid}")
    return voltage


async def _kundur_with_battery(
    ac: httpx.AsyncClient, *, p0: float = 0.2, **battery: Any
) -> tuple[str, httpx.Response]:
    """Kundur with a static generator on bus 7 and a battery that takes it over.

    Every reference is sent as text, the way the web form sends it; the case
    holds its bus idx as integers.
    """
    v0 = await _bus_voltage(ac)
    sid = await _session(ac, KUNDUR)
    anchor = await _add(
        ac,
        sid,
        "PV",
        {"idx": "PV_B", "name": "PV_B", "bus": str(BUS), "Sn": 100, "Vn": 230, "p0": p0, "v0": v0},
    )
    assert anchor.status_code == 201, anchor.text
    params = {
        "idx": "ESD1_1", "name": "ESD1_1", "bus": str(BUS), "gen": "PV_B",
        "pqflag": 1, "pmx": 1.0, "En": 10.0, **battery,
    }
    return sid, await _add(ac, sid, "ESD1", params)


async def _run(ac: httpx.AsyncClient, sid: str, tf: float) -> dict[str, np.ndarray]:
    """A batch run recording the state of charge and the battery's output.

    Returns ``t``, ``soc`` and ``p``, the delivered power in per unit on the
    system base (the active current times the bus voltage).
    """
    resp = await ac.post(f"/api/sessions/{sid}/tds", json={"tf": tf, "h": 0.01, "dae_vars": RECORD})
    assert resp.status_code == 200, resp.text
    traces = resp.json()["traces"]
    series = {v["name"]: np.array(v["values"]) for v in traces["variables"]}
    return {
        "t": np.array(traces["t"]),
        "soc": series[SOC],
        "p": series["Ipout_y ESD1 1"] * series[f"v Bus {BUS}"],
    }


def _settled(run: dict[str, np.ndarray], t_from: float, t_to: float) -> tuple[float, float]:
    """The delivered power and the rate of the state of charge over a window.

    Returns the mean power in per unit on the system base and the rate per
    hour, between two samples of a stretch in which the power is steady, so
    neither depends on how the steps around an event or at the end are spaced.
    """
    inside = np.flatnonzero((run["t"] >= t_from) & (run["t"] <= t_to))
    first, last = inside[0], inside[-1]
    power = float(run["p"][first : last + 1].mean())
    assert np.ptp(run["p"][first : last + 1]) < 2e-3, "the power is not steady in the window"
    hours = float(run["t"][last] - run["t"][first]) / 3600.0
    return power, float(run["soc"][last] - run["soc"][first]) / hours


# ---- the schema and the topology --------------------------------------------------------


async def test_the_schema_offers_esd1_with_its_two_links_as_pickers(
    client: httpx.AsyncClient,
) -> None:
    schema = (await client.get("/api/topology/schema")).json()["models"]
    esd1 = {p["name"]: p for p in schema["ESD1"]}
    assert esd1["bus"] == {"name": "bus", "kind": "bus_idx", "required": True, "unit": None}
    assert esd1["gen"] == {"name": "gen", "kind": "gen_idx", "required": True, "unit": None}
    assert esd1["Sn"] == {"name": "Sn", "kind": "number", "required": True, "unit": "MVA"}
    assert esd1["En"]["unit"] == "MWh" and esd1["En"]["required"] is True
    assert esd1["SOCinit"]["required"] is False


async def test_the_topology_reports_the_system_mva_base(client: httpx.AsyncClient) -> None:
    """On a load and on a plain read, and 100 for a blank system."""
    created = await client.post("/api/sessions")
    sid = str(created.json()["session_id"])
    loaded = await client.post(f"/api/sessions/{sid}/case", json={"primary_path": KUNDUR})
    assert loaded.json()["base_mva"] == 100.0
    assert (await client.get(f"/api/sessions/{sid}/topology")).json()["base_mva"] == 100.0

    blank = str((await client.post("/api/sessions")).json()["session_id"])
    made = await client.post(f"/api/sessions/{blank}/blank")
    assert made.status_code in (200, 201), made.text
    assert made.json()["topology"]["base_mva"] == 100.0


async def test_a_battery_added_to_a_loaded_case_is_listed_sets_up_and_solves(
    client: httpx.AsyncClient,
) -> None:
    sid, added = await _kundur_with_battery(client)
    assert added.status_code == 201, added.text
    element = added.json()["element"]
    assert element["kind"] == "ESD1"
    # The references are held as the case holds the devices they name.
    assert element["params"]["bus"] == BUS
    assert element["params"]["gen"] == "PV_B"
    # Left out, the rating is the system base, not ANDES's 100 MVA whatever the base.
    assert element["params"]["Sn"] == 100.0

    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert [(c["kind"], c["idx"]) for c in topology["controllers"] if c["kind"] == "ESD1"] == [
        ("ESD1", "ESD1_1")
    ]
    pf = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True


async def test_a_battery_on_the_system_base_draws_no_warning(client: httpx.AsyncClient) -> None:
    sid, added = await _kundur_with_battery(client)
    assert added.status_code == 201, added.text
    messages = (await client.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    assert [m for m in messages if m["logger"] == "tensa.notice"] == []


async def test_a_battery_on_another_base_is_accepted_and_warned_about(
    client: httpx.AsyncClient,
) -> None:
    sid, added = await _kundur_with_battery(client, Sn=50)
    assert added.status_code == 201, added.text
    assert added.json()["element"]["params"]["Sn"] == 50

    messages = (await client.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    (notice,) = [m for m in messages if m["logger"] == "tensa.notice"]
    assert notice["level"] == "warning"
    assert notice["source"] == "add_element"
    assert "ESD1 ESD1_1 has Sn = 50 MVA on a system base of 100 MVA" in notice["text"]

    # Putting the rating on the system base says nothing more; taking it off again does.
    fixed = await client.put(f"/api/sessions/{sid}/elements/ESD1/ESD1_1", json={"params": {"Sn": 100}})
    assert fixed.status_code == 200, fixed.text
    again = await client.put(f"/api/sessions/{sid}/elements/ESD1/ESD1_1", json={"params": {"Sn": 25}})
    assert again.status_code == 200, again.text
    messages = (await client.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    notices = [m["text"] for m in messages if m["logger"] == "tensa.notice"]
    assert len(notices) == 2
    assert "Sn = 25 MVA" in notices[1]


def test_a_battery_added_without_a_rating_gets_the_base_the_case_sets(tmp_path: Path) -> None:
    """Not ANDES's 100 MVA whatever the base: on a 250 MVA base that default
    would put the battery's limits and its set-point on two different bases."""
    data = json.loads((_cases() / "ieee14" / "ieee14.json").read_text(encoding="utf-8"))
    data["_config"] = [{"section": "System", "key": "mva", "value": 250.0}]
    case = tmp_path / "ieee14_250mva.json"
    case.write_text(json.dumps(data), encoding="utf-8")

    w = Wrapper()
    assert w.load_case(case).base_mva == 250.0
    ss = w._require_loaded()  # noqa: SLF001
    battery = w.add_element(
        "ESD1",
        {"idx": "ESD1_1", "name": "ESD1_1", "bus": ss.PV.bus.v[0], "gen": ss.PV.idx.v[0],
         "pqflag": 1, "pmx": 0.2, "En": 50.0},
    )
    assert battery.params["Sn"] == 250.0


# ---- what a run does with it ----------------------------------------------------------


async def test_the_state_of_charge_follows_the_delivered_megawatts_over_en(
    client: httpx.AsyncClient,
) -> None:
    """20 MW out of 10 MWh is 2 per hour, from the state of charge it was given."""
    sid, added = await _kundur_with_battery(client, p0=0.2, En=10.0, SOCinit=0.6)
    assert added.status_code == 201, added.text
    run = await _run(client, sid, tf=1.5)

    assert run["soc"][0] == pytest.approx(0.6, abs=1e-6)
    # It starts at the static generator's power-flow output and stays there.
    assert run["p"][0] == pytest.approx(0.2, abs=2e-3)
    power, rate = _settled(run, 0.3, 1.4)
    assert power == pytest.approx(0.2, abs=2e-3)
    assert rate == pytest.approx(-power * 100.0 / 10.0, rel=1e-3)
    assert rate == pytest.approx(-2.0, rel=1e-2)


async def test_a_negative_set_point_charges_it_at_the_charging_efficiency(
    client: httpx.AsyncClient,
) -> None:
    sid, added = await _kundur_with_battery(client, p0=-0.2, En=10.0, EtaC=0.8)
    assert added.status_code == 201, added.text
    run = await _run(client, sid, tf=1.5)

    power, rate = _settled(run, 0.3, 1.4)
    assert power == pytest.approx(-0.2, abs=2e-3)
    # 20 MW absorbed, of which 0.8 is stored: 1.6 per hour into 10 MWh.
    assert rate == pytest.approx(-0.8 * power * 100.0 / 10.0, rel=1e-3)
    assert rate == pytest.approx(1.6, rel=1e-2)


async def test_discharging_draws_the_delivered_power_over_the_discharging_efficiency(
    client: httpx.AsyncClient,
) -> None:
    sid, added = await _kundur_with_battery(client, p0=0.2, En=10.0, EtaD=0.8)
    assert added.status_code == 201, added.text
    run = await _run(client, sid, tf=1.5)

    power, rate = _settled(run, 0.3, 1.4)
    assert rate == pytest.approx(-power / 0.8 * 100.0 / 10.0, rel=1e-3)
    assert rate == pytest.approx(-2.5, rel=1e-2)


@pytest.mark.parametrize(("sn", "delivered"), [(100.0, 0.8), (50.0, 0.5)])
async def test_the_limit_is_per_unit_of_sn_and_the_set_point_per_unit_of_the_system_base(
    client: httpx.AsyncClient, sn: float, delivered: float
) -> None:
    """The caveat the UI help states, measured.

    The set-point is 0.2 pu on the system base (20 MW) whatever ``Sn`` is, and
    an Alter on ``Pext0`` adds 0.6 pu on the system base to it. ``pmx = 1`` is
    per unit of ``Sn``: 100 MW on a 100 MVA rating, which lets the 80 MW
    through, and 50 MW on a 50 MVA rating, which caps it at 0.5 pu. The state
    of charge follows the megawatts delivered in both.
    """
    sid, added = await _kundur_with_battery(client, Sn=sn, pmx=1.0, En=10.0)
    assert added.status_code == 201, added.text
    step = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "alter", "model": "ESD1", "dev_idx": "ESD1_1", "src": "Pext0",
                 "t": 0.5, "method": "=", "amount": 0.6}
            ]
        },
    )
    assert step.status_code in (200, 201), step.text
    run = await _run(client, sid, tf=1.5)

    before, rate_before = _settled(run, 0.1, 0.45)
    assert before == pytest.approx(0.2, abs=2e-3)
    assert rate_before == pytest.approx(-before * 100.0 / 10.0, rel=1e-3)
    after, rate_after = _settled(run, 1.0, 1.4)
    assert after == pytest.approx(delivered, abs=2e-3)
    assert rate_after == pytest.approx(-after * 100.0 / 10.0, rel=1e-3)


async def _initialization_failed(ac: httpx.AsyncClient, sid: str) -> bool:
    """Whether a short run of the session logged that its dynamics did not initialize."""
    run = await ac.post(f"/api/sessions/{sid}/tds", json={"tf": 0.1})
    assert run.status_code == 200, run.text
    messages = (await ac.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    return any(m["level"] == "error" and "Initialization FAILED" in m["text"] for m in messages)


async def test_a_battery_on_a_generator_a_machine_takes_over_does_not_initialize(
    client: httpx.AsyncClient,
) -> None:
    """What the web form warns about under ``gen``, measured.

    The add is accepted: a case may share a static generator between devices
    whose ``gammap`` and ``gammaq`` add up to 1, as ``ieee14_esd1.xlsx`` does.
    Left at their defaults the machine and the battery each start at the
    generator's whole output, which is not the operating point the power flow
    solved, and the run says so. A battery on a generator of its own starts
    clean.
    """
    sid = await _session(client, KUNDUR)
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    machine = next(g for g in topology["generators"] if g["kind"] == "GENROU")
    shared = {
        "idx": "ESD1_1", "name": "ESD1_1", "bus": str(machine["params"]["bus"]),
        "gen": str(machine["params"]["gen"]), "pqflag": 1, "pmx": 1.0, "En": 10.0,
    }
    added = await _add(client, sid, "ESD1", shared)
    assert added.status_code == 201, added.text
    assert await _initialization_failed(client, sid)
    await client.delete(f"/api/sessions/{sid}")

    own, added = await _kundur_with_battery(client)
    assert added.status_code == 201, added.text
    assert not await _initialization_failed(client, own)


async def test_the_power_set_points_are_offered_as_alter_sources(client: httpx.AsyncClient) -> None:
    sid, added = await _kundur_with_battery(client)
    assert added.status_code == 201, added.text
    resp = await client.get(f"/api/sessions/{sid}/topology/models/ESD1/alterable_params")
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    assert params[-2:] == ["pref0", "Pext0"]
    assert "pmx" in params


# ---- what is refused, and what a refusal leaves ---------------------------------------


@pytest.mark.parametrize(
    ("changes", "says"),
    [
        ({"En": 0}, "En must be above zero"),
        ({"EtaD": 0}, "EtaD must be above 0 and at most 1"),
        ({"Tf": 0}, "Tf must be above zero"),
        ({"pqflag": 2}, "pqflag must be 0"),
        ({"SOCinit": 1.5}, "SOCinit must lie between SOCmin and SOCmax"),
        ({"fn": 50}, "outside ft1 to ft2"),
        ({"gen": "NOPE"}, "names no static generator"),
        ({"gen": "1"}, "must be on the same bus"),
        ({"bus": "99"}, "names no bus"),
    ],
)
async def test_an_add_a_run_could_not_use_is_refused_and_leaves_nothing(
    client: httpx.AsyncClient, changes: dict[str, Any], says: str
) -> None:
    sid, refused = await _kundur_with_battery(client, **changes)
    assert refused.status_code == 422, refused.text
    assert says in refused.json()["detail"]

    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert [c for c in topology["controllers"] if c["kind"] == "ESD1"] == []


async def test_an_add_without_a_mandatory_param_is_refused_before_andes_half_adds_it(
    client: httpx.AsyncClient,
) -> None:
    """ANDES counts a device in before it reads its params, so its own refusal
    of a missing ``pqflag`` left the idx on the model with param lists one
    short: the next add of that idx made a second device, and the time-domain
    run failed on the mismatched lists."""
    sid, added = await _kundur_with_battery(client)
    assert added.status_code == 201, added.text
    refused = await _add(
        client, sid, "ESD1",
        {"idx": "ESD1_2", "name": "ESD1_2", "bus": str(BUS), "gen": "PV_B", "pmx": 1.0, "En": 5.0},
    )
    assert refused.status_code == 422, refused.text
    assert "ESD1 cannot be added without pqflag" in refused.json()["detail"]

    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert [c["idx"] for c in topology["controllers"] if c["kind"] == "ESD1"] == ["ESD1_1"]
    pf = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True


async def test_an_edit_a_run_could_not_use_is_refused_and_writes_nothing(
    client: httpx.AsyncClient,
) -> None:
    sid, added = await _kundur_with_battery(client, SOCmax=0.9)
    assert added.status_code == 201, added.text
    for params, says in [
        ({"En": 0}, "En must be above zero"),
        ({"SOCinit": 0.95}, "SOCinit must lie between SOCmin and SOCmax"),
        ({"En": 20, "EtaD": 0}, "EtaD must be above 0"),
        ({"gen": "1"}, "must be on the same bus"),
    ]:
        refused = await client.put(f"/api/sessions/{sid}/elements/ESD1/ESD1_1", json={"params": params})
        assert refused.status_code == 422, refused.text
        assert says in refused.json()["detail"]

    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    (battery,) = [c for c in topology["controllers"] if c["kind"] == "ESD1"]
    assert battery["params"]["En"] == 10.0
    assert battery["params"]["SOCinit"] == 0.5
    assert battery["params"]["gen"] == "PV_B"

    accepted = await client.put(
        f"/api/sessions/{sid}/elements/ESD1/ESD1_1", json={"params": {"En": 20, "SOCinit": 0.8}}
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["params"]["En"] == 20


async def test_deleting_the_bus_names_the_battery_on_it(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "ieee14.raw")
    for model, params in [
        ("Bus", {"idx": "15", "name": "B15", "Vn": 69}),
        ("Line", {"idx": "L_15", "name": "L_15", "bus1": "5", "bus2": "15", "r": 0.01, "x": 0.05}),
        ("PV", {"idx": "PV_15", "name": "PV_15", "bus": "15", "Sn": 100, "Vn": 69, "p0": 0.1, "v0": 1.0}),
        ("ESD1", {"idx": "ESD1_1", "name": "ESD1_1", "bus": "15", "gen": "PV_15",
                  "pqflag": 1, "pmx": 1.0, "En": 5.0}),
    ]:
        added = await _add(client, sid, model, params)
        assert added.status_code == 201, added.text

    blocked = await client.delete(f"/api/sessions/{sid}/elements/Bus/15")
    assert blocked.status_code == 422, blocked.text
    assert ("ESD1", "ESD1_1") in {(d["kind"], d["idx"]) for d in blocked.json()["dependents"]}


# ---- a battery the case file holds, changed after setup --------------------------------


async def test_a_case_files_battery_is_listed_and_can_be_changed_through_the_clone(
    client: httpx.AsyncClient,
) -> None:
    """ANDES's bundled case has ten batteries of 1 MVA on a 100 MVA base."""
    sid = await _session(client, "ieee14_esd1.xlsx")
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    batteries = [c for c in topology["controllers"] if c["kind"] == "ESD1"]
    assert len(batteries) == 10
    assert {b["params"]["Sn"] for b in batteries} == {1}
    idx = str(batteries[0]["idx"])
    # A case that rates its batteries off the system base loads without comment.
    messages = (await client.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    assert [m for m in messages if m["logger"] == "tensa.notice"] == []

    edited = await client.put(
        f"/api/sessions/{sid}/case/clone/params/ESD1/{idx}/SOCinit", json={"value": 0.8}
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["new_value"] == pytest.approx(0.8)

    # The same checks as an add: the file would take either value.
    for param, value, says in [
        ("SOCinit", 1.5, "SOCinit must lie between SOCmin and SOCmax"),
        ("Tf", 0, "Tf must be above zero"),
    ]:
        refused = await client.put(
            f"/api/sessions/{sid}/case/clone/params/ESD1/{idx}/{param}", json={"value": value}
        )
        assert refused.status_code == 422, refused.text
        assert says in refused.json()["detail"]
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    (battery,) = [c for c in topology["controllers"] if str(c["idx"]) == idx and c["kind"] == "ESD1"]
    assert battery["params"]["SOCinit"] == pytest.approx(0.8)
    assert battery["params"]["Tf"] == 1
