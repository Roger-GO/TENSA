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
  assets), so the package serves a page instead of a 404;
* neither carries a source map (``*.map``), which would add about 10 MB for
  nothing;
* both carry the license text, and the sdist the build hook it needs to be built
  again.

Every problem is printed. The exit status is 1 when there was one, 2 for bad
usage, and 0 otherwise.
"""

from __future__ import annotations

import argparse
import sys
import tarfile
import zipfile
from collections.abc import Iterable
from email.parser import Parser
from pathlib import Path

from packaging.version import InvalidVersion, Version

WHEEL_UI = "tensa/static"
SDIST_UI = "src/tensa/static"


def _metadata_field(text: str, field: str) -> str | None:
    return Parser().parsestr(text, headersonly=True).get(field)


def _ui_problems(kind: str, names: Iterable[str], ui_dir: str) -> list[str]:
    names = list(names)
    problems: list[str] = []
    if f"{ui_dir}/index.html" not in names:
        problems.append(f"{kind} has no {ui_dir}/index.html: the web UI is not bundled")
    elif not any(n.startswith(f"{ui_dir}/assets/") for n in names):
        problems.append(f"{kind} has {ui_dir}/index.html but no {ui_dir}/assets/")
    maps = sorted(n for n in names if n.endswith(".map"))
    if maps:
        problems.append(f"{kind} ships source maps: {', '.join(maps)}")
    return problems


def _check_wheel(path: Path) -> tuple[str | None, list[str]]:
    """Return the wheel's version and its problems."""
    with zipfile.ZipFile(path) as wheel:
        names = wheel.namelist()
        metadata_names = [n for n in names if n.endswith(".dist-info/METADATA")]
        if len(metadata_names) != 1:
            return None, [f"{path.name} has no single .dist-info/METADATA"]
        metadata = wheel.read(metadata_names[0]).decode("utf-8")
    problems = _ui_problems(path.name, names, WHEEL_UI)
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
    names = list(members)
    problems = _ui_problems(path.name, names, SDIST_UI)
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
