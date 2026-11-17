"""The catalog of example cases: what each one is, where it came from and how it may be used.

``server/src/tensa/examples/catalog.json`` is the one record of every example case TENSA
can put in a workspace. This module holds its schema and loads it, and everything that
shows a case, adds one, cites one or documents one reads it from here: the first-run
seeder, ``GET /examples``, ``tensa examples``, the MCP tools and the documentation page.

An entry is one of three kinds, by where its files are:

- ``andes``: a file of the user's own installed ANDES (``andes/cases/<path>``). TENSA
  copies it when it is added and does not redistribute it. ``sha256`` is the checksum of
  the copy the entry was written against, so a different release of ANDES is noticed.
- ``bundled``: a file shipped in this package under ``examples/cases/<path>``, with the
  URL it was taken from, the day it was taken and its checksum.
- ``external``: no file at all, only links, for data that cannot be redistributed or is
  not loadable as it is.

The models are defined here, not in ``api/schemas``, because the seeder, the command line
and the documentation script read them without the API. A model is validated when the
catalog is loaded, so a catalog that does not hold together (a path that leaves the
folder it names, two entries that would write one file, a default that is not a file)
fails the tests and the first start, not a user who adds a case.

This module imports nothing heavy (no ANDES).
"""

from __future__ import annotations

import functools
import hashlib
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from tensa.security.names import portable_name_problem

# The extensions the workspace lister shows (see
# ``tensa.api.routes.workspace._ALLOWED_EXTENSIONS``): a case file the catalog names
# must be one of them, or it would be added and never listed.
SUPPORTED_CASE_EXTENSIONS: frozenset[str] = frozenset({".xlsx", ".raw", ".dyr", ".json", ".m"})

# The name of a layout sidecar's suffix: a file ending in it is not a case.
_LAYOUT_SUFFIX = ".layout.json"

# The longest file name the common file systems accept, in UTF-8 bytes.
_MAX_NAME_BYTES = 255

CATALOG_VERSION = 1

Analysis = Literal["pf", "tds", "eig"]
CheckKind = Literal[
    "independent-solver", "published", "stored-solution", "ring-down", "regression-baseline"
]

_Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
_Url = Annotated[str, StringConstraints(pattern=r"^https?://\S+$", max_length=500)]
_Doi = Annotated[str, StringConstraints(pattern=r"^10\.\d{4,9}/\S+$", max_length=200)]
_Id = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]*$", max_length=40)]


class CatalogError(Exception):
    """The catalog file is missing, unreadable or does not validate."""


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def case_file_problem(path: str) -> str | None:
    """Why ``path`` is not a safe place for a catalog file, or ``None``.

    ``path`` is joined to the folder of the ANDES cases or of the bundled ones, and its
    last component is the name the file gets in a workspace, so it must stay inside that
    folder and be a name every platform keeps, that the lister shows and that is a case.
    """
    if not path or "\\" in path or "\x00" in path:
        return "is empty or has a backslash or a NUL"
    pure = PurePosixPath(path)
    parts = path.split("/")
    if pure.is_absolute() or any(part in ("", ".", "..") for part in parts):
        return "is not a relative path inside the folder it names"
    # Every part, not only the file name: ``C:/x.xlsx`` joined to a folder on Windows is the
    # drive's file, and a folder called ``CON`` is a device.
    for part in parts:
        problem = portable_name_problem(part)
        if problem is not None:
            return f"has a part {part!r} that {problem}"
    name = pure.name
    problem = None
    if name.startswith("."):
        problem = "starts with a dot, so the workspace would not list it"
    elif len(name.encode("utf-8")) > _MAX_NAME_BYTES:
        problem = f"is longer than {_MAX_NAME_BYTES} bytes"
    if problem is not None:
        return f"has a file name that {problem}"
    if pure.suffix.lower() not in SUPPORTED_CASE_EXTENSIONS:
        return f"is not one of {', '.join(sorted(SUPPORTED_CASE_EXTENSIONS))}"
    if name.lower().endswith(_LAYOUT_SUFFIX):
        return "names a layout sidecar, which is not a case"
    return None


class CaseSize(_Model):
    buses: int = Field(..., ge=1, description="Number of buses.")
    generators: int = Field(
        ..., ge=0, description="Number of generators (static generators, slack included)."
    )


class Provenance(_Model):
    kind: Literal["bundled", "andes", "external"] = Field(
        ...,
        description=(
            "Where the case file is: ``andes`` is the user's own installed ANDES, "
            "``bundled`` ships with TENSA, ``external`` is no file at all, only links."
        ),
    )
    path: str | None = Field(
        None,
        description=(
            "The case file, relative to ``andes/cases`` of the installed ANDES (``andes``) or "
            "to the bundled cases folder of the package (``bundled``). ``null`` for ``external``."
        ),
    )
    sha256: _Sha256 | None = Field(
        None,
        description=(
            "SHA-256 of the file as it was when the entry was written. TENSA warns when an "
            "installed ANDES holds a different file and refuses a bundled file that differs."
        ),
    )
    release: str | None = Field(
        None,
        description="The release or tag the checksum was taken from, such as ``ANDES 2.0.0``.",
        max_length=80,
    )
    source_url: _Url | None = Field(
        None,
        description=(
            "Where the file comes from, pinned to a release or a commit where the host allows "
            "it."
        ),
    )
    retrieved: date | None = Field(
        None, description="The day the file was retrieved from ``source_url``."
    )


class ExtraFile(_Model):
    path: str = Field(
        ...,
        description=(
            "A file the case is loaded with (a ``.dyr`` beside a ``.raw``), relative to the "
            "same folder as the primary file."
        ),
    )
    sha256: _Sha256 = Field(..., description="SHA-256 of the file.")
    role: str = Field(
        ..., description="What the file adds, such as ``dynamic data``.", max_length=120
    )


class Citation(_Model):
    text: str = Field(..., description="The reference as plain text.", max_length=1200)
    bibtex: str = Field(..., description="The same reference as a BibTeX entry.", max_length=2000)
    doi: _Doi | None = Field(None, description="The DOI, where the work has one.")
    url: _Url | None = Field(None, description="Where the work can be read or found.")


class Licence(_Model):
    name: str = Field(..., description="The licence, as its own text names it.", max_length=200)
    url: _Url | None = Field(None, description="Where the licence text is.")
    attribution: str | None = Field(
        None, description="The credit the licence asks a user of the data to give.", max_length=1200
    )


class VerificationCheck(_Model):
    name: str = Field(..., description="What was checked.", max_length=200)
    kind: CheckKind = Field(
        ...,
        description=(
            "What the outputs were compared with: ``independent-solver``, ``published``, "
            "``stored-solution``, ``ring-down`` (a mode seen in a time-domain run) or "
            "``regression-baseline`` (TENSA's own earlier output, so not a verification)."
        ),
    )
    reference: str = Field(..., description="The reference, named so it can be found.")
    tolerance: str = Field(..., description="How close the outputs had to be.")
    result: str = Field(..., description="What was found.")
    passed: bool = Field(..., description="Whether the result is inside the tolerance.")


class Verification(_Model):
    summary: str = Field(..., description="What was verified and how, in a few sentences.")
    checks: list[VerificationCheck] = Field(
        default_factory=list, description="Each check, with its reference, tolerance and result."
    )


class Link(_Model):
    title: str = Field(..., description="What the link points at.", max_length=200)
    url: _Url = Field(..., description="The address.")
    note: str | None = Field(None, description="What to know before following it.")


@dataclass(frozen=True)
class CaseFile:
    """One file of an entry: where it is read from, and the name it takes in a workspace."""

    path: str
    name: str
    sha256: str
    primary: bool


class Example(_Model):
    id: _Id = Field(..., description="Short name of the case, used by every command and route.")
    title: str = Field(..., description="The case's name as it is shown.", max_length=120)
    summary: str = Field(..., description="What the case is for, in a sentence or two.")
    category: Literal["dynamic", "steady-state"] = Field(
        ...,
        description=(
            "``dynamic`` cases carry machine models and can be simulated in the time domain; "
            "``steady-state`` cases hold a network and its loading only."
        ),
    )
    tags: list[str] = Field(default_factory=list, description="Words the case is found by.")
    size: CaseSize | None = Field(
        None, description="Buses and generators. Required for an entry that has a file."
    )
    analyses: list[Analysis] = Field(
        default_factory=list,
        description=(
            "What the case supports: ``pf`` power flow, ``tds`` time domain, ``eig`` eigenvalues."
        ),
    )
    default: bool = Field(
        False, description="Whether the case is put in an empty workspace when the server starts."
    )
    provenance: Provenance = Field(..., description="Where the file comes from.")
    extra_files: list[ExtraFile] = Field(
        default_factory=list, description="Files the case is loaded with, besides the primary."
    )
    citations: list[Citation] = Field(
        default_factory=list,
        description="The publications of the system and of the dataset the file comes from.",
    )
    licence: Licence = Field(..., description="The terms the data is distributed under.")
    modifications: list[str] = Field(
        default_factory=list, description="Every change made to the data of the source."
    )
    caveats: list[str] = Field(
        default_factory=list, description="What a user should know before relying on the case."
    )
    verification: Verification | None = Field(
        None, description="How the case's results were checked, where that has been done."
    )
    links: list[Link] = Field(
        default_factory=list, description="Where to get the data of an ``external`` entry."
    )

    @model_validator(mode="after")
    def _holds_together(self) -> Self:
        prov = self.provenance
        problems: list[str] = []
        if prov.kind == "external":
            if prov.path or prov.sha256 or self.extra_files:
                problems.append("an external entry has no file")
            if self.default:
                problems.append("an external entry cannot be a default")
            if not self.links:
                problems.append("an external entry needs links")
        else:
            if not prov.path or not prov.sha256:
                problems.append(f"a {prov.kind} entry needs the path and the sha256 of its file")
            if self.size is None:
                problems.append("an entry with a file needs a size")
            if not self.analyses:
                problems.append("an entry with a file needs at least one analysis")
            if prov.kind == "bundled" and (prov.source_url is None or prov.retrieved is None):
                problems.append("a bundled entry needs the source_url and the day it was retrieved")
        for path in [prov.path, *(extra.path for extra in self.extra_files)]:
            if path is not None and (why := case_file_problem(path)):
                problems.append(f"file {path!r} {why}")
        if len(set(self.analyses)) != len(self.analyses):
            problems.append("an analysis is listed twice")
        if self.category == "steady-state" and set(self.analyses) - {"pf"}:
            problems.append("a steady-state case supports a power flow only")
        if self.category == "dynamic" and prov.kind != "external" and "tds" not in self.analyses:
            problems.append("a dynamic case supports a time-domain run")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @property
    def has_file(self) -> bool:
        return self.provenance.kind != "external"

    def files(self) -> list[CaseFile]:
        """The files of the entry, the primary first, as ``CaseFile`` (empty for ``external``)."""
        prov = self.provenance
        if prov.path is None or prov.sha256 is None:
            return []
        files = [CaseFile(prov.path, PurePosixPath(prov.path).name, prov.sha256, True)]
        files += [
            CaseFile(extra.path, PurePosixPath(extra.path).name, extra.sha256, False)
            for extra in self.extra_files
        ]
        return files


class Catalog(_Model):
    version: Literal[1] = Field(..., description="The version of the catalog's schema.")
    examples: list[Example] = Field(..., description="Every example case, in the order shown.")

    @model_validator(mode="after")
    def _holds_together(self) -> Self:
        problems: list[str] = []
        ids = [example.id for example in self.examples]
        problems += [f"id {i!r} is used twice" for i in sorted(set(ids)) if ids.count(i) > 1]
        # A workspace is one folder, and Windows and macOS keep names case-insensitively, so
        # two entries must not write one name whatever its case.
        writers: dict[str, list[str]] = {}
        for example in self.examples:
            for file in example.files():
                writers.setdefault(file.name.casefold(), []).append(example.id)
        problems += [
            f"the file name {name!r} would be written by {', '.join(who)}"
            for name, who in writers.items()
            if len(who) > 1
        ]
        if problems:
            raise ValueError("; ".join(problems))
        return self

    def get(self, example_id: str) -> Example | None:
        return next((e for e in self.examples if e.id == example_id), None)

    def defaults(self) -> list[Example]:
        """The entries put in an empty workspace, in catalog order."""
        return [e for e in self.examples if e.default]


def examples_dir() -> Path:
    """The folder of the package that holds the catalog, ``NOTICE.md`` and the bundled cases."""
    return Path(__file__).resolve().parent.parent / "examples"


def bundled_cases_dir() -> Path:
    return examples_dir() / "cases"


def parse_catalog(text: str) -> Catalog:
    """The catalog a JSON text holds, or ``CatalogError`` naming what is wrong with it."""
    try:
        return Catalog.model_validate_json(text)
    except ValueError as exc:  # pydantic's ValidationError is a ValueError
        raise CatalogError(f"the example catalog is not valid: {exc}") from exc


@functools.cache
def load_catalog() -> Catalog:
    """The catalog shipped in the package (read once; the file does not change at run time)."""
    path = examples_dir() / "catalog.json"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CatalogError(f"cannot read the example catalog {path.name}: {exc}") from exc
    return parse_catalog(text)


def file_sha256(path: Path) -> str:
    """Hex SHA-256 of the file at ``path``."""
    return hashlib.sha256(path.read_bytes()).hexdigest()
