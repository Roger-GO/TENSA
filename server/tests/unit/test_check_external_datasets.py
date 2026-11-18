"""``scripts/check_external_datasets.py``: what it downloads, how it holds a file to its record,
what it reads from the files and what it says of them.

The downloads are held to the table of trials (the files, their sizes and checksums, what each
trial's catalog entry says it shows), to a download that is a fake, and to archives built here.
No server is started and nothing is downloaded: ``tests/acceptance`` does not run this script
either, since it needs the network and the sources can change. The tests skip when run away
from a checkout.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import re
import sys
import zipfile
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tensa.core.example_catalog import load_catalog
from tests._repo import SCRIPTS_DIR

pytestmark = pytest.mark.unit


@pytest.fixture(scope="module")
def script() -> Iterator[ModuleType]:
    # Not ``load_module``: a dataclass of a module that is not in ``sys.modules`` cannot read
    # its own annotations, and this script has dataclasses.
    path = SCRIPTS_DIR / "check_external_datasets.py"
    if not path.is_file():
        pytest.skip("scripts/check_external_datasets.py is not next to the tests")
    name = "check_external_datasets_under_test"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop(name, None)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _zip(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buffer.getvalue()


# ---- the table of trials ---------------------------------------------------------------------


def test_the_trials_have_unique_keys_and_name_the_files_they_open(script: ModuleType) -> None:
    keys = [trial.key for trial in script.TRIALS]
    assert len(keys) == len(set(keys))
    for trial in script.TRIALS:
        names = [part.name for part in trial.parts]
        assert len(names) == len(set(names)), trial.key
        assert trial.primary in names, trial.key
        assert set(trial.companions) <= set(names), trial.key
        assert trial.primary not in trial.companions, trial.key


def test_every_part_is_held_to_a_size_and_a_checksum_and_an_archive_member_to_its_own(
    script: ModuleType,
) -> None:
    for trial in script.TRIALS:
        for part in trial.parts:
            assert part.size > 0 and len(part.sha256) == 64, (trial.key, part.name)
            assert (part.member is None) == (part.member_sha256 is None), (trial.key, part.name)
            assert part.url.startswith("https://"), (trial.key, part.name)
            assert part.size <= script.MAX_DOWNLOAD, (trial.key, part.name)
    # Two members of one archive are one download: the same size and checksum.
    by_url: dict[str, set[tuple[int, str]]] = {}
    for trial in script.TRIALS:
        for part in trial.parts:
            by_url.setdefault(part.url, set()).add((part.size, part.sha256))
    assert all(len(record) == 1 for record in by_url.values())


def test_every_trial_belongs_to_a_link_only_entry_of_the_catalog(script: ModuleType) -> None:
    catalog = load_catalog()
    for trial in script.TRIALS:
        entry = catalog.get(trial.entry)
        assert entry is not None, f"{trial.key}: no entry {trial.entry!r} in the catalog"
        assert not entry.has_file, f"{trial.key}: {trial.entry!r} has a file of its own"


def test_the_checksums_the_entries_quote_are_those_the_script_holds_the_downloads_to(
    script: ModuleType,
) -> None:
    """A checksum written in an entry (whole, or its first eight digits) is one of a file the
    script downloads, so the entry names the file that was tried and no other."""
    # The commit of the Sienna repository is in the entries too, in the same hexadecimal.
    recorded: set[str] = set(re.findall(r"[0-9a-f]{40}", script._SIENNA))
    for trial in script.TRIALS:
        for part in trial.parts:
            recorded |= {part.sha256, part.member_sha256 or part.sha256}
    quoted = 0
    catalog = load_catalog()
    for trial in script.TRIALS:
        entry = catalog.get(trial.entry)
        assert entry is not None
        text = " ".join([*entry.caveats, *(c.text for c in entry.citations)])
        for found in re.findall(r"\b[0-9a-f]{8,64}\b", text):
            assert any(sha.startswith(found) for sha in recorded), (entry.id, found)
            quoted += 1
    assert quoted >= 8


def test_a_trial_whose_run_is_expected_not_to_complete_belongs_to_an_entry_that_says_how_it_ends(
    script: ModuleType,
) -> None:
    """The entry says what the run did, in words that differ with what it did: a run the server
    refuses does not start, and one that reaches its end time and is reported failed does not
    (the two are different findings about ANDES, and the table tells them apart)."""
    catalog = load_catalog()
    said = {"refused": "does not start", "fails": "is reported failed"}
    seen: set[str] = set()
    for trial in script.TRIALS:
        if trial.expect.tds is None or trial.expect.tds == "completes":
            continue
        entry = catalog.get(trial.entry)
        assert entry is not None and "tds" not in entry.analyses, trial.key
        assert trial.expect.tds in said, trial.key
        assert any(said[trial.expect.tds] in caveat for caveat in entry.caveats), trial.key
        other = said["fails" if trial.expect.tds == "refused" else "refused"]
        assert not any(other in caveat for caveat in entry.caveats), trial.key
        seen.add(trial.expect.tds)
    assert seen == {"refused", "fails"}


def test_the_expected_outcomes_hang_together(script: ModuleType) -> None:
    for trial in script.TRIALS:
        expect = trial.expect
        if expect.opens:
            assert trial.companions or expect.tds is None, trial.key
            assert expect.static_opens is None, trial.key
        if expect.pf is not None:
            assert expect.opens or expect.static_opens, trial.key
        if expect.tds is not None:
            assert expect.opens and expect.pf, trial.key
        # A power flow that did not converge has no state to hold to a reference's.
        if expect.stored is not None or expect.solver in {"inside", "outside"}:
            assert expect.pf, trial.key
        # The models are those of a dynamic data file the trial has.
        if expect.approximated is not None or expect.unsupported is not None:
            assert any(part.name.endswith(".dyr") for part in trial.parts), trial.key
        for models in (expect.approximated, expect.unsupported):
            assert all(n > 0 for n in (models or {}).values()), trial.key
        assert not set(expect.approximated or {}) & set(expect.unsupported or {}), trial.key


def test_what_a_trial_expects_of_the_comparisons_is_what_its_entry_records_as_checks(
    script: ModuleType,
) -> None:
    """Each check an entry records, passed or failed, is held by a trial of the entry: a
    comparison that flips (the stored state of ACTIVSg2000 now reproduced, pandapower's
    solution now off) is a MISMATCH and not a quiet change of the result."""
    catalog = load_catalog()
    held = {"stored-solution": "stored", "independent-solver": "solver"}
    for entry_id in {trial.entry for trial in script.TRIALS}:
        entry = catalog.get(entry_id)
        assert entry is not None and entry.verification is not None
        trials = [t for t in script.TRIALS if t.entry == entry_id]
        for check in entry.verification.checks:
            field = held[check.kind]
            wanted = "inside" if check.passed else "outside"
            assert any(getattr(t.expect, field) == wanted for t in trials), (entry_id, check.name)
    # No entry says its own check outcome other than as the trials expect it.
    for trial in script.TRIALS:
        entry = catalog.get(trial.entry)
        assert entry is not None and entry.verification is not None
        kinds = {c.kind: c.passed for c in entry.verification.checks}
        if trial.expect.stored == "outside":
            assert kinds.get("stored-solution") is False, trial.key


def test_a_reference_that_gives_no_solution_is_said_so_in_the_entry(script: ModuleType) -> None:
    catalog = load_catalog()
    for trial in script.TRIALS:
        if trial.expect.solver != "none":
            continue
        entry = catalog.get(trial.entry)
        assert entry is not None
        text = " ".join(entry.caveats).lower()
        assert "no independent solver" in text or "pandapower does not solve" in text, trial.key


def test_the_models_a_trial_expects_are_named_in_its_entry(script: ModuleType) -> None:
    catalog = load_catalog()
    for trial in script.TRIALS:
        entry = catalog.get(trial.entry)
        assert entry is not None
        text = " ".join(entry.caveats)
        for models in (trial.expect.approximated, trial.expect.unsupported):
            for model, records in (models or {}).items():
                assert model in text, (trial.key, model)
                assert records > 0
    # ACTIVSg2000: the entry's total of the records read as another model is the table's.
    activsg = next(t for t in script.TRIALS if t.key == "activsg2000-dyn")
    entry = catalog.get("activsg2000_dyn")
    assert entry is not None and activsg.expect.approximated is not None
    assert f"{sum(activsg.expect.approximated.values())} as another model" in " ".join(
        entry.caveats
    )
    assert activsg.expect.unsupported == {} and "Nothing is dropped" in " ".join(entry.caveats)


def test_the_keys_are_chosen_or_all_run_and_an_unknown_one_is_an_error(script: ModuleType) -> None:
    assert [t.key for t in script.select_trials([])] == script.trial_keys()
    assert [t.key for t in script.select_trials(["nordic", "wecc240"])] == ["nordic", "wecc240"]
    with pytest.raises(ValueError, match="unknown trial no-such.*the trials are wecc240"):
        script.select_trials(["no-such"])


# ---- downloading ----------------------------------------------------------------------------


def _part(script: ModuleType, data: bytes, **kwargs: Any) -> Any:
    return script.Part("x.raw", "https://example.org/x", len(data), _sha(data), **kwargs)


def test_a_download_that_is_the_one_recorded_is_returned(script: ModuleType) -> None:
    data = b"0, 100.0, 33\n"
    assert script.fetch(_part(script, data), None, download=lambda url: data) == data


@pytest.mark.parametrize("change", ["longer", "other bytes"])
def test_a_download_that_is_not_the_one_recorded_is_refused_and_says_the_source_changed(
    script: ModuleType, change: str
) -> None:
    data = b"0, 100.0, 33\n"
    served = data + b"x" if change == "longer" else b"1" + data[1:]
    with pytest.raises(script.FetchError, match="the source changed"):
        script.fetch(_part(script, data), None, download=lambda url: served)


def test_a_member_of_an_archive_is_read_by_name_and_held_to_its_own_checksum(
    script: ModuleType,
) -> None:
    member = b"case data"
    archive = _zip({"dir/case.raw": member, "dir/other.txt": b"other"})
    part = script.Part(
        "case.raw",
        "https://example.org/a.zip",
        len(archive),
        _sha(archive),
        "dir/case.raw",
        _sha(member),
    )
    assert script.fetch(part, None, download=lambda url: archive) == member
    wrong = script.Part(
        "case.raw",
        "https://example.org/a.zip",
        len(archive),
        _sha(archive),
        "dir/case.raw",
        _sha(b"another"),
    )
    with pytest.raises(script.FetchError, match="not the file recorded"):
        script.fetch(wrong, None, download=lambda url: archive)


def test_a_member_the_archive_does_not_hold_and_a_download_that_is_no_archive_are_refused(
    script: ModuleType,
) -> None:
    archive = _zip({"a.raw": b"x"})
    part = script.Part(
        "b.raw", "https://example.org/a.zip", len(archive), _sha(archive), "b.raw", _sha(b"x")
    )
    with pytest.raises(script.FetchError, match="holds no 'b.raw'"):
        script.fetch(part, None, download=lambda url: archive)
    not_zip = b"<html>sign in</html>"
    page = script.Part(
        "b.raw", "https://example.org/a.zip", len(not_zip), _sha(not_zip), "b.raw", _sha(b"x")
    )
    with pytest.raises(script.FetchError, match="holds no 'b.raw'"):
        script.fetch(page, None, download=lambda url: not_zip)


def test_a_name_inside_an_archive_cannot_choose_where_anything_is_written(
    script: ModuleType, tmp_path: Path
) -> None:
    """The member is read into memory by its exact name; nothing is extracted."""
    archive = _zip({"../escape.raw": b"x"})
    assert script.read_member(archive, "../escape.raw") == b"x"
    assert not (tmp_path.parent / "escape.raw").exists()


def test_a_member_too_big_to_read_is_refused(script: ModuleType, monkeypatch: Any) -> None:
    archive = _zip({"big.raw": b"x" * 100})
    monkeypatch.setattr(script, "MAX_DOWNLOAD", 10)
    with pytest.raises(script.FetchError, match="more than is read"):
        script.read_member(archive, "big.raw")


def test_the_cache_keeps_a_download_by_its_checksum_and_only_when_it_is_the_recorded_one(
    script: ModuleType, tmp_path: Path
) -> None:
    data = b"0, 100.0, 33\n"
    part = _part(script, data)
    calls: list[str] = []

    def serve(url: str) -> bytes:
        calls.append(url)
        return data

    assert script.fetch(part, tmp_path, download=serve) == data
    assert script.fetch(part, tmp_path, download=serve) == data
    assert len(calls) == 1  # the second read came from the cache
    assert (tmp_path / f"{part.sha256}.bin").read_bytes() == data
    # A download that is not the recorded one is not kept.
    other = tmp_path / "other"
    with pytest.raises(script.FetchError):
        script.fetch(part, other, download=lambda url: b"changed")
    assert not list(other.glob("*")) if other.exists() else True


def test_the_script_says_what_it_is_and_does_not_pass_for_a_browser(script: ModuleType) -> None:
    # The default name of urllib gets a 403 from nlr.gov and an honest one of the script's own does
    # not, so there is no reason to say it is Chrome.
    assert "Mozilla" not in script.USER_AGENT and "Chrome" not in script.USER_AGENT
    assert "TENSA" in script.USER_AGENT


def test_an_archive_that_several_trials_use_is_downloaded_once_in_a_run_with_no_cache_given(
    script: ModuleType, monkeypatch: Any
) -> None:
    """Each part of a trial used to be downloaded again for every trial that names it (the WECC
    archive three times): the run keeps what it has fetched, by checksum, until it ends."""
    import contextlib

    data = b"0, 100.0, 33\n"
    part = _part(script, data)
    trials = [
        script.Trial(key, "e", "A trial", (part,), "x.raw", (), script.Expect(opens=True))
        for key in ("one", "two", "three")
    ]
    fetched: list[str] = []
    monkeypatch.setattr(script, "_download", lambda url: fetched.append(url) or data)

    @contextlib.contextmanager
    def server(workspace: Path) -> Iterator[str]:
        yield "http://127.0.0.1:1"

    monkeypatch.setattr(script, "running_server", server)
    monkeypatch.setattr(script, "Api", lambda url: None)
    monkeypatch.setattr(
        script,
        "run_trial",
        lambda api, workspace, trial, data, python, scratch: script.TrialResult(
            trial.key, trial.entry, trial.title
        ),
    )
    results = script.run_trials(trials, None, None)
    assert [r.key for r in results] == ["one", "two", "three"] and not any(r.error for r in results)
    assert fetched == ["https://example.org/x"]


def test_a_cached_file_that_was_changed_on_disk_is_refused(
    script: ModuleType, tmp_path: Path
) -> None:
    data = b"0, 100.0, 33\n"
    part = _part(script, data)
    (tmp_path / f"{part.sha256}.bin").write_bytes(b"tampered")
    with pytest.raises(script.FetchError, match="the source changed"):
        script.fetch(part, tmp_path, download=lambda url: data)


# ---- what ANDES makes of a model --------------------------------------------------------------


def test_a_model_is_read_as_itself_as_another_model_or_not_at_all(script: ModuleType) -> None:
    mapping = {"GENROU": "GENROU", "GGOV1": "TGOV1", "SEXS": "SEXS"}
    rows = script.classify_models({"GGOV1": 367, "GENROU": 410, "GENROE": 12, "SEXS": 410}, mapping)
    assert [(r.psse_model, r.status, r.andes_model) for r in rows] == [
        ("GENROU", "as is", "GENROU"),
        ("SEXS", "as is", "SEXS"),
        ("GGOV1", "approximated", "TGOV1"),
        ("GENROE", "not supported", None),
    ]
    assert [r.records for r in rows] == [410, 410, 367, 12]


def test_the_models_the_catalog_entries_name_are_what_the_installed_andes_does_with_them(
    script: ModuleType,
) -> None:
    """The entries say GGOV1, EXPIC1, ESAC6A and SCRX are approximated, GENSAL is read as a
    GENROU, and that GENROE, GENSAE, DC4B, CSVGN1, IEELAL and DERA1 are left out: this holds
    them to the table of the ANDES that is installed, so a release that gains one is noticed."""
    pytest.importorskip("andes")
    mapping = script.dyr_mapping()
    assert mapping["GGOV1"] == "TGOV1"
    assert {mapping[m] for m in ("EXPIC1", "ESAC6A", "SCRX")} == {"SEXS"}
    assert mapping["GENSAL"] == "GENROU"
    for model in ("GENROE", "GENSAE", "DC4B", "CSVGN1", "IEELAL", "DERA1"):
        assert model not in mapping, model
    for model in ("GENROU", "SEXS", "TGOV1", "REECB1", "ESDC1A", "IEEEST"):
        assert mapping[model] == model, model


def test_the_dynamic_data_is_counted_the_way_andes_reads_it(
    script: ModuleType, tmp_path: Path
) -> None:
    pytest.importorskip("andes")
    dyr = tmp_path / "x.dyr"
    dyr.write_text(
        "// a comment\n"
        "1 'GENROU' 1  6.5 0.05 1.26 0.08 5.0 0.0 2.12\n"
        "  1.98 0.17 0.45 0.10 0.077 0.14 0.67 /\n"
        "2 'GENROU' 1  6.5 0.05 1.26 0.08 5.0 0.0 2.12\n"
        "  1.98 0.17 0.45 0.10 0.077 0.14 0.67 /\n"
        "1 'SEXS' 1  1.0 1.0 30.0 0.05 -4.0 5.0 /\n",
        encoding="utf-8",
    )
    assert script.dyr_model_counts(dyr) == {"GENROU": 2, "SEXS": 1}


# ---- comparing -------------------------------------------------------------------------------


def test_the_largest_gap_names_the_bus_and_counts_the_buses_one_side_lacks(
    script: ModuleType,
) -> None:
    gap = script.largest_gap({"1": 1.0, "2": 1.02, "3": 0.9}, {"1": 1.0, "2": 1.0, "4": 1.1})
    assert gap.bus == "2" and gap.worst == pytest.approx(0.02)
    assert gap.buses == 2 and gap.missing == 1
    none = script.largest_gap({"1": 1.0}, {"9": 1.0})
    assert none.buses == 0 and none.missing == 1 and none.worst != none.worst  # NaN


def _pf(volts: dict[str, float], degrees: dict[str, float]) -> dict[str, Any]:
    import math

    return {
        "bus_voltages": volts,
        "bus_angles": {k: math.radians(v) for k, v in degrees.items()},
        "summary": {"loss_p": 10.0, "slack_p": 100.0},
    }


def test_a_power_flow_inside_both_bounds_of_a_solver_passes_and_the_losses_are_compared(
    script: ModuleType,
) -> None:
    reference = {
        "bus_voltage": {"1": 1.0, "2": 0.99},
        "bus_angle": {"1": 0.0, "2": -2.0},
        "loss_mw": 10.01,
        "slack_p_mw": 99.99,
    }
    compare = script.compare_power_flow(
        _pf({"1": 1.0, "2": 0.99005}, {"1": 0.0, "2": -2.004}),
        reference,
        "pandapower",
        stored=False,
    )
    assert compare.passed is True
    assert compare.voltage_gap == pytest.approx(5e-5) and compare.angle_gap == pytest.approx(0.004)
    assert compare.loss_gap_mw == pytest.approx(0.01) and compare.slack_gap_mw == pytest.approx(
        0.01
    )


def test_losses_or_a_slack_power_over_the_solvers_bound_fail_the_comparison(
    script: ModuleType,
) -> None:
    reference = {
        "bus_voltage": {"1": 1.0},
        "bus_angle": {"1": 0.0},
        "loss_mw": 12.0,  # the power flow says 10: 2 MW off, over 0.01 + 0.001 of 12
        "slack_p_mw": 100.0,
    }
    compare = script.compare_power_flow(_pf({"1": 1.0}, {"1": 0.0}), reference, "x", stored=False)
    assert compare.loss_ok is False and compare.slack_ok is True
    assert compare.passed is False


def test_a_gap_over_a_bound_or_a_bus_the_power_flow_lacks_fails(script: ModuleType) -> None:
    reference = {"bus_voltage": {"1": 1.0, "2": 1.0}, "bus_angle": {"1": 0.0, "2": 0.0}}
    far = script.compare_power_flow(
        _pf({"1": 1.0, "2": 1.001}, {"1": 0.0, "2": 0.0}), reference, "pandapower", stored=False
    )
    assert far.passed is False and far.voltage_bus == "2"
    short = script.compare_power_flow(_pf({"1": 1.0}, {"1": 0.0}), reference, "x", stored=False)
    assert short.passed is False and "not in the power flow" in short.note


def test_the_state_a_file_stores_is_held_to_a_looser_bound_than_a_solver(
    script: ModuleType,
) -> None:
    reference = {"bus_voltage": {"1": 1.0}, "bus_angle": {"1": 0.0}}
    pf = _pf({"1": 1.005}, {"1": 0.2})
    assert script.compare_power_flow(pf, reference, "solver", stored=False).passed is False
    stored = script.compare_power_flow(pf, reference, "the file", stored=True)
    assert stored.passed is True
    assert stored.voltage_tolerance == script.STORED_VOLTAGE_TOLERANCE
    assert stored.angle_tolerance == script.STORED_ANGLE_TOLERANCE
    assert stored.loss_gap_mw is None  # the file stores no losses to compare


# ---- what a trial expects ---------------------------------------------------------------------


def test_what_a_trial_saw_is_held_to_what_its_entry_says(script: ModuleType) -> None:
    expect = script.Expect(opens=True, pf=True, tds="fails")
    seen = {"opens": True, "static_opens": None, "pf_converged": True, "tds": "fails"}
    assert script.mismatches(expect, seen) == []
    # A newer ANDES that runs the case is a difference to notice.
    assert script.mismatches(expect, seen | {"tds": "completes"}) == [
        "10 s run: expected a run that reaches its end time and is reported failed, "
        "saw a run that completes"
    ]
    assert any("power flow" in m for m in script.mismatches(expect, seen | {"pf_converged": False}))
    assert any(
        "with its dynamic data" in m for m in script.mismatches(expect, seen | {"opens": False})
    )


@pytest.mark.parametrize("expected", ["completes", "fails", "stops", "refused"])
def test_the_four_ways_a_run_can_end_are_told_apart(script: ModuleType, expected: str) -> None:
    """A run the server refuses and one that reaches its end time and is reported failed (ANDES
    fails its initialisation test and goes on) are different findings, and so is one that
    stops short: a change from any of the four to another is a MISMATCH."""
    expect = script.Expect(opens=True, pf=True, tds=expected)
    seen = {"opens": True, "pf_converged": True}
    assert script.mismatches(expect, seen | {"tds": expected}) == []
    for other in {"completes", "fails", "stops", "refused"} - {expected}:
        problems = script.mismatches(expect, seen | {"tds": other})
        assert len(problems) == 1 and problems[0].startswith("10 s run: expected"), (
            expected,
            other,
        )
    assert "saw no run" in script.mismatches(expect, seen | {"tds": None})[0]


@pytest.mark.parametrize(
    ("answer", "outcome"),
    [
        ({"converged": True, "final_t": 10.0}, "completes"),
        ({"converged": False, "final_t": 10.0}, "fails"),
        ({"converged": False, "final_t": 10.0 - 4e-7}, "fails"),
        ({"converged": False, "final_t": 3.53}, "stops"),
        ({"converged": True, "final_t": 9.9667}, "stops"),
        ({"converged": False}, "stops"),
    ],
)
def test_an_answered_run_completes_fails_after_its_end_time_or_stops_short(
    script: ModuleType, answer: dict[str, Any], outcome: str
) -> None:
    assert script.tds_outcome(answer, 10.0) == outcome


def test_a_comparison_that_flips_is_a_mismatch_and_one_not_asked_for_is_not_held(
    script: ModuleType,
) -> None:
    expect = script.Expect(
        opens=False, static_opens=True, pf=True, stored="inside", solver="inside"
    )
    seen = {
        "opens": False,
        "static_opens": True,
        "pf_converged": True,
        "stored": "inside",
        "solver": "inside",
    }
    assert script.mismatches(expect, seen) == []
    assert script.mismatches(expect, seen | {"stored": "outside"}) == [
        "power flow against the solution the file stores: expected inside the bounds, "
        "saw outside the bounds"
    ]
    assert script.mismatches(expect, seen | {"solver": "none"}) == [
        "power flow against pandapower's solution: expected inside the bounds, "
        "saw no solution to compare with"
    ]
    # No interpreter with pandapower: the comparison is not in what was seen, and not held.
    without = {k: v for k, v in seen.items() if k != "solver"}
    assert script.mismatches(expect, without) == []
    # What an entry does not say is not held, whatever was seen.
    silent = script.Expect(opens=False, static_opens=True, pf=True)
    assert script.mismatches(silent, seen | {"stored": "outside", "solver": "outside"}) == []
    # A reference that gave no solution is held too: pandapower now solving it is a difference.
    nothing = script.Expect(opens=True, pf=True, solver="none")
    assert script.mismatches(nothing, {"opens": True, "pf_converged": True, "solver": "none"}) == []
    assert script.mismatches(nothing, {"opens": True, "pf_converged": True, "solver": "inside"})


def test_the_models_read_as_another_model_and_those_left_out_are_held_to_their_counts(
    script: ModuleType,
) -> None:
    expect = script.Expect(
        opens=True,
        approximated={"GGOV1": 367, "GENSAL": 25},
        unsupported={},
    )
    seen = {
        "opens": True,
        "approximated": {"GENSAL": 25, "GGOV1": 367},
        "unsupported": {},
    }
    assert script.mismatches(expect, seen) == []
    # A model that is now read as itself, one that is now left out, a different count.
    gained = seen | {"approximated": {"GGOV1": 367}}
    assert script.mismatches(expect, gained) == [
        "models read as another model: expected GGOV1 367, GENSAL 25, saw GGOV1 367"
    ]
    lost = seen | {"unsupported": {"DC4B": 11}}
    assert script.mismatches(expect, lost) == ["models left out: expected none, saw DC4B 11"]
    assert script.mismatches(expect, seen | {"approximated": {"GENSAL": 25, "GGOV1": 366}})
    # An entry that says nothing of the models holds none.
    assert script.mismatches(script.Expect(opens=True), seen | {"unsupported": {"X": 1}}) == []


def test_the_network_alone_is_only_asked_for_when_the_entry_says_something_about_it(
    script: ModuleType,
) -> None:
    expect = script.Expect(opens=False)
    assert script.mismatches(expect, {"opens": False, "static_opens": True}) == []
    named = script.Expect(opens=False, static_opens=False)
    assert script.mismatches(named, {"opens": False, "static_opens": True})


# ---- the run of a trial, against a fake of the API --------------------------------------------


class FakeApi:
    """Answers like a server that refuses the case with its dynamic data and takes it without."""

    def __init__(self, *, dynamic_opens: bool, converges: bool = True, run: Any = None) -> None:
        self.dynamic_opens = dynamic_opens
        self.converges = converges
        self.run = run  # the answer of ``/tds``, or an exception it raises
        self.variables: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str]] = []
        self.closed: list[str] = []
        self._n = 0

    def post(self, path: str, body: Any = None, **query: Any) -> Any:
        self.calls.append(("POST", path))
        if path == "/sessions":
            self._n += 1
            return {"session_id": f"s{self._n}"}
        if path.endswith("/case"):
            if body.get("addfiles") and not self.dynamic_opens:
                raise_error = sys.modules["verify_example_cases"].ApiError
                raise raise_error("POST", path, 422, "andes.load returned None")
            return {"buses": [{"idx": 1}, {"idx": 2}], "events": []}
        if path.endswith("/pflow"):
            return {
                "converged": self.converges,
                "iterations": 3,
                "mismatch": 1e-9,
                "bus_voltages": {"1": 1.0, "2": 0.98},
                "bus_angles": {"1": 0.0, "2": -0.05},
                "summary": {"loss_p": 1.0, "slack_p": 50.0},
            }
        if path.endswith("/tds"):
            assert self.run is not None, "the trial did not expect a run"
            if isinstance(self.run, Exception):
                raise self.run
            return self.run
        raise AssertionError(path)

    def get(self, path: str, **query: Any) -> Any:
        self.calls.append(("GET", path))
        if path.endswith("/messages"):
            return {"messages": [{"text": "Models not yet supported: GENROE"}]}
        if path.endswith("/dae-variables"):
            return {"items": self.variables, "total": len(self.variables)}
        raise AssertionError(path)

    def delete(self, path: str) -> Any:
        self.calls.append(("DELETE", path))
        self.closed.append(path.rsplit("/", 1)[1])


def _trial(script: ModuleType, **expect: Any) -> Any:
    parts = (
        script.Part("c.raw", "https://example.org/c.raw", 1, "0" * 64),
        script.Part("c.dyr", "https://example.org/c.dyr", 1, "0" * 64),
    )
    return script.Trial("t", "e", "A trial", parts, "c.raw", ("c.dyr",), script.Expect(**expect))


@pytest.fixture
def quiet(script: ModuleType, monkeypatch: Any) -> None:
    """The parts that need ANDES or pandapower, left out of the run of a trial."""
    monkeypatch.setattr(script, "dyr_model_counts", lambda path: {"GENROE": 4, "GGOV1": 2})
    monkeypatch.setattr(script, "dyr_mapping", lambda: {"GGOV1": "TGOV1"})
    monkeypatch.setattr(
        script,
        "stored_state",
        lambda path: {"bus_voltage": {"1": 1.0, "2": 0.98}, "bus_angle": {"1": 0.0, "2": -2.86}},
    )
    monkeypatch.setattr(script, "pandapower_state", lambda *args: (None, "no pandapower here"))


@pytest.fixture
def harness_loaded(script: ModuleType) -> None:
    """The script imports the harness; the fake raises the harness's own error class."""
    assert "verify_example_cases" in sys.modules


def test_a_case_refused_with_its_dynamics_is_opened_alone_and_both_sessions_are_closed(
    script: ModuleType, quiet: None, harness_loaded: None, tmp_path: Path
) -> None:
    api = FakeApi(dynamic_opens=False)
    data = {"c.raw": b"r", "c.dyr": b"d"}
    for name, content in data.items():
        (tmp_path / name).write_bytes(content)
    result = script.run_trial(
        api, tmp_path, _trial(script, opens=False, static_opens=True, pf=True), data, None, tmp_path
    )
    assert result.opens is False and result.static_opens is True
    assert "andes.load returned None" in (result.open_error or "")
    assert result.open_messages == ["Models not yet supported: GENROE"]
    assert [(m.psse_model, m.status) for m in result.models] == [
        ("GENROE", "not supported"),
        ("GGOV1", "approximated"),
    ]
    assert result.pf_converged is True and result.tds is None  # no dynamics, so no run
    assert result.problems == [] and result.passed
    assert len(api.closed) == 2  # the refused session is not left behind


def test_a_case_that_opens_with_its_dynamics_is_run_and_a_difference_from_the_entry_is_a_problem(
    script: ModuleType, quiet: None, harness_loaded: None, tmp_path: Path
) -> None:
    api = FakeApi(dynamic_opens=True, converges=False)
    data = {"c.raw": b"r", "c.dyr": b"d"}
    for name, content in data.items():
        (tmp_path / name).write_bytes(content)
    result = script.run_trial(
        api, tmp_path, _trial(script, opens=True, pf=True), data, None, tmp_path
    )
    assert result.opens is True and result.pf_converged is False
    assert result.tds is None  # a power flow that failed is not followed by a run
    assert any("power flow converges: expected True, saw False" in p for p in result.problems)
    assert not result.passed
    assert any("pandapower" in c.reference for c in result.comparisons)
    assert len(api.closed) == 1


def test_a_trial_that_breaks_is_a_result_and_not_a_crash(
    script: ModuleType, quiet: None, harness_loaded: None, monkeypatch: Any, tmp_path: Path
) -> None:
    def broken(path: Path) -> dict[str, int]:
        raise OSError("disk gone")

    monkeypatch.setattr(script, "dyr_model_counts", broken)
    data = {"c.raw": b"r", "c.dyr": b"d"}
    for name, content in data.items():
        (tmp_path / name).write_bytes(content)
    result = script.run_trial(
        FakeApi(dynamic_opens=True), tmp_path, _trial(script, opens=True), data, None, tmp_path
    )
    assert result.error == "OSError: disk gone" and not result.passed


def _write(tmp_path: Path) -> dict[str, bytes]:
    data = {"c.raw": b"r", "c.dyr": b"d"}
    for name, content in data.items():
        (tmp_path / name).write_bytes(content)
    return data


def test_a_power_flow_far_from_both_references_fails_a_trial_that_says_it_is_inside_them(
    script: ModuleType, quiet: None, harness_loaded: None, monkeypatch: Any, tmp_path: Path
) -> None:
    """The comparisons are held to the entry, not only reported: a reference far off made the
    run pass when only whether the case opens, the power flow converges and the 10 s run were
    held."""
    far_stored = {"bus_voltage": {"1": 1.5, "2": 1.5}, "bus_angle": {"1": 40.0, "2": 40.0}}
    far_solver = far_stored | {"loss_mw": 999.0, "slack_p_mw": 999.0, "pandapower": "9.9"}
    monkeypatch.setattr(script, "stored_state", lambda path: far_stored)
    monkeypatch.setattr(script, "pandapower_state", lambda *args: (far_solver, ""))
    data = _write(tmp_path)
    inside = _trial(
        script, opens=False, static_opens=True, pf=True, stored="inside", solver="inside"
    )
    result = script.run_trial(FakeApi(dynamic_opens=False), tmp_path, inside, data, "py", tmp_path)
    assert [c.passed for c in result.comparisons] == [False, False]
    assert not result.passed
    assert [p.split(":")[0] for p in result.problems] == [
        "power flow against the solution the file stores",
        "power flow against pandapower's solution",
    ]
    # The entry that says they are outside (the stored state of ACTIVSg2000) is held to that.
    outside = _trial(
        script, opens=False, static_opens=True, pf=True, stored="outside", solver="outside"
    )
    again = script.run_trial(FakeApi(dynamic_opens=False), tmp_path, outside, data, "py", tmp_path)
    assert again.problems == [] and again.passed


def test_a_comparison_with_pandapower_that_was_not_asked_for_is_not_held(
    script: ModuleType, quiet: None, harness_loaded: None, tmp_path: Path
) -> None:
    data = _write(tmp_path)
    trial = _trial(script, opens=False, static_opens=True, pf=True, solver="inside")
    result = script.run_trial(FakeApi(dynamic_opens=False), tmp_path, trial, data, None, tmp_path)
    assert [c.asked for c in result.comparisons if c.kind == "solver"] == [False]
    assert result.problems == [] and result.passed
    page = script.render_markdown([result], "2026-01-01")
    assert "No interpreter with pandapower was given" in page
    # With an interpreter that gives no solution, the same entry is not as it says.
    asked = script.run_trial(FakeApi(dynamic_opens=False), tmp_path, trial, data, "py", tmp_path)
    assert any("pandapower" in p for p in asked.problems)


def test_a_power_flow_that_does_not_converge_is_outside_a_solution_pandapower_gives(
    script: ModuleType, quiet: None, harness_loaded: None, monkeypatch: Any, tmp_path: Path
) -> None:
    data = _write(tmp_path)
    trial = _trial(script, opens=False, static_opens=True, pf=False, solver="none")
    args = (tmp_path, trial, data, "py", tmp_path)
    nowhere = script.run_trial(FakeApi(dynamic_opens=False, converges=False), *args)
    assert nowhere.problems == []  # pandapower does not solve it either ("no pandapower here")
    solved = {"bus_voltage": {}, "bus_angle": {}, "pandapower": "9.9"}
    monkeypatch.setattr(script, "pandapower_state", lambda *a: (solved, ""))
    found = script.run_trial(FakeApi(dynamic_opens=False, converges=False), *args)
    assert any("pandapower's solution" in p for p in found.problems)


_TRACES = {
    "flat": {"t": [0.0, 5.0, 10.0], "variables": [{"name": "x A 1", "values": [1.0, 1.0, 1.0]}]},
    "drift": {
        "t": [0.0, 5.0, 10.0],
        "variables": [
            {"name": "x A 1", "values": [1.0, 1.0, 1.0]},
            {"name": "PIQ_xi B 1", "values": [0.0, 0.1, 0.163]},
        ],
    },
}


@pytest.mark.parametrize(
    ("kind", "outcome", "change", "flat"),
    [
        ("completes", "completes", 0.0, True),
        ("fails", "fails", 0.163, None),
        ("stops", "stops", None, None),
        ("refused", "refused", None, None),
    ],
)
def test_the_run_of_a_trial_ends_in_one_of_four_ways_and_a_failed_one_is_measured_not_judged(
    script: ModuleType,
    quiet: None,
    harness_loaded: None,
    tmp_path: Path,
    kind: str,
    outcome: str,
    change: float | None,
    flat: bool | None,
) -> None:
    api_error = sys.modules["verify_example_cases"].ApiError
    runs: dict[str, Any] = {
        "completes": {"converged": True, "final_t": 10.0, "traces": _TRACES["flat"]},
        "fails": {"converged": False, "final_t": 10.0, "traces": _TRACES["drift"]},
        "stops": {"converged": False, "final_t": 3.53, "traces": _TRACES["drift"]},
        "refused": api_error("POST", "/sessions/s1/tds", 422, "TDS.run raised: boom"),
    }
    api = FakeApi(dynamic_opens=True, run=runs[kind])
    api.variables = [
        {"name": "x A 1", "kind": "x", "model": "A", "var": "x"},
        {"name": "PIQ_xi B 1", "kind": "x", "model": "B", "var": "PIQ_xi"},
    ]
    data = _write(tmp_path)
    result = script.run_trial(
        api, tmp_path, _trial(script, opens=True, pf=True, tds=outcome), data, None, tmp_path
    )
    assert result.tds == outcome and result.problems == [], result.problems
    assert result.tds_change == change and result.tds_flat is flat
    if kind == "refused":
        assert "boom" in (result.tds_error or "")
    wrong = "completes" if outcome != "completes" else "fails"
    again = script.run_trial(
        FakeApi(dynamic_opens=True, run=runs[kind]),
        tmp_path,
        _trial(script, opens=True, pf=True, tds=wrong),
        data,
        None,
        tmp_path,
    )
    assert any(p.startswith("10 s run: expected") for p in again.problems)
    page = script.render_markdown([result], "2026-01-01")
    if kind == "fails":
        assert "reaches its end time" in page and "not judged: the run is reported failed" in page
        assert "0.163 (PIQ_xi B 1" in page


def test_the_states_to_record_are_an_equal_share_of_each_model_when_there_are_too_many(
    script: ModuleType,
) -> None:
    def state(model: str, n: int) -> dict[str, Any]:
        return {"name": f"s {model} {n}", "kind": "x", "model": model, "var": "s"}

    bus = [{"name": f"v Bus {n}", "kind": "y", "model": "Bus", "var": "v"} for n in (1, 2)]
    listing = [*bus, *(state("A", n) for n in range(5)), *(state("B", n) for n in range(2))]
    # Room for everything: every state, then the buses.
    names, left_out = script.spread_variables(listing, limit=20)
    assert left_out == 0 and len(names) == 9 and names[-2:] == ["v Bus 1", "v Bus 2"]
    # Too many: the models take turns, so the last model is recorded too, and no bus is.
    names, left_out = script.spread_variables(listing, limit=4)
    assert names == ["s A 0", "s B 0", "s A 1", "s B 1"] and left_out == 3
    # The states fill the room, so the buses are not recorded; one place left is a bus's.
    assert script.spread_variables(listing, limit=7)[0][-1] != "v Bus 1"
    assert script.spread_variables(listing, limit=8)[0][-1] == "v Bus 1"


# ---- the reports ------------------------------------------------------------------------------


def test_the_reports_say_what_was_seen_and_what_does_not_match(
    script: ModuleType, quiet: None, harness_loaded: None, tmp_path: Path
) -> None:
    api = FakeApi(dynamic_opens=False)
    data = {"c.raw": b"r", "c.dyr": b"d"}
    for name, content in data.items():
        (tmp_path / name).write_bytes(content)
    good = script.run_trial(
        api, tmp_path, _trial(script, opens=False, static_opens=True, pf=True), data, None, tmp_path
    )
    bad = script.run_trial(
        FakeApi(dynamic_opens=False), tmp_path, _trial(script, opens=True), data, None, tmp_path
    )
    page = script.render_markdown([good, bad], "2026-01-01")
    assert "| GENROE | 4 | not supported: left out |" in page
    assert "| GGOV1 | 2 | TGOV1 (approximation) |" in page
    assert "Against the solution stored in the file" in page
    assert "MISMATCH with what the catalog entry says" in page
    assert page.count("MISMATCH") == 1
    report = script.build_report([good, bad], "2026-01-01")
    assert report["passed"] is False
    assert [t["passed"] for t in report["trials"]] == [True, False]
    assert "—" not in page


def test_a_download_that_failed_is_a_trial_that_was_not_run_and_fails_the_report(
    script: ModuleType,
) -> None:
    result = script.TrialResult("k", "e", "T", error="could not download")
    assert not result.passed
    page = script.render_markdown([result], "2026-01-01")
    assert "Not run: could not download" in page
    assert script.build_report([result], "2026-01-01")["passed"] is False
