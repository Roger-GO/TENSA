#!/usr/bin/env python3
"""Download the data of the example catalog's link-only entries and see what TENSA does with it.

Usage:
    python scripts/check_external_datasets.py [KEY ...] [--list] [--json PATH]
        [--markdown PATH] [--cache DIR] [--verify-python PYTHON]

The catalog's ``external`` entries hold no file: the data is not ours to hand out, or TENSA
cannot read it. Where it can be downloaded, this script downloads it (every file is held to the
size and SHA-256 written in ``TRIALS`` below, so a file that changed is reported and not
used), puts the files in a temporary workspace, starts its own ``tensa serve`` on a free
port and, through the HTTP API,

1. opens the case, with its dynamic data (a ``.dyr``) when it has some, and when that fails
   opens the network alone, keeping what ANDES said;
2. lists what the dynamic data holds, model by model, and what ANDES makes of each: read as
   it is, read as another model (``GGOV1`` as ``TGOV1``, ``GENSAL`` as ``GENROU``, and so on,
   from ``andes/io/psse-dyr.yaml``) or left out;
3. runs the power flow and compares it with the solution the file stores (the bus voltages
   and angles PSS/E saved, read the way ``scripts/crosscheck_pf.py stored`` reads them) and,
   where pandapower is at hand and its dump can hold the network, with pandapower's;
4. for a case with dynamic data, runs 10 s of time domain with nothing acting on it and says
   whether it completes, is reported failed after reaching its end time (ANDES counts a failed
   initialisation test as a failed run and integrates all the same), stops short of it or is
   refused by the server, and how far the states move.

A file that cannot be opened at all (a PSS/E binary case, an IEEE Common Data Format text) is
offered to TENSA as it is, so that the refusal is TENSA's own. Nothing here downloads from
a page that asks for a name or an address before it gives the file: those datasets have no
trial, and their catalog entries say so.

Every trial states what it expects (``Expect``, which is what its catalog entry says): whether
the case opens, whether its power flow converges and stands inside the bounds of each
reference (the stored solution, pandapower), which models of the dynamic data ANDES reads as
another model or leaves out, and what the 10 s run does. A result that differs is a
``MISMATCH`` and the exit status is 1, so a newer ANDES that reads more of a file, or a source
that changed, is noticed. The exit status is also 1 when a trial could not be run (a download
failed or a file is not the one recorded), and 2 for bad usage. The numbers an entry quotes
(a gap of 3.5e-7 pu, a count of records) are in the report and not held: a comparison is held
to its bound, a model to its count.

pandapower is not a dependency of TENSA: ``--verify-python`` (or ``TENSA_VERIFY_PYTHON``) names
an interpreter that has it, as for ``scripts/crosscheck_pf.py``. Without one that comparison is
left out, and so is what the entries say of it; the report says so. Downloads go to a
temporary folder (or ``--cache``) and are deleted with it.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_SRC = REPO_ROOT / "server" / "src"
SCRIPTS = Path(__file__).resolve().parent

if importlib.util.find_spec("tensa") is None:
    sys.path.insert(0, str(SERVER_SRC))
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from crosscheck_pf import CrosscheckError  # noqa: E402
from verify_example_cases import (  # noqa: E402
    FLAT_TOLERANCE,
    UNDISTURBED_TF,
    Api,
    ApiError,
    completes,
    largest_change,
    list_variables,
    running_server,
    trace_arrays,
)

from tensa.core.dae_vars import MAX_DAE_VARS  # noqa: E402

# The most one download may be, in bytes: the biggest file here is 2.1 MB.
MAX_DOWNLOAD = 8_000_000
# A browser's name: some of the hosts answer a script with a 403.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
DOWNLOAD_TIMEOUT = 120.0
# What a power flow must agree with pandapower's to, as for every case of the catalog.
VOLTAGE_TOLERANCE = 1e-4  # per unit
ANGLE_TOLERANCE = 0.01  # degrees
# The losses and the slack's power agree with a solver's to this much plus this share of the value.
POWER_TOLERANCE_MW = 0.01
POWER_TOLERANCE_REL = 1e-3
# The state a file stores is the solution of the program that wrote it, to the digits it kept
# and with that program's own treatment of limits and taps, so the bound is looser.
STORED_VOLTAGE_TOLERANCE = 1e-2
STORED_ANGLE_TOLERANCE = 0.5

Log = Callable[[str], None]

# ----------------------------------------------------------------------------------------
# What is downloaded, and what each trial is expected to show
# ----------------------------------------------------------------------------------------

_SIENNA = (
    "https://raw.githubusercontent.com/Sienna-Platform/PowerSystemsTestData/"
    "a2ecae9ff3cfe6d219744f1b10e4edd4eeecabc9/"
)
_NLR_ZIP = "https://www.nlr.gov/media/docs/libraries/grid/wecc-osl.zip?sfvrsn=f85a054e_1"
_NLR_DIR = "WECC 240-bus case (2018 summar peak) for 2021 IEEE-NASPI OSL Contest/"
_PES = "https://drive.usercontent.google.com/download?export=download&confirm=t&id={id}&resourcekey={key}"
_UW = "https://labs.ece.uw.edu/pstca/"


@dataclass(frozen=True)
class Part:
    """One file of a trial: where it comes from and what it is called in the workspace.

    ``size`` and ``sha256`` are those of the download. For a ``.zip`` download, ``member`` is
    the file of the archive the trial uses, and ``member_sha256`` is its checksum.
    """

    name: str
    url: str
    size: int
    sha256: str
    member: str | None = None
    member_sha256: str | None = None


# What the 10 s run did: it ran to its end time and ANDES calls it a success ("completes"), it
# ran to its end time and ANDES calls it a failure ("fails": its initialisation test did not
# pass, and TENSA reports the run as failed), it ended before its end time ("stops") or the
# server answered with an error and nothing ran ("refused").
TdsOutcome = Literal["completes", "fails", "stops", "refused"]
# How the power flow stands to a reference: every bus inside the bounds, some bus outside them,
# or no comparison to make because the reference gives no solution.
Agreement = Literal["inside", "outside", "none"]


@dataclass(frozen=True)
class Expect:
    """What a trial's catalog entry says happens, so that a different outcome is noticed.

    A field left at ``None`` is something the entry does not say, and is not held.
    """

    opens: bool  # the case opens with its dynamic data (alone, when it has none)
    static_opens: bool | None = None  # when it does not: the network alone opens
    pf: bool | None = None  # the power flow of what opened converges
    tds: TdsOutcome | None = None  # the 10 s run, for a case with dynamics
    stored: Agreement | None = None  # the power flow against the solution the file stores
    solver: Agreement | None = None  # the power flow against pandapower's
    # The models of the dynamic data ANDES reads as another model, and those it leaves out,
    # each with its number of records. An empty mapping says there are none.
    approximated: dict[str, int] | None = None
    unsupported: dict[str, int] | None = None


@dataclass(frozen=True)
class Trial:
    key: str
    entry: str  # the catalog entry the result belongs to
    title: str
    parts: tuple[Part, ...]
    primary: str  # the name of the part that is opened as the case
    companions: tuple[str, ...]  # the names of the dynamic data files opened with it
    expect: Expect


def _drive(file_id: str, key: str) -> str:
    return _PES.format(id=file_id, key=key)


TRIALS: tuple[Trial, ...] = (
    Trial(
        key="wecc240",
        entry="wecc240",
        title="Reduced 240-bus WECC with renewables (NLR download, 2021 IEEE-NASPI contest copy)",
        parts=(
            Part(
                "wecc240.raw",
                _NLR_ZIP,
                2121896,
                "dfb91ad14e42fbc8515eafa637a3f0c85996e5508736edbef2886a40fc0e6e87",
                _NLR_DIR + "240busWECC_2018_PSS.raw",
                "fd4232705085dff5dc86c8e5a4fa344628a9d2961bf847f6cc598d4f7175eeaa",
            ),
            Part(
                "wecc240.dyr",
                _NLR_ZIP,
                2121896,
                "dfb91ad14e42fbc8515eafa637a3f0c85996e5508736edbef2886a40fc0e6e87",
                _NLR_DIR + "240busWECC_2018_PSS.dyr",
                "825549323b798e0171fc814112228cce0713080730f6953e67a86ba3170954da",
            ),
            # The notice of the download, which is its licence: held to its checksum so that the
            # text the catalog entry reports is the text that is there.
            Part(
                "wecc240.disclaimer.txt",
                _NLR_ZIP,
                2121896,
                "dfb91ad14e42fbc8515eafa637a3f0c85996e5508736edbef2886a40fc0e6e87",
                _NLR_DIR + "NREL Disclaimer.txt",
                "90fa4bd727bf945a5d72543f4e1b646d90543325015fe8942a4b40594e2c69a7",
            ),
        ),
        primary="wecc240.raw",
        companions=("wecc240.dyr",),
        expect=Expect(
            opens=True,
            pf=True,
            tds="fails",
            stored="inside",
            solver="none",
            approximated={},
            unsupported={},
        ),
    ),
    Trial(
        key="wecc240-mirror",
        entry="wecc240",
        title="Reduced 240-bus WECC (the copy in the Sienna test data repository)",
        parts=(
            Part(
                "wecc240m.raw",
                _SIENNA + "psse_raw/240busWECC_2018_PSS33.raw",
                146664,
                "217c4f4ab304598608bacf74681481976cb5c7225b8296c2be2dde926b85239e",
            ),
            Part(
                "wecc240m.dyr",
                _SIENNA + "psse_dyr/240busWECC_2018_PSS.dyr",
                100892,
                "ce0b8bf9b5f73c39c7260efe24920507aaa498f752c452457967e8fbf426682b",
            ),
        ),
        primary="wecc240m.raw",
        companions=("wecc240m.dyr",),
        expect=Expect(
            opens=True,
            pf=True,
            tds="fails",
            stored="inside",
            solver="none",
            approximated={},
            unsupported={},
        ),
    ),
    Trial(
        key="activsg2000-dyn",
        entry="activsg2000_dyn",
        title="ACTIVSg2000 with dynamic data (the copy in the Sienna test data repository)",
        parts=(
            Part(
                "activsg2000.raw",
                _SIENNA + "ACTIVSg2000/ACTIVSg2000.RAW",
                1166973,
                "d7191f8d9ba1bc7ce8247a060fc6e12bcb0dc5b7ba4f7e6cf68c7233f7a13cea",
            ),
            Part(
                "activsg2000.dyr",
                _SIENNA + "psse_dyr/ACTIVSg2000_dynamics.dyr",
                235394,
                "05a6c833eac0b2a2c8f7925c0a022a28733ab43ec40a7dd80107d20c291c550d",
            ),
        ),
        primary="activsg2000.raw",
        companions=("activsg2000.dyr",),
        expect=Expect(
            opens=True,
            pf=True,
            tds="refused",
            stored="outside",
            solver="inside",
            approximated={"GGOV1": 367, "EXPIC1": 61, "ESAC6A": 7, "SCRX": 5, "GENSAL": 25},
            unsupported={},
        ),
    ),
    Trial(
        key="wecc240-dera",
        entry="wecc240",
        title="Reduced WECC, 379-bus variant with DERA1 models (the Sienna test data repository)",
        parts=(
            Part(
                "wecc240d.raw",
                _SIENNA + "psse_raw/240_bus_new_2.raw",
                178075,
                "27c701daae4d13f2c29ccd99d3f4fec5317c5cfa75f9661b3dd8f985ae8ae1b3",
            ),
            Part(
                "wecc240d.dyr",
                _SIENNA + "psse_dyr/240_bus_remap2_dera2.dyr",
                171931,
                "4aa4c492e7165a749f83b5a92127b33325fe72b1e00d0d8b8535e33f23a5dd8c",
            ),
        ),
        primary="wecc240d.raw",
        companions=("wecc240d.dyr",),
        expect=Expect(
            opens=False, static_opens=True, pf=True, solver="inside", unsupported={"DERA1": 3}
        ),
    ),
    Trial(
        key="pes-twoarea",
        entry="pes_benchmarks",
        title="IEEE PES benchmark: two-area four-generator model, PSS/E files",
        parts=(
            Part(
                "twoarea.raw",
                _drive("0Bys96O_8YuIbYy1KVm9qakxqb1E", "0-uRMNyZwS04N-YvBBRPYgGQ"),
                2379,
                "ef9f6905f262cb2348242cd2fd61bd18d0de9cb08bee13928095783d961296c6",
                "Benchmark_4ger_33_2015.raw",
                "b344da872d9b9b485a3ae4fcce8606f22f9b53371d8dd0aede2816495de715b5",
            ),
            Part(
                "twoarea.dyr",
                _drive("0Bys96O_8YuIbYy1KVm9qakxqb1E", "0-uRMNyZwS04N-YvBBRPYgGQ"),
                2379,
                "ef9f6905f262cb2348242cd2fd61bd18d0de9cb08bee13928095783d961296c6",
                "Benchmark_4ger_ESST1A_TGR_2015.dyr",
                "ff456734628f114469d6f6f2b1da3fc3df82ab383ebecb0882d5be4671df9ab0",
            ),
        ),
        primary="twoarea.raw",
        companions=("twoarea.dyr",),
        expect=Expect(
            opens=False,
            static_opens=True,
            pf=True,
            stored="inside",
            solver="inside",
            unsupported={"GENROE": 4},
        ),
    ),
    Trial(
        key="pes-brazil7",
        entry="pes_benchmarks",
        title="IEEE PES benchmark: Brazilian 7-bus equivalent, PSS/E version 32 files",
        parts=(
            Part(
                "brazil7.raw",
                _drive("0Bys96O_8YuIbWWF4ZEFMVkdiZlU", "0-RePJyWrGb1jIZbtbqChPPw"),
                1585,
                "f38ee5716a61459be1f1f3d844cbb1d882bb123ba13ea6ebeada4341b025fca4",
                "JCITA_PSSE_32.raw",
                "6ecde565e78914d421acdc123debf1ecce1cd53f86ca23da836fd7357f94fc9e",
            ),
            Part(
                "brazil7.dyr",
                _drive("0Bys96O_8YuIbWWF4ZEFMVkdiZlU", "0-RePJyWrGb1jIZbtbqChPPw"),
                1585,
                "f38ee5716a61459be1f1f3d844cbb1d882bb123ba13ea6ebeada4341b025fca4",
                "JCITA_PSSE_32.DYR",
                "0f7507bdd86e28d18dac2533114a904b51a8cb3c3c70267b1e2168fbe1dbec24",
            ),
        ),
        primary="brazil7.raw",
        companions=("brazil7.dyr",),
        expect=Expect(
            opens=False, static_opens=True, pf=False, solver="none", unsupported={"GENSAE": 5}
        ),
    ),
    Trial(
        key="pes-au14",
        entry="pes_benchmarks",
        title="IEEE PES benchmark: simplified 14-generator Australian system, case 1 (PSS/E 29)",
        parts=(
            Part(
                "au14.raw",
                _drive("0Bys96O_8YuIbbU00R1p4YVlJMjA", "0-9EOZvRdjYu_h6mlUbvCbyw"),
                85710,
                "291f66dd7cc638c10e3abb4b42114fffb60a52a231e3dcdcfbf381341ddbfd10",
                "LF_Case01_R4_S.raw",
                "27b0df7bfc0ff13f586f1c567be8a48fb1f817c09fb9f867b2309ec81d96b322",
            ),
            Part(
                "au14.dyr",
                _drive("0Bys96O_8YuIbbU00R1p4YVlJMjA", "0-9EOZvRdjYu_h6mlUbvCbyw"),
                85710,
                "291f66dd7cc638c10e3abb4b42114fffb60a52a231e3dcdcfbf381341ddbfd10",
                "PSSE_DYN_Case01.dyr",
                "0295e48bc4ef971da0689cd35d440a6f55b67134cbb2b74ed4fac56c10e3db4d",
            ),
        ),
        primary="au14.raw",
        companions=("au14.dyr",),
        expect=Expect(
            opens=False,
            static_opens=False,
            approximated={"GENSAL": 2},
            unsupported={"GENROE": 12, "CSVGN1": 5, "IEELAL": 1},
        ),
    ),
    Trial(
        key="pes-nyps68",
        entry="pes_benchmarks",
        title="IEEE PES benchmark: NETS-NYPS 68-bus system, dynamic data only (the Sienna copy)",
        parts=(
            Part(
                "nyps68.dyr",
                _SIENNA + "psse_dyr/NETS-NYPS%2068%20Bus%20System.dyr",
                5172,
                "b4adf4baa28f167b79cabfbdaffa3f63677b830a2061ff0fd5e1888ed59b7336",
            ),
        ),
        primary="nyps68.dyr",
        companions=(),
        expect=Expect(opens=False, unsupported={"DC4B": 11}),
    ),
    Trial(
        key="pes-3machine",
        entry="pes_benchmarks",
        title="IEEE PES benchmark: three-machine infinite-bus system, PSS/E base files",
        parts=(
            Part(
                "3ger_Benchmark.sav",
                _drive("0Bys96O_8YuIbd1p2U0lETmNkUDQ", "0-zuyEspUEIfhNH-4a2-X57Q"),
                17700,
                "2ebd207e5aff28a6579930ee62da38e2056e9ec9dddcadff8832aeeb58f5da63",
                "3ger_Benchmark.sav",
                "e60826414cd9edf5a42345943ffebb331587819bb482cf0b8a96c892b44f98e8",
            ),
        ),
        primary="3ger_Benchmark.sav",
        companions=(),
        expect=Expect(opens=False),
    ),
    Trial(
        key="nordic",
        entry="nordic",
        title="Nordic test system for voltage stability, PSS/E files",
        parts=(
            Part(
                "Nordic_voltage_collapse_0.sav",
                "https://drive.usercontent.google.com/download?export=download&confirm=t"
                "&id=13zo8O_qBv3oeTf2yfjvoW2vQIsgtn3vk",
                26699,
                "cdfeae242e3c2710107061a23563e9c2307d03e3e96def5e5c71b8a03c12f23e",
                "Nordic_voltage_collapse_0.sav",
                "3210eaeda8ed766f5fe0c330535bfaa51b54449c5be18d640c6193da61c98f50",
            ),
        ),
        primary="Nordic_voltage_collapse_0.sav",
        companions=(),
        expect=Expect(opens=False),
    ),
    Trial(
        key="uw145",
        entry="uw_dynamic",
        title="IEEE 145-bus, 50-generator dynamic test case (University of Washington archive)",
        parts=(
            Part(
                "dd50cdf.txt",
                _UW + "dyn50/dd50cdf.txt",
                87615,
                "2fb27dcc222f61382fccfb408dc825d1cd80b52eea9176bac84fb215d7c1775e",
            ),
        ),
        primary="dd50cdf.txt",
        companions=(),
        expect=Expect(opens=False),
    ),
    Trial(
        key="uw162",
        entry="uw_dynamic",
        title="IEEE 162-bus, 17-generator dynamic test case (University of Washington archive)",
        parts=(
            Part(
                "dd17cdf.txt",
                _UW + "dyn17/dd17cdf.txt",
                61281,
                "1caa0c2af1b74c4772906fabb0978722649b8454573fab36e7c6b6f2dd4b27f3",
            ),
        ),
        primary="dd17cdf.txt",
        companions=(),
        expect=Expect(opens=False),
    ),
)


def trial_keys() -> list[str]:
    return [trial.key for trial in TRIALS]


# ----------------------------------------------------------------------------------------
# Downloading (pure of the server)
# ----------------------------------------------------------------------------------------


class FetchError(Exception):
    """A file could not be downloaded, or is not the one the trial records."""


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_member(archive: bytes, member: str) -> bytes:
    """One named file of a ``.zip`` held in memory.

    The member is read by name and never extracted, so a name inside the archive cannot
    choose where anything is written.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            info = zf.getinfo(member)
            if info.file_size > MAX_DOWNLOAD:
                raise FetchError(f"{member!r} is {info.file_size} bytes, more than is read")
            return zf.read(info)
    except (zipfile.BadZipFile, KeyError) as exc:
        raise FetchError(f"the download holds no {member!r} ({exc})") from exc


def fetch(part: Part, cache: Path | None, download: Callable[[str], bytes] | None = None) -> bytes:
    """The bytes of ``part``'s file, downloaded (or read from ``cache``) and checked.

    The download is held to its recorded size and SHA-256, and a member of an archive to its
    own, so a source that changed is reported and not used.
    """
    cached = cache / f"{part.sha256}.bin" if cache is not None else None
    if cached is not None and cached.is_file():
        data = cached.read_bytes()
    else:
        data = (download or _download)(part.url)
        if cached is not None and sha256_of(data) == part.sha256:
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(data)
    if len(data) != part.size or sha256_of(data) != part.sha256:
        raise FetchError(
            f"{part.url} is {len(data)} bytes with SHA-256 {sha256_of(data)[:16]}..., not the "
            f"{part.size} bytes and {part.sha256[:16]}... recorded: the source changed (or the cached copy did)"
        )
    if part.member is None:
        return data
    member = read_member(data, part.member)
    if part.member_sha256 is not None and sha256_of(member) != part.member_sha256:
        raise FetchError(f"{part.member!r} of {part.url} is not the file recorded")
    return member


def _download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response:  # noqa: S310
            data: bytes = response.read(MAX_DOWNLOAD + 1)
    except (urllib.error.URLError, OSError) as exc:
        raise FetchError(f"could not download {url}: {exc}") from exc
    if len(data) > MAX_DOWNLOAD:
        raise FetchError(f"{url} is more than {MAX_DOWNLOAD} bytes")
    return data


# ----------------------------------------------------------------------------------------
# Measuring (pure)
# ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelRow:
    """What ANDES makes of one model of the dynamic data."""

    psse_model: str
    records: int
    status: Literal["as is", "approximated", "not supported"]
    andes_model: str | None


def classify_models(counts: Mapping[str, int], mapping: Mapping[str, str]) -> list[ModelRow]:
    """Each model of the dynamic data, with how ANDES reads it.

    ``mapping`` is ``psse-dyr.yaml`` reduced to ``{PSS/E model: ANDES model}``. A model it has
    is read as itself or, where the destination is another model, as that one (an
    approximation: the data of one model is given to another that has fewer parts); one it
    has not is left out, and a machine that depends on it cannot be built.
    """
    rows: list[ModelRow] = []
    for model, records in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        destination = mapping.get(model)
        if destination is None:
            rows.append(ModelRow(model, records, "not supported", None))
        elif destination == model:
            rows.append(ModelRow(model, records, "as is", destination))
        else:
            rows.append(ModelRow(model, records, "approximated", destination))
    return rows


@dataclass(frozen=True)
class Gap:
    """The largest difference between two sets of bus values, and where it is."""

    worst: float
    bus: str
    buses: int
    missing: int


def largest_gap(got: Mapping[str, float], want: Mapping[str, float]) -> Gap:
    """The largest ``|got - want|`` over the buses both have, and how many buses are in one only."""
    shared = [bus for bus in want if bus in got]
    missing = len(want) - len(shared)
    if not shared:
        return Gap(math.nan, "", 0, missing)
    worst_bus = max(shared, key=lambda bus: abs(got[bus] - want[bus]))
    return Gap(abs(got[worst_bus] - want[worst_bus]), worst_bus, len(shared), missing)


_TDS_SAYS: dict[str, str] = {
    "completes": "a run that completes",
    "fails": "a run that reaches its end time and is reported failed",
    "stops": "a run that stops before its end time",
    "refused": "a run the server refuses",
}
_AGREEMENT_SAYS: dict[str, str] = {
    "inside": "inside the bounds",
    "outside": "outside the bounds",
    "none": "no solution to compare with",
}


def _records(counts: Mapping[str, int]) -> str:
    """``GGOV1 367, EXPIC1 61``: the models of a count, the most records first."""
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return ", ".join(f"{model} {n}" for model, n in ranked) or "none"


def mismatches(expect: Expect, seen: Mapping[str, Any]) -> list[str]:
    """Where what a trial saw differs from what its catalog entry says.

    ``seen`` holds what ``trial_seen`` reports. A key it does not hold (the comparison with
    pandapower when no interpreter was given) is something that could not be seen, and is
    not held.
    """
    out: list[str] = []
    if seen.get("opens") is not expect.opens:
        out.append(f"opens with its dynamic data: expected {expect.opens}, saw {seen.get('opens')}")
    if expect.static_opens is not None and seen.get("static_opens") is not expect.static_opens:
        out.append(
            f"opens as a network alone: expected {expect.static_opens}, "
            f"saw {seen.get('static_opens')}"
        )
    if expect.pf is not None and seen.get("pf_converged") is not expect.pf:
        out.append(f"power flow converges: expected {expect.pf}, saw {seen.get('pf_converged')}")
    if expect.tds is not None and seen.get("tds") != expect.tds:
        out.append(
            f"10 s run: expected {_TDS_SAYS[expect.tds]}, "
            f"saw {_TDS_SAYS.get(str(seen.get('tds')), 'no run')}"
        )
    for key, want, what in (
        ("stored", expect.stored, "the solution the file stores"),
        ("solver", expect.solver, "pandapower's solution"),
    ):
        if want is not None and key in seen and seen[key] != want:
            out.append(
                f"power flow against {what}: expected {_AGREEMENT_SAYS[want]}, "
                f"saw {_AGREEMENT_SAYS.get(str(seen[key]), 'no comparison made')}"
            )
    for key, want, what in (
        ("approximated", expect.approximated, "read as another model"),
        ("unsupported", expect.unsupported, "left out"),
    ):
        if want is not None and dict(seen.get(key) or {}) != want:
            out.append(
                f"models {what}: expected {_records(want)}, saw {_records(seen.get(key) or {})}"
            )
    return out


# ----------------------------------------------------------------------------------------
# Reading the files with ANDES (needs ANDES, in this interpreter)
# ----------------------------------------------------------------------------------------


def dyr_model_counts(path: Path) -> dict[str, int]:
    """How many records of each PSS/E model a ``.dyr`` holds, as ANDES's own reader sees them."""
    from andes.io.psse import _read_dyr_dict

    return {model: len(frame) for model, frame in _read_dyr_dict(str(path)).items()}


def dyr_mapping() -> dict[str, str]:
    """``{PSS/E model: ANDES model}`` from the ``psse-dyr.yaml`` of the installed ANDES."""
    import andes.io.psse
    import yaml

    table = Path(andes.io.psse.__file__).with_name("psse-dyr.yaml")
    document = yaml.safe_load(table.read_text(encoding="utf-8"))
    return {model: str(spec["destination"]) for model, spec in document.items()}


def stored_state(path: Path) -> dict[str, Any] | None:
    """The bus voltages and angles the file stores, or ``None`` when ANDES cannot read it."""
    import andes
    from crosscheck_pf import stored_solution

    andes.config_logger(stream_level=40)
    try:
        system = andes.load(str(path), setup=False, no_output=True, default_config=True)
    except Exception:  # noqa: BLE001 (any parser failure means "cannot read")
        return None
    if system is None:
        return None
    try:
        return stored_solution(system)
    except CrosscheckError:
        return None


def pandapower_state(
    path: Path, verify_python: str | None, scratch: Path
) -> tuple[dict[str, Any] | None, str]:
    """pandapower's solution of the network ANDES reads from ``path``, or why there is none."""
    if not verify_python:
        return None, "no interpreter with pandapower was given (--verify-python)"
    import andes
    from crosscheck_pf import dump_network

    andes.config_logger(stream_level=40)
    try:
        system = andes.load(str(path), setup=False, no_output=True, default_config=True)
        if system is None:
            return None, "ANDES cannot read the file"
        system.setup()
        network = dump_network(system)
    except CrosscheckError as exc:
        return None, f"the network cannot be handed to pandapower: {exc}"
    except Exception as exc:  # noqa: BLE001
        return None, f"ANDES cannot read the file: {exc}"
    network["source"] = path.name
    dump = scratch / f"{path.stem}.network.json"
    dump.write_text(json.dumps(network), encoding="utf-8")
    proc = subprocess.run(
        [verify_python, str(SCRIPTS / "crosscheck_pf.py"), "solve", str(dump)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if proc.returncode != 0:
        return None, (proc.stderr.strip().splitlines() or ["pandapower failed"])[-1]
    try:
        return dict(json.loads(proc.stdout)), ""
    except ValueError:
        return None, "pandapower's answer was not JSON"


# ----------------------------------------------------------------------------------------
# One trial
# ----------------------------------------------------------------------------------------


@dataclass
class Compare:
    """A comparison of the power flow with a reference that is not TENSA's.

    ``kind`` says which reference it is (the state the file stores, or a solver), ``asked``
    whether the reference was asked for at all (no interpreter with pandapower was given),
    and ``passed`` stays ``None`` when the reference gave nothing to compare with.
    """

    reference: str
    kind: Literal["stored", "solver"] = "solver"
    asked: bool = True
    voltage_gap: float | None = None
    voltage_bus: str = ""
    angle_gap: float | None = None
    angle_bus: str = ""
    buses: int = 0
    loss_gap_mw: float | None = None
    slack_gap_mw: float | None = None
    loss_ok: bool | None = None
    slack_ok: bool | None = None
    voltage_tolerance: float = VOLTAGE_TOLERANCE
    angle_tolerance: float = ANGLE_TOLERANCE
    passed: bool | None = None
    note: str = ""


@dataclass
class TrialResult:
    key: str
    entry: str
    title: str
    files: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    models: list[ModelRow] = field(default_factory=list)
    opens: bool | None = None
    open_error: str | None = None
    open_messages: list[str] = field(default_factory=list)
    static_opens: bool | None = None
    static_error: str | None = None
    buses: int | None = None
    pf_converged: bool | None = None
    pf_iterations: int | None = None
    pf_mismatch: float | None = None
    pf_messages: list[str] = field(default_factory=list)
    comparisons: list[Compare] = field(default_factory=list)
    case_events: int = 0
    tds: TdsOutcome | None = None
    tds_text: str = ""
    tds_recorded: int = 0
    tds_left_out: int = 0
    tds_change: float | None = None
    tds_change_name: str | None = None
    tds_flat: bool | None = None
    tds_error: str | None = None
    tds_messages: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    seconds: float = 0.0

    @property
    def passed(self) -> bool:
        return self.error is None and not self.problems


def _messages(api: Api, session_id: str, *, keep: int, level: str = "warning") -> list[str]:
    """The last ``keep`` messages ANDES logged for the session, shortened to their first lines."""
    with contextlib.suppress(ApiError, OSError):
        reply = api.get(f"/sessions/{session_id}/messages", level=level, limit=2000)
        texts = [str(m["text"]) for m in reply["messages"]]
        return [_shorten(text) for text in texts[-keep:]]
    return []


def _shorten(text: str, lines: int = 4, width: int = 220) -> str:
    """The first lines of a message: ANDES logs whole tables, which a report does not need."""
    head = [line.strip()[:width] for line in text.strip().splitlines() if line.strip()][:lines]
    return " / ".join(head) + (" ..." if len(text.strip().splitlines()) > lines else "")


def _open(
    api: Api, primary: str, addfiles: list[str]
) -> tuple[str, dict[str, Any] | None, str | None]:
    """A session with the case in it: its id, its topology, or the reason it did not open."""
    session_id = str(api.post("/sessions")["session_id"])
    try:
        topology = api.post(
            f"/sessions/{session_id}/case",
            {"primary_path": primary, "addfiles": addfiles or None},
        )
    except ApiError as exc:
        return session_id, None, exc.detail
    return session_id, dict(topology), None


def _close(api: Api, session_id: str) -> None:
    with contextlib.suppress(ApiError, OSError):
        api.delete(f"/sessions/{session_id}")


def _power_bound(expected: float) -> float:
    """How far the losses or the slack's power (MW) may be from a solver's."""
    return POWER_TOLERANCE_MW + POWER_TOLERANCE_REL * abs(expected)


def compare_power_flow(
    pf: Mapping[str, Any], reference: Mapping[str, Any], label: str, *, stored: bool
) -> Compare:
    volts = {str(k): float(v) for k, v in (pf.get("bus_voltages") or {}).items()}
    angles = {str(k): math.degrees(float(v)) for k, v in (pf.get("bus_angles") or {}).items()}
    vgap = largest_gap(volts, reference["bus_voltage"])
    agap = largest_gap(angles, reference["bus_angle"])
    out = Compare(
        reference=label,
        kind="stored" if stored else "solver",
        voltage_gap=vgap.worst,
        voltage_bus=vgap.bus,
        angle_gap=agap.worst,
        angle_bus=agap.bus,
        buses=vgap.buses,
    )
    if stored:
        out.voltage_tolerance = STORED_VOLTAGE_TOLERANCE
        out.angle_tolerance = STORED_ANGLE_TOLERANCE
    else:
        summary = pf.get("summary") or {}
        if summary.get("loss_p") is not None and "loss_mw" in reference:
            out.loss_gap_mw = abs(float(summary["loss_p"]) - float(reference["loss_mw"]))
            out.loss_ok = out.loss_gap_mw <= _power_bound(float(reference["loss_mw"]))
        if summary.get("slack_p") is not None and "slack_p_mw" in reference:
            out.slack_gap_mw = abs(float(summary["slack_p"]) - float(reference["slack_p_mw"]))
            out.slack_ok = out.slack_gap_mw <= _power_bound(float(reference["slack_p_mw"]))
    out.passed = (
        vgap.missing == 0
        and agap.missing == 0
        and not math.isnan(vgap.worst)
        and vgap.worst <= out.voltage_tolerance
        and agap.worst <= out.angle_tolerance
        and out.loss_ok is not False
        and out.slack_ok is not False
    )
    if vgap.missing:
        out.note = f"{vgap.missing} buses of the reference are not in the power flow"
    return out


def run_trial(
    api: Api,
    workspace: Path,
    trial: Trial,
    data: Mapping[str, bytes],
    verify_python: str | None,
    scratch: Path,
) -> TrialResult:
    """Open, run and compare one trial whose files are in ``workspace``. Never raises."""
    result = TrialResult(trial.key, trial.entry, trial.title)
    result.files = [
        {
            "name": part.name,
            "url": part.url,
            "download_bytes": part.size,
            "download_sha256": part.sha256,
            "member": part.member,
            "bytes": len(data[part.name]),
            "sha256": sha256_of(data[part.name]),
        }
        for part in trial.parts
    ]
    primary = workspace / trial.primary
    try:
        counts: dict[str, int] = {}
        for part in trial.parts:
            if not part.name.lower().endswith(".dyr"):
                continue
            for model, n in dyr_model_counts(workspace / part.name).items():
                counts[model] = counts.get(model, 0) + n
        result.models = classify_models(counts, dyr_mapping()) if counts else []

        session_id, topology, why = _open(api, trial.primary, list(trial.companions))
        result.opens = topology is not None
        dynamic = bool(trial.companions) and topology is not None
        if topology is None:
            result.open_error = why
            result.open_messages = _messages(api, session_id, keep=6, level="info")
            _close(api, session_id)
            if trial.companions:
                # Without the dynamic data: is the network readable at all?
                session_id, topology, why = _open(api, trial.primary, [])
                result.static_opens = topology is not None
                if topology is None:
                    result.static_error = why
                    _close(api, session_id)
        try:
            if topology is not None:
                pf = _power_flow_and_run(api, session_id, topology, dynamic, result)
                _compare_reference(pf, primary, verify_python, scratch, result)
        finally:
            if topology is not None:
                _close(api, session_id)
    except Exception as exc:  # noqa: BLE001 (a trial that breaks is a result, not a crash)
        result.error = f"{type(exc).__name__}: {exc}"
    result.problems = mismatches(trial.expect, trial_seen(result))
    return result


def agreement(result: TrialResult, kind: Literal["stored", "solver"]) -> Agreement | None:
    """How the power flow stands to one reference, or ``None`` when it was not asked for."""
    for compare in result.comparisons:
        if compare.kind != kind:
            continue
        if not compare.asked:
            return None
        if compare.passed is None:
            return "none"
        return "inside" if compare.passed else "outside"
    return "none"


def models_with(result: TrialResult, status: str) -> dict[str, int]:
    """The models of the dynamic data ANDES reads in the way ``status`` says, with their records."""
    return {row.psse_model: row.records for row in result.models if row.status == status}


def trial_seen(result: TrialResult) -> dict[str, Any]:
    """What a trial saw, in the terms ``Expect`` states.

    The comparison with a reference that was not asked for is left out, so it is not held.
    """
    seen: dict[str, Any] = {
        "opens": result.opens,
        "static_opens": result.static_opens,
        "pf_converged": result.pf_converged,
        "tds": result.tds,
        "approximated": models_with(result, "approximated"),
        "unsupported": models_with(result, "not supported"),
    }
    for kind, found in (
        ("stored", agreement(result, "stored")),
        ("solver", agreement(result, "solver")),
    ):
        if found is not None:
            seen[kind] = found
    return seen


def _power_flow_and_run(
    api: Api,
    session_id: str,
    topology: Mapping[str, Any],
    dynamic: bool,
    result: TrialResult,
) -> dict[str, Any]:
    """Run the power flow and, when it converges, for a case with dynamics the 10 s run."""
    result.buses = len(topology["buses"])
    result.case_events = len([e for e in topology.get("events", []) if e.get("source") == "case"])
    pf = dict(api.post(f"/sessions/{session_id}/pflow", {}))
    result.pf_converged = bool(pf["converged"])
    result.pf_iterations = pf.get("iterations")
    result.pf_mismatch = float(pf["mismatch"]) if pf.get("mismatch") is not None else None
    result.pf_messages = _messages(api, session_id, keep=3)
    if result.pf_converged and dynamic:
        _undisturbed_run(api, session_id, result)
    return pf


def spread_variables(
    listing: Sequence[Mapping[str, Any]], limit: int = MAX_DAE_VARS
) -> tuple[list[str], int]:
    """The variables the undisturbed run records, and how many of the states are left out.

    A run records at most ``limit`` variables. A case with more states than that has each
    model keep an equal share of its own, in the order ANDES lists them: the first ``limit``
    would be all of the first models' and none of the last ones', and a state that moves in
    one of those would go unseen. The buses' voltages and angles come after, as far as there
    is room.
    """
    by_model: dict[str, list[str]] = {}
    for var in listing:
        if var["kind"] == "x":
            by_model.setdefault(str(var["model"]), []).append(str(var["name"]))
    states: list[str] = []
    depth = 0
    while len(states) < limit and any(len(names) > depth for names in by_model.values()):
        for names in by_model.values():
            if depth < len(names) and len(states) < limit:
                states.append(names[depth])
        depth += 1
    left_out = sum(len(names) for names in by_model.values()) - len(states)
    buses = [
        str(var["name"]) for var in listing if var["model"] == "Bus" and var["var"] in ("v", "a")
    ]
    return states + buses[: max(0, limit - len(states))], left_out


def tds_outcome(run: Mapping[str, Any], tf: float) -> TdsOutcome:
    """What an answered run did: ``completes``, ``fails`` (it reached ``tf`` and is reported
    failed) or ``stops`` (it ended short of ``tf``)."""
    if not abs(float(run.get("final_t", math.nan)) - tf) <= 1e-6:
        return "stops"
    return "completes" if run.get("converged") else "fails"


def _undisturbed_run(api: Api, session_id: str, result: TrialResult) -> None:
    recorded, result.tds_left_out = spread_variables(list_variables(api, session_id))
    result.tds_recorded = len(recorded)
    try:
        run = api.post(f"/sessions/{session_id}/tds", {"tf": UNDISTURBED_TF, "dae_vars": recorded})
    except ApiError as exc:
        result.tds, result.tds_error = "refused", exc.detail
    else:
        result.tds = tds_outcome(run, UNDISTURBED_TF)
        result.tds_text = completes(run, UNDISTURBED_TF)[1]
        # A run that stopped short is no measure of how far the states move, and one that
        # reached its end time and is reported failed is measured but not judged flat: the
        # states it integrates start from where ANDES says the initialisation went wrong.
        if result.tds in ("completes", "fails") and run.get("traces"):
            change, name = largest_change(trace_arrays(run["traces"])[1])
            result.tds_change, result.tds_change_name = change, name
            if result.tds == "completes":
                result.tds_flat = change <= FLAT_TOLERANCE
    if result.tds != "completes":
        result.tds_messages = [
            m
            for m in _messages(api, session_id, keep=60)
            if any(word in m for word in ("clamped", "residuals", "FAILED", "Error"))
        ][-4:]


def _compare_reference(
    pf: Mapping[str, Any],
    primary: Path,
    verify_python: str | None,
    scratch: Path,
    result: TrialResult,
) -> None:
    """Compare the power flow with the solution the file stores and with pandapower's.

    When the power flow did not converge there is nothing to compare, but pandapower is asked
    all the same: a network that it solves and ANDES does not is a finding about ANDES, one
    that neither solves is a finding about the data.
    """
    asked = verify_python is not None
    if not result.pf_converged:
        solved, why = pandapower_state(primary, verify_python, scratch)
        note = (
            "pandapower solves the network ANDES reads, which TENSA's power flow does not"
            if solved is not None
            else f"pandapower does not solve it either ({why})"
        )
        # A solution of pandapower's that TENSA's power flow has no counterpart for is outside
        # the bounds; one pandapower does not give either leaves nothing to compare.
        result.comparisons.append(
            Compare(
                reference="pandapower",
                asked=asked,
                passed=False if solved is not None else None,
                note=note,
            )
        )
        return
    stored = stored_state(primary)
    label = "the solution stored in the file"
    if stored is None:
        result.comparisons.append(
            Compare(reference=label, kind="stored", note="ANDES cannot read the file")
        )
    else:
        result.comparisons.append(compare_power_flow(pf, stored, label, stored=True))
    reference, why = pandapower_state(primary, verify_python, scratch)
    if reference is None:
        result.comparisons.append(Compare(reference="pandapower", asked=asked, note=why))
    else:
        result.comparisons.append(
            compare_power_flow(
                pf, reference, f"pandapower {reference.get('pandapower')}", stored=False
            )
        )


# ----------------------------------------------------------------------------------------
# The run, the reports
# ----------------------------------------------------------------------------------------


def select_trials(keys: Sequence[str]) -> list[Trial]:
    """The trials named, or all of them; an unknown key is an error naming the known ones."""
    if not keys:
        return list(TRIALS)
    known = {trial.key: trial for trial in TRIALS}
    unknown = [key for key in keys if key not in known]
    if unknown:
        raise ValueError(f"unknown trial {', '.join(unknown)}; the trials are {', '.join(known)}")
    return [known[key] for key in keys]


def run_trials(
    trials: Sequence[Trial],
    cache: Path | None,
    verify_python: str | None,
    log: Log = lambda text: None,
) -> list[TrialResult]:
    """Download and run each trial in one temporary workspace and one server."""
    results: list[TrialResult] = []
    with tempfile.TemporaryDirectory(prefix="tensa-external-") as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        scratch = root / "scratch"
        workspace.mkdir()
        scratch.mkdir()
        with running_server(workspace) as url:
            api = Api(url)
            for trial in trials:
                log(trial.key)
                data: dict[str, bytes] = {}
                try:
                    for part in trial.parts:
                        data[part.name] = fetch(part, cache)
                except FetchError as exc:
                    results.append(TrialResult(trial.key, trial.entry, trial.title, error=str(exc)))
                    continue
                for part in trial.parts:
                    (workspace / part.name).write_bytes(data[part.name])
                started = datetime.datetime.now(datetime.UTC)
                result = run_trial(api, workspace, trial, data, verify_python, scratch)
                result.seconds = (datetime.datetime.now(datetime.UTC) - started).total_seconds()
                results.append(result)
                for part in trial.parts:
                    (workspace / part.name).unlink(missing_ok=True)
    return results


def _fmt(value: float | None, unit: str = "") -> str:
    if value is None or math.isnan(value):
        return "-"
    return f"{value:.3g}{unit}"


_TDS_REPORT: dict[str, str] = {
    "completes": "completes",
    "fails": "fails: it reaches its end time, but ANDES's exit code is not 0 (a failed "
    "initialisation test sets it), so the run is reported failed",
    "stops": "stops before its end time",
    "refused": "refused: the server answered with an error and nothing ran",
}


def render_markdown(results: Sequence[TrialResult], generated: str) -> str:
    """The report as a Markdown page."""
    out = [
        "# External datasets in TENSA",
        "",
        f"Generated {generated} by `scripts/check_external_datasets.py`.",
        "",
    ]
    if any(not c.asked for r in results for c in r.comparisons):
        out += [
            "No interpreter with pandapower was given (`--verify-python`): the comparisons with "
            "it are not in this report, and what the entries say of them is not held.",
            "",
        ]
    out += [
        "| Trial | Entry | Opens (with dynamics) | Power flow | 10 s run | As expected |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        out.append(
            f"| {r.key} | {r.entry} | {r.opens} | {r.pf_converged} | {r.tds or '-'} | "
            f"{'yes' if r.passed else 'NO'} |"
        )
    out.append("")
    for r in results:
        out += [f"## {r.title} (`{r.key}`)", ""]
        if r.error:
            out += [f"Not run: {r.error}", ""]
            continue
        out.append("Files:")
        out += [f"- `{f['name']}` {f['bytes']} bytes, SHA-256 `{f['sha256']}`" for f in r.files]
        out.append("")
        if r.models:
            out += ["| PSS/E model | Records | ANDES reads it as |", "| --- | --- | --- |"]
            for m in r.models:
                what = {
                    "as is": f"{m.andes_model}",
                    "approximated": f"{m.andes_model} (approximation)",
                    "not supported": "not supported: left out",
                }[m.status]
                out.append(f"| {m.psse_model} | {m.records} | {what} |")
            out.append("")
        out.append(f"- Opens with its dynamic data: {r.opens}")
        if r.open_error:
            out.append(f"  - refused: {r.open_error}")
            out += [f"  - ANDES: {m}" for m in r.open_messages]
        if r.static_opens is not None:
            out.append(f"- Opens as a network alone: {r.static_opens}")
            if r.static_error:
                out.append(f"  - refused: {r.static_error}")
        if r.buses is not None:
            out.append(f"- {r.buses} buses, {r.case_events} events in the files")
        if r.pf_converged is not None:
            out.append(
                f"- Power flow: converged {r.pf_converged} in {r.pf_iterations} iterations, "
                f"mismatch {_fmt(r.pf_mismatch)}"
            )
            out += [f"  - ANDES: {m}" for m in r.pf_messages]
        for c in r.comparisons:
            if c.voltage_gap is None:
                out.append(f"- Against {c.reference}: not compared ({c.note})")
                continue
            extra = ""
            if c.loss_gap_mw is not None:
                extra = (
                    f", losses {_fmt(c.loss_gap_mw, ' MW')}, slack {_fmt(c.slack_gap_mw, ' MW')}"
                )
            out.append(
                f"- Against {c.reference}: voltage {_fmt(c.voltage_gap, ' pu')} (bus "
                f"{c.voltage_bus}, bound {c.voltage_tolerance:g}), angle "
                f"{_fmt(c.angle_gap, ' deg')} (bus {c.angle_bus}, bound {c.angle_tolerance:g}) "
                f"over {c.buses} buses{extra}: {'inside' if c.passed else 'OUTSIDE'} the bounds"
            )
        if r.tds is not None:
            out.append(f"- 10 s run with nothing acting on it: {_TDS_REPORT[r.tds]}")
            if r.tds_text:
                out.append(f"  - {r.tds_text}")
            if r.tds_change is not None:
                judged = (
                    f"flat: {r.tds_flat}"
                    if r.tds_flat is not None
                    else "not judged: the run is reported failed"
                )
                left = f", {r.tds_left_out} states not recorded" if r.tds_left_out else ""
                out.append(
                    f"  - largest change of a recorded variable {_fmt(r.tds_change)} "
                    f"({r.tds_change_name or 'none moved'}; {r.tds_recorded} variables recorded"
                    f"{left}); {judged}"
                )
            if r.tds_error:
                out.append(f"  - refused: {_shorten(r.tds_error, 2, 300)}")
            out += [f"  - ANDES: {m}" for m in r.tds_messages]
        out.append(f"- Time: {r.seconds:.1f} s")
        if r.problems:
            out += ["", "MISMATCH with what the catalog entry says:"]
            out += [f"- {p}" for p in r.problems]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def build_report(results: Sequence[TrialResult], generated: str) -> dict[str, Any]:
    return {
        "generated": generated,
        "passed": all(r.passed for r in results),
        "trials": [asdict(r) | {"passed": r.passed} for r in results],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0] if __doc__ else None,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("keys", nargs="*", metavar="KEY", help="the trials to run (default: all)")
    parser.add_argument("--list", action="store_true", help="list the trials and exit")
    parser.add_argument("--json", metavar="PATH", help="write the report as JSON")
    parser.add_argument("--markdown", metavar="PATH", help="write the report as Markdown")
    parser.add_argument("--cache", metavar="DIR", help="keep the downloads here between runs")
    parser.add_argument(
        "--verify-python",
        metavar="PYTHON",
        default=os.environ.get("TENSA_VERIFY_PYTHON"),
        help="an interpreter with pandapower (default: $TENSA_VERIFY_PYTHON)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.list:
        for trial in TRIALS:
            print(f"{trial.key:16} {trial.entry:16} {trial.title}")
        return 0
    try:
        trials = select_trials(args.keys)
    except ValueError as exc:
        print(f"check_external_datasets: {exc}", file=sys.stderr)
        return 2
    cache = Path(args.cache) if args.cache else None
    results = run_trials(
        trials, cache, args.verify_python, log=lambda text: print(f"... {text}", file=sys.stderr)
    )
    generated = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%d")
    markdown = render_markdown(results, generated)
    if args.json:
        Path(args.json).write_text(
            json.dumps(build_report(results, generated), indent=1, default=str) + "\n",
            encoding="utf-8",
        )
    if args.markdown:
        Path(args.markdown).write_text(markdown, encoding="utf-8", newline="\n")
    print(markdown)
    return 0 if all(r.passed for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
