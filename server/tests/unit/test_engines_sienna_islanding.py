"""Unit tests for the islanding check of ``engines/sienna/disturbances.py``.

The topologies are dicts in the shape of the topology JSON the state holds
(``buses`` with ``number``, ``branches`` with ``from``, ``to``, ``ckt`` and
``available``). The expected cut-off sets are worked out by hand in each
test's comment, never by calling the code under test twice.
"""

from __future__ import annotations

from typing import Any

from tensa.engines.sienna.disturbances import islanded_buses, islanding_refusal


def _topology(
    buses: list[int], branches: list[tuple[int, int, str, bool]]
) -> dict[str, Any]:
    """A topology JSON dict: one bus row per number, one branch row per
    ``(from, to, ckt, available)`` tuple."""
    return {
        "buses": [{"number": bus} for bus in buses],
        "branches": [
            {"from": from_bus, "to": to_bus, "ckt": ckt, "available": available}
            for from_bus, to_bus, ckt, available in branches
        ],
    }


def test_a_radial_feeder_trip_cuts_off_the_fed_bus() -> None:
    # 1 - 2 - 3, one line each. Tripping 2-3 leaves components [1, 2] and [3];
    # the smaller side is bus 3 alone.
    topology = _topology(
        [1, 2, 3], [(1, 2, "1", True), (2, 3, "1", True)]
    )
    assert islanded_buses(topology, {"branch:2-3-1"}) == [3]
    # Tripping 1-2 instead leaves [1] and [2, 3]; the largest component is
    # [2, 3], so the bus cut off it is bus 1 alone.
    assert islanded_buses(topology, {"branch:1-2-1"}) == [1]
    assert islanded_buses(topology, set()) == []


def test_parallel_circuits_trip_one_then_both() -> None:
    # Two circuits 1-2 ("1" and "2"). One trip leaves 1 and 2 joined by the
    # other circuit: nothing is cut off. Both trips leave [1] and [2]; the
    # smaller side (a tie, broken by the smaller bus number) is bus 2.
    topology = _topology([1, 2], [(1, 2, "1", True), (1, 2, "2", True)])
    assert islanded_buses(topology, {"branch:1-2-1"}) == []
    assert islanded_buses(topology, {"branch:1-2-1", "branch:1-2-2"}) == [2]


def test_a_ring_trips_one_line_then_a_second() -> None:
    # Ring 1-2-3-1. One trip leaves a path around the ring: nothing is cut
    # off. A second trip (1-2 and 2-3) leaves [1, 3] and [2]: bus 2 alone.
    topology = _topology(
        [1, 2, 3], [(1, 2, "1", True), (2, 3, "1", True), (3, 1, "1", True)]
    )
    assert islanded_buses(topology, {"branch:1-2-1"}) == []
    assert islanded_buses(topology, {"branch:1-2-1", "branch:2-3-1"}) == [2]


def test_an_unavailable_branch_connects_nothing() -> None:
    # 1 - 2 with the line out of service, and 2 - 3 in service: the network is
    # already split into [1] and [2, 3]. Tripping 2-3 leaves [1], [2] and
    # [3]; the largest component is [1] (a tie of one bus each, broken by the
    # smallest bus number), so buses 2 and 3 are cut off it.
    topology = _topology(
        [1, 2, 3], [(1, 2, "1", False), (2, 3, "1", True)]
    )
    # With no trip the largest component is [2, 3]; bus 1 is cut off already.
    assert islanded_buses(topology, set()) == [1]
    assert islanded_buses(topology, {"branch:2-3-1"}) == [2, 3]


def test_a_case_already_split_refuses_nothing_more() -> None:
    # Two islands in the file: 1 - 2 and 3 - 4. Tripping 1-2 splits [1, 2]
    # into [1] and [2], but the network had two components before and has
    # three after; the refusal comparison is against the pending trips alone,
    # so islanding_refusal answers None only when the count does not grow.
    # Here the count grows (2 to 3), so the trip is refused: the check keeps a
    # case already split from being refused for that, not from new splits.
    topology = _topology(
        [1, 2, 3, 4], [(1, 2, "1", True), (3, 4, "1", True)]
    )
    assert islanding_refusal(topology, set(), "branch:1-2-1") is not None
    # A trip that changes nothing (an unavailable branch) is not refused.
    topology_out = _topology(
        [1, 2, 3, 4], [(1, 2, "1", False), (3, 4, "1", True)]
    )
    assert islanding_refusal(topology_out, set(), "branch:1-2-1") is None


def test_trips_accumulate_in_the_refusal() -> None:
    # Ring 1-2-3-1 with the first trip pending: the second is refused, naming
    # the bus it cuts off.
    topology = _topology(
        [1, 2, 3], [(1, 2, "1", True), (2, 3, "1", True), (3, 1, "1", True)]
    )
    message = islanding_refusal(topology, {"branch:1-2-1"}, "branch:2-3-1")
    assert message is not None
    assert "branch:2-3-1" in message
    assert "buses 2 lose their connection" in message
    assert "PowerSimulationsDynamics cannot simulate a network that splits" in message
    assert "refuses it before the run" in message


def test_the_message_lists_at_most_ten_buses() -> None:
    # A star: bus 1 feeds buses 2 to 13, each by its own line, and bus 13 is
    # also fed by bus 14. Tripping 1-13 leaves 13 fed by 14, so nothing is cut
    # off; tripping every line from 1 cuts off buses 2 to 14 (13 buses). The
    # message lists the first ten and says "and 3 more".
    branches = [(1, bus, "1", True) for bus in range(2, 14)]
    branches.append((13, 14, "1", True))
    topology = _topology(list(range(1, 15)), branches)
    tripped = {f"branch:1-{bus}-1" for bus in range(2, 14)}
    # Hand computation: with every line from 1 tripped, the components are
    # [1], [2], ..., [12], [13, 14]; the largest is [13, 14] (2 buses), so the
    # buses cut off it are 1 to 12.
    assert islanded_buses(topology, tripped) == list(range(1, 13))
    # For the refusal message, build a feeder of 12 buses cut off at once:
    # bus 1 hangs off bus 2 by one line, and 2..13 are meshed among themselves
    # and fed by bus 14. Tripping 1-2 leaves [1] and [2..14]; the smallest new
    # component is [1], so the message names bus 1 alone.
    mesh = [(1, 2, "1", True)]
    mesh += [(bus, bus + 1, "1", True) for bus in range(2, 13)]
    mesh.append((2, 13, "2", True))
    mesh.append((13, 14, "1", True))
    chain = _topology(list(range(1, 15)), mesh)
    message = islanding_refusal(chain, set(), "branch:1-2-1")
    assert message is not None
    assert "buses 1 lose their connection" in message
    # The same feeder the other way round: bus 14 hangs off bus 13 by one
    # line, and tripping 13-14 cuts bus 14 off the 13-bus component.
    message = islanding_refusal(chain, set(), "branch:13-14-1")
    assert message is not None
    assert "buses 14 lose their connection" in message
    # A feeder of 12 buses cut off at once, for the "and N more" cut: bus 1
    # feeds 2..13 in a chain through one line 1-2, and buses 14..25 hang off
    # bus 1 on the kept side. Tripping 1-2 leaves [1, 14..25] (13 buses) and
    # [2..13] (12 buses); the network had one component before, and the
    # smallest component after is the cut-off side [2..13]: ten listed, then
    # "and 2 more".
    lone = [(1, 2, "1", True)]
    lone += [(bus, bus + 1, "1", True) for bus in range(2, 13)]
    lone += [(1, bus, "1", True) for bus in range(14, 26)]
    feeder = _topology(list(range(1, 26)), lone)
    message = islanding_refusal(feeder, set(), "branch:1-2-1")
    assert message is not None
    assert "buses 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 2 more" in message
    assert "12" not in message.split("and 2 more")[0].split("buses ")[1]


def test_a_trip_key_the_topology_does_not_hold_changes_nothing() -> None:
    topology = _topology([1, 2], [(1, 2, "1", True)])
    assert islanded_buses(topology, {"branch:9-9-9"}) == []
    assert islanding_refusal(topology, set(), "branch:9-9-9") is None
    # A key that does not parse is ignored the same way.
    assert islanded_buses(topology, {"not-a-branch"}) == []
