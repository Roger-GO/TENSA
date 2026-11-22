"""The settings of ANDES's continuation routine, through ``POST /sessions/{id}/cpf``.

A request can set the routine's ``parameterization``, its corrector's tolerance
(``tol``) and Newton iterations per step (``corrector_max_iter``), the bounds of
its adaptive step (``step_min``, ``step_max``), and a target lambda in
``stop_at``; the response carries the bus angles and the settings the run used
(``tensa.core.cpf_options``). Each setting is shown here to change the path on
IEEE 14 against the same request without it, and to leave the nose where it is
where it should not move it. The nose of the plain run is at lambda 3.258046
after 16 steps; the numbers each test holds are from ANDES 2.0.0.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration

# The nose of the plain run on IEEE 14.
NOSE = 3.258046

# How far a setting that only changes how finely the curve is drawn may move the
# nose: the corrector solves to 1e-6 and the routine calls a fall in lambda of
# 1e-8 the nose, so the nose moves by less than the last step around it.
SAME_NOSE = 1e-4

SETTINGS = ("parameterization", "tol", "corrector_max_iter", "step_min", "step_max")


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    pytest.importorskip("andes")
    import andes

    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    shutil.copy2(Path(andes.get_case("ieee14/ieee14.raw")), workspace / "ieee14.raw")
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
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


async def _solved(client: httpx.AsyncClient) -> str:
    sid = str((await client.post("/api/sessions")).json()["session_id"])
    loaded = await client.post(f"/api/sessions/{sid}/case", json={"primary_path": "ieee14.raw"})
    assert loaded.status_code == 200, loaded.text
    pf = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pf.status_code == 200 and pf.json()["converged"] is True, pf.text
    return sid


async def _cpf(client: httpx.AsyncClient, sid: str, **body: Any) -> dict[str, Any]:
    resp = await client.post(f"/api/sessions/{sid}/cpf", json=body)
    assert resp.status_code == 200, resp.text
    result: dict[str, Any] = resp.json()
    return result


def _differ(a: list[float], b: list[float]) -> bool:
    return len(a) != len(b) or any(abs(x - y) > 1e-9 for x, y in zip(a, b, strict=True))


async def test_a_plain_request_reports_no_settings_and_is_what_it_was(
    client: httpx.AsyncClient,
) -> None:
    """A request that names none of the settings runs as before (the nose and
    its 18 points), reports none of them, and a run with every one of them set
    leaves nothing behind for the plain request that follows."""
    sid = await _solved(client)
    plain = await _cpf(client, sid)
    for name in (*SETTINGS, "stop_at_lambda"):
        assert plain[name] is None, name
    assert plain["stop_at"] == "nose" and plain["complete"] is True
    assert plain["max_lam"] == pytest.approx(NOSE, abs=1e-6)
    assert len(plain["lambdas"]) == 18 and plain["nose_idx"] == 16

    await _cpf(
        client,
        sid,
        parameterization="natural",
        stop_at=1.5,
        tol=1e-4,
        corrector_max_iter=3,
        step_min=1e-2,
        step_max=0.05,
    )
    again = await _cpf(client, sid)
    assert again["lambdas"] == plain["lambdas"]
    assert again["voltages_per_bus"] == plain["voltages_per_bus"]
    assert again["angles_per_bus"] == plain["angles_per_bus"]
    assert again["done_msg"] == plain["done_msg"]


async def test_every_setting_is_echoed_and_a_target_below_the_nose_is_landed_on(
    client: httpx.AsyncClient,
) -> None:
    sid = await _solved(client)
    body = {
        "parameterization": "arclength",
        "stop_at": 0.3,
        "tol": 1e-5,
        "corrector_max_iter": 30,
        "step_min": 1e-3,
        "step_max": 0.2,
    }
    result = await _cpf(client, sid, **body)
    assert {name: result[name] for name in SETTINGS} == {
        name: body[name] for name in SETTINGS
    }
    assert result["stop_at_lambda"] == 0.3 and result["stop_at"] == "nose"
    # It stops at the target, lambda held on it, far short of the nose.
    assert result["lambdas"][-1] == pytest.approx(0.3, abs=1e-9)
    assert max(result["lambdas"]) == pytest.approx(0.3, abs=1e-9)
    assert result["max_lam"] == pytest.approx(0.3, abs=1e-9)
    assert result["done_msg"] == "Reached target lambda=0.3"
    # Where it was asked to end, with no nose on the way.
    assert result["complete"] is True
    assert result["truncated"] is True and result["nose_idx"] == -1


async def test_a_target_past_the_nose_ends_the_run_at_the_nose(
    client: httpx.AsyncClient,
) -> None:
    """ANDES alone takes a target it never crosses down the lower branch, past
    lambda 0 to -10.3 in 98 points, and reports the corrector failing there."""
    sid = await _solved(client)
    plain = await _cpf(client, sid)
    beyond = await _cpf(client, sid, stop_at=3.5)
    assert beyond["lambdas"] == pytest.approx(plain["lambdas"], abs=1e-12)
    assert beyond["nose_idx"] == plain["nose_idx"]
    assert beyond["max_lam"] == pytest.approx(NOSE, abs=1e-6)
    assert min(beyond["lambdas"]) >= 0.0
    assert beyond["truncated"] is False and beyond["complete"] is False
    assert beyond["done_msg"] == "Nose point at lambda=3.258046, short of the target lambda=3.5"
    assert beyond["stop_at_lambda"] == 3.5


async def test_the_parameterization_reaches_the_routine(client: httpx.AsyncClient) -> None:
    sid = await _solved(client)
    plain = await _cpf(client, sid)
    natural = await _cpf(client, sid, parameterization="natural")
    arclength = await _cpf(client, sid, parameterization="arclength")
    assert natural["parameterization"] == "natural"
    assert arclength["parameterization"] == "arclength"

    # Natural fixes lambda, which cannot pass the nose: the routine creeps up to
    # it by halving the step (41 points against 18) and keeps none past it.
    assert len(natural["lambdas"]) > 2 * len(plain["lambdas"])
    lams = natural["lambdas"]
    assert all(b >= a for a, b in zip(lams, lams[1:], strict=False))
    assert natural["nose_idx"] == len(lams) - 1
    # Arc length goes round the nose as pseudo arc length does, by other points.
    assert _differ(arclength["lambdas"], plain["lambdas"])
    assert arclength["lambdas"][-1] < arclength["max_lam"]
    for result in (natural, arclength):
        assert result["complete"] is True and result["truncated"] is False
        assert result["max_lam"] == pytest.approx(plain["max_lam"], abs=SAME_NOSE)


async def test_the_step_bounds_reach_the_routine(client: httpx.AsyncClient) -> None:
    sid = await _solved(client)
    plain = await _cpf(client, sid)
    # A shorter longest step draws the curve with many more points (145).
    fine = await _cpf(client, sid, step_max=0.05)
    assert fine["step_max"] == 0.05
    assert len(fine["lambdas"]) > 5 * len(plain["lambdas"])
    assert fine["max_lam"] == pytest.approx(plain["max_lam"], abs=SAME_NOSE)
    # The smallest step is where the routine stops looking for a nose it can
    # only reach by halving: with natural parameterization a larger one ends
    # the search sooner, and lower (3.25552 against 3.25796).
    natural = await _cpf(client, sid, parameterization="natural")
    coarse = await _cpf(client, sid, parameterization="natural", step_min=1e-2)
    assert coarse["step_min"] == 1e-2
    assert len(coarse["lambdas"]) < len(natural["lambdas"])
    assert natural["max_lam"] - coarse["max_lam"] > 1e-3


async def test_the_corrector_settings_reach_the_routine(client: httpx.AsyncClient) -> None:
    sid = await _solved(client)
    plain = await _cpf(client, sid)
    # Two Newton iterations a step are too few for the routine's long steps,
    # which fail and are halved: the same nose by 43 points.
    short = await _cpf(client, sid, corrector_max_iter=2)
    assert short["corrector_max_iter"] == 2
    assert len(short["lambdas"]) > 2 * len(plain["lambdas"])
    assert short["max_lam"] == pytest.approx(plain["max_lam"], abs=SAME_NOSE)
    # A looser tolerance accepts the points sooner, and they move.
    loose = await _cpf(client, sid, tol=1e-4)
    assert loose["tol"] == 1e-4
    assert _differ(loose["lambdas"], plain["lambdas"])
    assert loose["max_lam"] == pytest.approx(plain["max_lam"], abs=SAME_NOSE)


async def test_the_angles_are_read_at_every_step(client: httpx.AsyncClient) -> None:
    sid = await _solved(client)
    for body in ({}, {"stop_at": "full"}):
        result = await _cpf(client, sid, **body)
        angles, voltages = result["angles_per_bus"], result["voltages_per_bus"]
        assert set(angles) == set(voltages) and len(angles) == 14
        assert all(len(row) == len(result["lambdas"]) for row in angles.values())
        # The slack bus is the reference; the far end of the system swings away
        # from it as the load grows.
        assert max(abs(a) for a in angles["1"]) < 1e-9
        nose = result["nose_idx"]
        assert angles["14"][nose] < angles["14"][0] - 0.3


async def test_qv_carries_no_angles_and_no_settings(client: httpx.AsyncClient) -> None:
    sid = await _solved(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf/qv", json={"bus_idx": "5"})
    assert resp.status_code == 200, resp.text
    qv = resp.json()
    assert qv["mode"] == "qv" and qv["angles_per_bus"] == {}
    assert all(qv[name] is None for name in (*SETTINGS, "stop_at_lambda"))


@pytest.mark.parametrize(
    "body",
    [
        {"step_min": 0.3, "step_max": 0.2},
        {"stop_at": -0.5},
        {"stop_at": 0},
        {"stop_at": "0.3"},
        {"parameterization": "arc"},
        {"parameterization": "natural", "stop_at": "full"},
        {"tol": 1e-3},
        {"corrector_max_iter": 1},
    ],
)
async def test_a_setting_the_routine_cannot_run_with_is_refused(
    client: httpx.AsyncClient, body: dict[str, Any]
) -> None:
    sid = await _solved(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf", json=body)
    assert resp.status_code == 422, resp.text


async def test_a_step_bound_beyond_the_cases_other_one_is_refused_by_the_wrapper(
    client: httpx.AsyncClient,
) -> None:
    """The body cannot know the case's step bounds; the wrapper refuses a
    ``step_min`` above the case's ``step_max`` of 0.5 before writing anything."""
    sid = await _solved(client)
    resp = await client.post(f"/api/sessions/{sid}/cpf", json={"step_min": 0.6})
    assert resp.status_code == 422, resp.text
    assert "step_max (0.5, the case's)" in resp.text
    assert (await _cpf(client, sid))["max_lam"] == pytest.approx(NOSE, abs=1e-6)
