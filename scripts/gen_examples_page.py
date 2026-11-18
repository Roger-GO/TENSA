#!/usr/bin/env python3
"""Write ``docs/examples.md``, the page of the example cases, from the catalog.

Usage: python scripts/gen_examples_page.py [--check]

The page is written from ``server/src/tensa/examples/catalog.json``, the one record of
every example case (what it is, where it comes from, how to cite it, its licence, what was
changed and what was checked), so it cannot say anything the catalog does not. Edit the
catalog and run this script. ``--check`` writes nothing and exits 1 when the page on disk is
not the one the catalog gives, which is what a test and CI hold the repository to.

``render_page`` needs only a catalog, so the tests feed it small hand-written ones as well as
the real one. Text from the catalog goes into Markdown as it is, and the catalog holds no
long dash (the documentation does not use it); a table cell has its pipes escaped.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import TYPE_CHECKING

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_SRC = REPO_ROOT / "server" / "src"
PAGE = REPO_ROOT / "docs" / "examples.md"

if TYPE_CHECKING:
    from tensa.core.example_catalog import Catalog, Example

ANALYSIS_NAMES = {"pf": "Power flow", "tds": "Time domain", "eig": "Eigenvalues"}
SOURCE_NAMES = {"andes": "Your ANDES install", "bundled": "Bundled with TENSA", "external": "Link"}
CHECK_KINDS = {
    "independent-solver": "an independent solver",
    "published": "a published result",
    "stored-solution": "a solution stored with the source",
    "ring-down": "the ring-down of a time-domain run",
    "regression-baseline": "TENSA's own earlier output (a baseline, not a verification)",
}

INTRO = """\
# Example cases

TENSA has a catalog of example cases: power systems you can add to your workspace and open
at once. Each entry says what the case is for, how large it is, what you can run on it, where
its data comes from, how to cite it, which licence it is under, what was changed in the
data, what to be careful about and how its results were checked.

This page is written from the catalog (`server/src/tensa/examples/catalog.json`) by
`scripts/gen_examples_page.py`, so it says what the program says. Do not edit it by hand.

## Adding a case

The cases marked as first run are copied into an empty workspace the first time the server
starts. Any case can be added later. In the app, **Example cases** lists them: it is the button
in the Workspace part of the Project tab, an item of the Workspace menu and a command in the
command palette. The cases are grouped by what they support. **Add to workspace** copies a
case's file in and **Open** loads it. **Cite** shows its references, each marked as the publication of
the system, the source of the data, the software or a dynamic model, and copies them as text or
as BibTeX with those marks, and the links to its source and licence open in a new tab. A case that is only links
to data TENSA does not hold has an **Open source page** link instead. From the command line:

```bash
tensa examples list
tensa examples add ieee14
tensa examples cite ieee14
```

`tensa examples add` leaves a file that is already in the workspace alone, and `--force`
replaces it. `tensa examples cite` prints the plain-text citations of a case and `--bibtex`
prints them as BibTeX. The same is available from the API (`GET /api/examples` and
`POST /api/examples/{id}/add`) and to an assistant as the MCP tools `list_examples` and
`add_example`.

Whenever a case is added, TENSA writes `EXAMPLE-SOURCES.md` in the workspace root. It records
the source, the citations and the licence of everything that was added, next to the files
themselves. It is not a case file and the file list does not show it.

A case that comes from ANDES is copied from the ANDES installed on your machine, not from
TENSA. If the file there is not the one the catalog was written against, TENSA adds it anyway
and warns you, because the results may then differ from the ones documented here.

A workspace can hold another file under the name of a case that TENSA bundles: an earlier
release put a different file there (the WSCC 9-bus case was ANDES's network with no machines
until this one), or the file was edited. Adding the case does not replace it. The card then
says **Different file** and not **Added**, and **Replace with this version** puts the shipped
file in its place once you have confirmed it, since that overwrites your copy.
`tensa examples list` says `added, differs` for such a case, `GET /api/examples` sets its
`differs` field, and `tensa examples add --force` or `overwrite=true` replaces the file.

## The cases
"""


def _bootstrap() -> None:
    """Make ``tensa`` importable from a checkout that has not installed it."""
    if SERVER_SRC.is_dir() and str(SERVER_SRC) not in sys.path:
        sys.path.insert(0, str(SERVER_SRC))


def _cell(text: str) -> str:
    return " ".join(text.split()).replace("|", "\\|")


def _analyses(example: Example) -> str:
    return ", ".join(ANALYSIS_NAMES[a] for a in example.analyses) or "-"


def _size(example: Example) -> str:
    if example.size is None:
        return "-"
    return f"{example.size.buses} buses, {example.size.generators} generators"


def _source_paragraph(example: Example) -> str:
    prov = example.provenance
    if prov.kind == "external":
        return "TENSA holds no file of this case; the links below say where to get it."
    came = f" from <{prov.source_url}>" if prov.source_url else ""
    when = f", retrieved {prov.retrieved.isoformat()}" if prov.retrieved else ""
    if prov.built:
        # TENSA writes this file itself; the URL is the script, not a place it was fetched from.
        script = f" with the script at <{prov.source_url}>" if prov.source_url else ""
        day = f", written {prov.retrieved.isoformat()}" if prov.retrieved else ""
        return (
            f"Bundled with TENSA as `{prov.path}`. TENSA builds this file itself{script}{day}; "
            f"it is not retrieved from anywhere. SHA-256 `{prov.sha256}`."
        )
    if prov.kind == "bundled":
        return f"Bundled with TENSA as `{prov.path}`{came}{when}. SHA-256 `{prov.sha256}`."
    text = (
        f"Copied from your own ANDES installation (`andes/cases/{prov.path}`); TENSA does not "
        f"redistribute it. The catalog recorded the file as of {prov.release or 'ANDES'}, with "
        f"SHA-256 `{prov.sha256}`, and warns when the file on your machine is a different one."
    )
    if prov.source_url:
        text += f" The recorded file is{came}{when}."
    return text


def _licence_paragraph(example: Example) -> str:
    licence = example.licence
    text = f"[{licence.name}]({licence.url})" if licence.url else licence.name
    if licence.attribution:
        text += f". {licence.attribution}"
    return text


def _render_example(example: Example) -> list[str]:
    from tensa.core.example_catalog import CITATION_ROLE_LABELS, citation_bibtex, quoted_notice

    out = [f"### {example.title} {{ #{example.id} }}", "", example.summary, ""]
    kind = "Dynamic" if example.category == "dynamic" else "Steady state"
    out += [f"- **Id:** `{example.id}`", f"- **Kind:** {kind}", f"- **Size:** {_size(example)}"]
    out.append(f"- **Analyses:** {_analyses(example)}")
    if example.has_file:
        names = ", ".join(f"`{f.name}`" for f in example.files())
        out.append(f"- **First run:** {'yes' if example.default else 'no'}")
        out.append(f"- **File:** {names}")
    out += ["", f"**Source.** {_source_paragraph(example)}", ""]
    out += [f"**Licence.** {_licence_paragraph(example)}", ""]
    if example.licence.notice:
        out += [
            "The licence asks that this notice appear, in full, in every copy of the data:",
            "",
            *quoted_notice(example.licence.notice),
            "",
        ]

    if example.citations:
        out += ["**Citations**", ""]
        for citation in example.citations:
            line = f"- **{CITATION_ROLE_LABELS[citation.role]}:** {citation.text}"
            if citation.doi:
                line += f" [DOI](https://doi.org/{citation.doi})"
            elif citation.url:
                line += f" [Link]({citation.url})"
            out.append(line)
        out += ["", "BibTeX:", ""]
        for citation in example.citations:
            out += ["```bibtex", citation_bibtex(citation), "```", ""]
    if example.links:
        out += ["**Links**", ""]
        for link in example.links:
            out.append(f"- [{link.title}]({link.url})" + (f": {link.note}" if link.note else ""))
        out.append("")

    out += ["**Changes to the data.** " + ("; ".join(example.modifications) or "None."), ""]
    if example.caveats:
        out += ["**Caveats**", ""]
        out += [f"- {caveat}" for caveat in example.caveats]
        out.append("")

    verification = example.verification
    if verification is None:
        out += ["**Verification.** No verification is recorded for this case yet.", ""]
    else:
        out += [f"**Verification.** {verification.summary}", ""]
        if verification.checks:
            out += [
                "| Check | Compared with | Reference | Tolerance | Result | Passed |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
            for check in verification.checks:
                out.append(
                    f"| {_cell(check.name)} | {CHECK_KINDS[check.kind]} | "
                    f"{_cell(check.reference)} | {_cell(check.tolerance)} | "
                    f"{_cell(check.result)} | {'yes' if check.passed else 'no'} |"
                )
            out.append("")
    return out


def render_page(catalog: Catalog) -> str:
    """The text of ``docs/examples.md`` for ``catalog``."""
    out = [INTRO.rstrip("\n"), ""]
    out += ["| Case | Size | Analyses | First run | Source |", "| --- | --- | --- | --- | --- |"]
    for example in catalog.examples:
        out.append(
            f"| [{_cell(example.title)}](#{example.id}) | {_size(example)} | "
            f"{_analyses(example)} | {'yes' if example.default else 'no'} | "
            f"{SOURCE_NAMES[example.provenance.kind]} |"
        )
    out.append("")
    for example in catalog.examples:
        out += _render_example(example)
    return "\n".join(out).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write docs/examples.md from the example catalog.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing; exit 1 when docs/examples.md is not what the catalog gives",
    )
    args = parser.parse_args(argv)

    _bootstrap()
    from tensa.core.example_catalog import load_catalog

    page = render_page(load_catalog())
    if args.check:
        current = PAGE.read_text(encoding="utf-8") if PAGE.is_file() else None
        if current != page:
            print(
                "docs/examples.md is out of date with the example catalog: "
                "run python scripts/gen_examples_page.py",
                file=sys.stderr,
            )
            return 1
        return 0
    PAGE.write_text(page, encoding="utf-8", newline="\n")
    print(f"wrote {PAGE.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
