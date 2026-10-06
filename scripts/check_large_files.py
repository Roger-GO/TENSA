#!/usr/bin/env python3
"""Fail a change that puts a large file into the repository.

Usage: python scripts/check_large_files.py [--base REF] [--head REF] [--max-bytes N]
                                          [--allow-file PATH] [--repo DIR]

Everything committed stays in every clone for good, and the project does not rewrite its
history to take a file back out, so the one moment to stop a large file is before it is
merged. The check looks at what the change comes to: the files that differ between the
commit it started from (the merge base of ``--base`` and ``--head``) and ``--head``. A file
is reported when it is bigger than ``--max-bytes`` (1 MiB unless told otherwise) and the
change either adds it or makes it bigger. So

* a large file the change does not touch is never reported, which is why the demo video and
  GIF the README embeds (``docs/demo/ieee9-agent-demo.mp4``, ``docs/img/demo.gif``) pass;
* a large file that is moved, or that shrinks, passes;
* a path listed in ``.github/large-files-allowed.txt`` passes: one path per line, blank
  lines and ``#`` comments ignored. Adding a line there is how a change says that a large
  file belongs in the repository, in a place a reviewer sees.

Sizes are the sizes of the blobs git stores, read from the object database, so no checkout
of either side is needed. The history must hold the merge base: a shallow clone needs
``fetch-depth: 0`` (``.github/workflows/large-files.yml`` does that).

Every file found is printed. The exit status is 1 when there was one, 2 for bad usage or a
git failure, and 0 otherwise.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LIMIT = 1024 * 1024
ALLOW_FILE = ".github/large-files-allowed.txt"

# The mode git records for a submodule: the entry names a commit, not a blob.
_GITLINK = "160000"


class GitError(Exception):
    """A git command failed, or the history cannot answer the question."""


class Change(NamedTuple):
    """A file the change adds or alters, with its size now and before."""

    path: str
    size: int
    # None for a file the change adds.
    before: int | None


def _run(repo: Path, *args: str, stdin: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            ["git", "-C", str(repo), *args], input=stdin, capture_output=True, check=False
        )
    except FileNotFoundError as exc:
        raise GitError("git is not installed") from exc


def _detail(done: subprocess.CompletedProcess[bytes]) -> str:
    return done.stderr.decode("utf-8", errors="replace").strip()


def _git(repo: Path, *args: str, stdin: bytes | None = None) -> bytes:
    done = _run(repo, *args, stdin=stdin)
    if done.returncode != 0:
        detail = _detail(done)
        raise GitError(f"git {args[0]} failed" + (f": {detail}" if detail else ""))
    return done.stdout


def merge_base(repo: Path, base: str, head: str) -> str:
    """The commit the change started from, the newest one ``base`` and ``head`` share."""
    done = _run(repo, "merge-base", base, head)
    if done.returncode == 0:
        return done.stdout.decode("ascii").strip()
    detail = _detail(done)
    if done.returncode == 1 and not detail:
        # Both names resolve, and nothing joins them: unrelated histories, or a shallow clone.
        raise GitError(
            f"{base} and {head} have no common ancestor in this clone; "
            "a shallow checkout needs the full history (fetch-depth: 0)"
        )
    raise GitError(f"cannot compare {head} with {base}: {detail or 'git merge-base failed'}")


def _blob_sizes(repo: Path, shas: list[str]) -> dict[str, int]:
    """The size in bytes of each blob, in one ``git cat-file`` call."""
    unique = sorted(set(shas))
    if not unique:
        return {}
    out = _git(
        repo,
        "cat-file",
        "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        stdin=("\n".join(unique) + "\n").encode("ascii"),
    )
    sizes: dict[str, int] = {}
    for line in out.decode("ascii").splitlines():
        parts = line.split(" ")
        if len(parts) != 3 or parts[1] != "blob":
            raise GitError(f"cannot read the size of object {line}")
        sizes[parts[0]] = int(parts[2])
    return sizes


def changes(repo: Path, base: str, head: str) -> list[Change]:
    """The files ``head`` adds or alters relative to the commit it shares with ``base``.

    A deleted file is not a change that can add weight. A renamed or copied file is compared
    with the file it came from, so moving a large file is not adding one.
    """
    start = merge_base(repo, base, head)
    raw = _git(
        repo,
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-ext-diff",
        "--find-renames",
        "--diff-filter=ACMRT",
        start,
        head,
        "--",
    )
    # With -z every record is ":<old mode> <new mode> <old sha> <new sha> <status>", then the
    # path, or the old and the new path of a rename or a copy, each ended by a NUL.
    fields = raw.split(b"\0")
    entries: list[tuple[str, str, str | None]] = []  # path, sha now, sha before
    at = 0
    while at < len(fields) and fields[at]:
        old_mode, new_mode, old_sha, new_sha, status = fields[at].decode("ascii")[1:].split(" ")
        paths = fields[at + 1 : at + 1 + (2 if status[0] in "RC" else 1)]
        at += 1 + len(paths)
        if new_mode == _GITLINK:
            continue
        added = old_mode == _GITLINK or set(old_sha) == {"0"}
        entries.append((os.fsdecode(paths[-1]), new_sha, None if added else old_sha))

    sizes = _blob_sizes(repo, [sha for _, now, before in entries for sha in (now, before) if sha])
    return [
        Change(path, sizes[now], None if before is None else sizes[before])
        for path, now, before in entries
    ]


def read_allowed(path: Path) -> set[str]:
    """The paths a change may add or grow past the limit; no file means none."""
    if not path.is_file():
        return set()
    allowed: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if entry and not entry.startswith("#"):
            allowed.add(entry.split(" #", 1)[0].strip())
    return allowed


def oversized(found: list[Change], limit: int, allowed: set[str]) -> list[Change]:
    """The changes that put more than ``limit`` bytes into the repository."""
    return [
        change
        for change in found
        if change.size > limit
        and change.path not in allowed
        and (change.before is None or change.size > change.before)
    ]


def _amount(size: int) -> str:
    """``size`` in bytes, and in KiB or MiB beside it once that is easier to read."""
    if size >= 1 << 20:
        return f"{size:,} bytes ({size / (1 << 20):.1f} MiB)".replace(".0 MiB", " MiB")
    if size >= 1 << 10:
        return f"{size:,} bytes ({size / (1 << 10):.0f} KiB)"
    return f"{size} bytes"


def describe(change: Change, limit: int) -> str:
    """One line saying what is wrong with ``change``."""
    what = (
        "the change adds it"
        if change.before is None
        else f"it was {change.before:,} bytes and the change makes it bigger"
    )
    return f"{change.path} is {_amount(change.size)}, over the limit of {_amount(limit)}; {what}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail a change that adds a large file, or makes one bigger."
    )
    parser.add_argument(
        "--base",
        default="origin/main",
        help="the branch or commit the change started from (default: origin/main)",
    )
    parser.add_argument("--head", default="HEAD", help="the change to check (default: HEAD)")
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"the largest file a change may add or grow (default: {DEFAULT_LIMIT})",
    )
    parser.add_argument(
        "--allow-file",
        type=Path,
        help=f"the paths exempt from the limit (default: {ALLOW_FILE} in the repository)",
    )
    parser.add_argument("--repo", type=Path, default=REPO_ROOT, help="the repository to check")
    args = parser.parse_args(argv)

    if args.max_bytes < 0:
        parser.error("--max-bytes cannot be negative")
    allow_file = args.allow_file or args.repo / ALLOW_FILE

    try:
        found = changes(args.repo, args.base, args.head)
    except GitError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    too_big = oversized(found, args.max_bytes, read_allowed(allow_file))
    for change in too_big:
        print(f"error: {describe(change, args.max_bytes)}", file=sys.stderr)
    if too_big:
        print(
            "To go on, make the file smaller, keep it out of the repository and link to it, or "
            f"add its path to {ALLOW_FILE} in this change with a comment saying why.",
            file=sys.stderr,
        )
        print('CONTRIBUTING.md ("Media and other large files") has the details.', file=sys.stderr)
        return 1
    print(f"ok: {len(found)} added or changed file(s), none over {_amount(args.max_bytes)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
