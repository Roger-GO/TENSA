#!/usr/bin/env python3
"""Check the built distributions before they are published.

Usage: python scripts/check_dist.py DIST_DIR [--tag TAG]

DIST_DIR must hold the sdist and the wheel that ``python -m build`` made. The
checks are the ones a release must not skip:

* there is exactly one sdist and one wheel, both for ``tensa``, both the same
  version;
* with ``--tag``, that version is the one the git tag names (a leading ``v`` is
  ignored and the comparison is PEP 440, so ``v0.5.0-rc.1`` is ``0.5.0rc1``);
* the wheel and the sdist carry the built web UI (``index.html`` and its
  assets), so the package serves a page instead of a 404, and beside it
  ``THIRD-PARTY-LICENSES.txt``, the licences and notices of the libraries the UI
  bundles, which those licences ask to go with every copy;
* both carry the example catalog and its ``NOTICE.md``, and every case file the
  catalog bundles (kind ``bundled``), so a case it offers is never missing, and
  beside the file of an entry whose licence carries a notice (the NREL agreement
  of RTS-GMLC) the file that holds the notice, ``<file>-NOTICE.md``, which the
  licence asks to travel with every copy of the data;
* neither carries a source map (``*.map``), which would add about 10 MB for
  nothing;
* both carry the Sienna engine's Julia environment (the ``Project.toml`` and
  ``Manifest.toml`` of ``engines/sienna/envs/dyn``) and its Julia module
  (``engines/sienna/julia/TensaSienna.jl``), which ``tensa warm-cache --engine
  sienna`` installs from;
* both carry the license text, and the sdist the build hook it needs to be built
  again;
* both name the license as the SPDX expression in ``License-Expression`` (PEP 639),
  with no free-text ``License`` field (a build tool that predates PEP 639 fills it with
  the whole text of the license) and no ``License ::`` classifier.

Every problem is printed. The exit status is 1 when there was one, 2 for bad
usage, and 0 otherwise.
"""

from __future__ import annotations

import argparse
import json
import sys
import tarfile
import zipfile
from collections.abc import Iterable
from email.parser import Parser
from pathlib import Path, PurePosixPath

from packaging.version import InvalidVersion, Version

LICENSE_EXPRESSION = "GPL-3.0-or-later"
WHEEL_UI = "tensa/static"
SDIST_UI = "src/tensa/static"
# What the build of the UI writes beside its index.html (web/vite-plugins/thirdPartyLicenses.ts).
UI_LICENSES = "THIRD-PARTY-LICENSES.txt"
WHEEL_EXAMPLES = "tensa/examples"
SDIST_EXAMPLES = "src/tensa/examples"
# The Sienna engine's Julia side: the environment ``tensa warm-cache --engine
# sienna`` installs and the module the worker loads.
SIENNA_FILES = (
    "engines/sienna/envs/dyn/Project.toml",
    "engines/sienna/envs/dyn/Manifest.toml",
    "engines/sienna/julia/TensaSienna.jl",
)


def _sienna_problems(kind: str, names: Iterable[str], package_dir: str) -> list[str]:
    """The Julia environment and module of the Sienna engine must be in the archive."""
    names = set(names)
    return [
        f"{kind} has no {package_dir}/{path}: the Sienna engine's Julia files are not packaged"
        for path in SIENNA_FILES
        if f"{package_dir}/{path}" not in names
    ]


def _metadata_field(text: str, field: str) -> str | None:
    return Parser().parsestr(text, headersonly=True).get(field)


def _license_problems(kind: str, metadata: str) -> list[str]:
    """The license must be the expression, and not the free-text field PEP 639 replaced."""
    message = Parser().parsestr(metadata, headersonly=True)
    problems: list[str] = []
    found = message.get("License-Expression")
    if found != LICENSE_EXPRESSION:
        problems.append(f"{kind} has License-Expression {found!r}, not {LICENSE_EXPRESSION!r}")
    if message.get("License") is not None:
        problems.append(f"{kind} has a free-text License field: use License-Expression only")
    if any(c.startswith("License ::") for c in message.get_all("Classifier", [])):
        problems.append(f"{kind} has a License classifier, which License-Expression replaces")
    return problems


def _ui_problems(kind: str, names: Iterable[str], ui_dir: str) -> list[str]:
    names = list(names)
    problems: list[str] = []
    if f"{ui_dir}/index.html" not in names:
        problems.append(f"{kind} has no {ui_dir}/index.html: the web UI is not bundled")
    else:
        if not any(n.startswith(f"{ui_dir}/assets/") for n in names):
            problems.append(f"{kind} has {ui_dir}/index.html but no {ui_dir}/assets/")
        if f"{ui_dir}/{UI_LICENSES}" not in names:
            problems.append(
                f"{kind} has no {ui_dir}/{UI_LICENSES}: the licences of the libraries the UI "
                "bundles are not shipped with it"
            )
    maps = sorted(n for n in names if n.endswith(".map"))
    if maps:
        problems.append(f"{kind} ships source maps: {', '.join(maps)}")
    return problems


def _example_problems(
    kind: str, names: Iterable[str], catalog_text: str | None, examples_dir: str
) -> list[str]:
    """The catalog, its notice and every file it bundles must be in the archive."""
    names = set(names)
    problems = [
        f"{kind} has no {examples_dir}/{required}: the example cases are not packaged"
        for required in ("catalog.json", "NOTICE.md")
        if f"{examples_dir}/{required}" not in names
    ]
    if catalog_text is None:
        return problems
    try:
        entries = json.loads(catalog_text)["examples"]
        bundled = [
            path
            for entry in entries
            if entry["provenance"]["kind"] == "bundled"
            for path in [
                entry["provenance"]["path"],
                *(extra["path"] for extra in entry.get("extra_files", [])),
            ]
        ]
        noticed = [
            str(
                PurePosixPath(entry["provenance"]["path"]).with_name(
                    PurePosixPath(entry["provenance"]["path"]).stem + "-NOTICE.md"
                )
            )
            for entry in entries
            if entry["provenance"]["kind"] == "bundled" and entry.get("licence", {}).get("notice")
        ]
    except (ValueError, KeyError, TypeError):
        return [*problems, f"{kind} has an unreadable {examples_dir}/catalog.json"]
    problems += [
        f"{kind} has no {examples_dir}/cases/{path}, which the example catalog bundles"
        for path in bundled
        if f"{examples_dir}/cases/{path}" not in names
    ]
    # The notice a licence says must travel with the data is a file beside the data, so a
    # change to what the archive leaves out cannot ship the data without it.
    problems += [
        f"{kind} has no {examples_dir}/cases/{path}, which holds the licence notice of a file "
        "the example catalog bundles"
        for path in noticed
        if f"{examples_dir}/cases/{path}" not in names
    ]
    return problems


def _check_wheel(path: Path) -> tuple[str | None, list[str]]:
    """Return the wheel's version and its problems."""
    with zipfile.ZipFile(path) as wheel:
        names = wheel.namelist()
        metadata_names = [n for n in names if n.endswith(".dist-info/METADATA")]
        if len(metadata_names) != 1:
            return None, [f"{path.name} has no single .dist-info/METADATA"]
        metadata = wheel.read(metadata_names[0]).decode("utf-8")
        catalog = f"{WHEEL_EXAMPLES}/catalog.json"
        catalog_text = wheel.read(catalog).decode("utf-8") if catalog in names else None
    problems = _ui_problems(path.name, names, WHEEL_UI)
    problems += _example_problems(path.name, names, catalog_text, WHEEL_EXAMPLES)
    problems += _sienna_problems(path.name, names, "tensa")
    problems += _license_problems(path.name, metadata)
    if not any(n.endswith(".dist-info/licenses/LICENSE") for n in names):
        problems.append(f"{path.name} has no license file under .dist-info/licenses/")
    if _metadata_field(metadata, "Name") != "tensa":
        problems.append(f"{path.name} is not the tensa distribution")
    return _metadata_field(metadata, "Version"), problems


def _check_sdist(path: Path) -> tuple[str | None, list[str]]:
    """Return the sdist's version and its problems."""
    with tarfile.open(path, "r:gz") as sdist:
        # Names are ``tensa-<version>/<path>``; the check wants the path.
        members = {m.name.split("/", 1)[1]: m for m in sdist.getmembers() if "/" in m.name}
        info = members.get("PKG-INFO")
        if info is None or (stream := sdist.extractfile(info)) is None:
            return None, [f"{path.name} has no PKG-INFO"]
        metadata = stream.read().decode("utf-8")
        catalog = members.get(f"{SDIST_EXAMPLES}/catalog.json")
        catalog_stream = sdist.extractfile(catalog) if catalog is not None else None
        catalog_text = catalog_stream.read().decode("utf-8") if catalog_stream else None
    names = list(members)
    problems = _ui_problems(path.name, names, SDIST_UI)
    problems += _example_problems(path.name, names, catalog_text, SDIST_EXAMPLES)
    problems += _sienna_problems(path.name, names, "src/tensa")
    problems += _license_problems(path.name, metadata)
    for required in ("LICENSE", "hatch_build.py", "pyproject.toml"):
        if required not in members:
            problems.append(f"{path.name} has no {required}")
    if _metadata_field(metadata, "Name") != "tensa":
        problems.append(f"{path.name} is not the tensa distribution")
    return _metadata_field(metadata, "Version"), problems


def check(dist_dir: Path, tag: str | None = None) -> list[str]:
    """Return every problem found in ``dist_dir`` (empty when it is fine to publish)."""
    wheels = sorted(dist_dir.glob("*.whl"))
    sdists = sorted(dist_dir.glob("*.tar.gz"))
    problems: list[str] = []
    if len(wheels) != 1:
        problems.append(f"expected one wheel in {dist_dir}, found {len(wheels)}")
    if len(sdists) != 1:
        problems.append(f"expected one sdist in {dist_dir}, found {len(sdists)}")
    if problems:
        return problems

    wheel_version, wheel_problems = _check_wheel(wheels[0])
    sdist_version, sdist_problems = _check_sdist(sdists[0])
    problems += wheel_problems + sdist_problems
    if wheel_version != sdist_version:
        problems.append(f"the wheel is version {wheel_version} but the sdist is {sdist_version}")
    if tag is not None and wheel_version is not None:
        try:
            tagged = Version(tag.removeprefix("v"))
            built = Version(wheel_version)
        except InvalidVersion:
            problems.append(f"cannot compare tag {tag!r} with version {wheel_version!r}")
        else:
            if tagged != built:
                problems.append(f"tag {tag} names version {tagged}, but the package is {built}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check the built distributions before they are published."
    )
    parser.add_argument("dist_dir", type=Path, help="directory holding the sdist and the wheel")
    parser.add_argument("--tag", help="git tag the release was made from, e.g. v0.5.0")
    args = parser.parse_args(argv)

    if not args.dist_dir.is_dir():
        parser.error(f"{args.dist_dir} is not a directory")
    problems = check(args.dist_dir, args.tag)
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"ok: {', '.join(sorted(p.name for p in args.dist_dir.iterdir()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
