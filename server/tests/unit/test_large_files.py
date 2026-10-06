"""``scripts/check_large_files.py`` stops a change that adds a large file.

The check runs in ``.github/workflows/large-files.yml`` on every pull request. These tests
build small git repositories (the limit is 100 bytes, so the files stay tiny) and break one
rule at a time: a new file over the limit, a large file that grows, one the change leaves
alone, one that moves or shrinks, one the allowlist names, a merge base that is not the base
branch's tip. A last group reads the repository's own files: the workflow must look at every
pull request and see the history, the allowlist must name files that exist, and CONTRIBUTING
must give the limit the script enforces. They skip when git is missing or when the tests run
away from a checkout.
"""

from __future__ import annotations

import shutil
import subprocess
import unicodedata
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tests._repo import REPO_ROOT, SCRIPTS_DIR, load_module

pytestmark = pytest.mark.unit

LIMIT = 100
ALLOW = ".github/large-files-allowed.txt"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "large-files.yml"


def _script() -> ModuleType:
    return load_module("check_large_files", SCRIPTS_DIR / "check_large_files.py")


class Repo:
    """A throwaway git repository, driven the way the tests need and no further."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.git("init", "-q")

    def git(self, *args: str) -> str:
        done = subprocess.run(
            [
                "git",
                "-C",
                str(self.path),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                *args,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return done.stdout.strip()

    def write(self, name: str, size: int, fill: str = "x") -> None:
        target = self.path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(fill.encode("ascii") * size)

    def write_text(self, name: str, text: str) -> None:
        target = self.path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def commit(self, message: str = "change") -> str:
        self.git("add", "--all")
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def check(self, base: str, head: str = "HEAD", *extra: str) -> int:
        return int(
            _script().main(
                ["--repo", str(self.path), "--base", base, "--head", head]
                + ["--max-bytes", str(LIMIT), *extra]
            )
        )


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Repo:
    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    # The script runs git in this process, so a developer's own git settings must not leak in.
    # Rename detection is off here, so a test of a move shows the script asks for it itself.
    config = tmp_path / "gitconfig"
    config.write_text("[diff]\n\trenames = false\n", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    path = tmp_path / "work"
    path.mkdir()
    return Repo(path)


# ---- what a change adds ----------------------------------------------------------


def test_a_new_file_over_the_limit_fails_and_says_what_to_do(
    repo: Repo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("README.md", 10)
    base = repo.commit("start")
    repo.write("docs/img/new-demo.gif", LIMIT + 1)
    repo.commit("add a demo")

    assert repo.check(base) == 1
    err = capsys.readouterr().err
    assert f"docs/img/new-demo.gif is {LIMIT + 1:,} bytes" in err
    assert "the change adds it" in err
    assert ALLOW in err and "CONTRIBUTING.md" in err


def test_a_new_file_at_the_limit_passes(repo: Repo, capsys: pytest.CaptureFixture[str]) -> None:
    repo.write("README.md", 10)
    base = repo.commit("start")
    repo.write("docs/img/exactly.png", LIMIT)
    repo.commit("add an image")

    assert repo.check(base) == 0
    assert capsys.readouterr().out.startswith("ok: 1 added or changed file(s)")


def test_every_large_file_of_the_change_is_reported(
    repo: Repo, capsys: pytest.CaptureFixture[str]
) -> None:
    base = repo.commit("start")
    repo.write("a.bin", LIMIT + 5)
    repo.write("sub/b.bin", LIMIT + 6)
    repo.write("small.txt", 3)
    repo.commit("add three")

    assert repo.check(base) == 1
    err = capsys.readouterr().err
    assert "a.bin is" in err and "sub/b.bin is" in err and "small.txt" not in err


def test_a_large_file_the_change_leaves_alone_passes(repo: Repo) -> None:
    """The demo video and GIF the README embeds are over the limit and are not touched."""
    repo.write("docs/demo/old.mp4", LIMIT * 5)
    repo.write("README.md", 10)
    base = repo.commit("start")
    repo.write("README.md", 20)
    repo.commit("edit the readme")

    assert repo.check(base) == 0


# ---- what a change does to a large file that is already there --------------------


@pytest.mark.parametrize(
    ("new_size", "fill", "status"),
    [
        (LIMIT * 5 + 1, "y", 1),  # one byte bigger
        (LIMIT * 8, "y", 1),  # much bigger
        (LIMIT * 5, "y", 0),  # same size, other content
        (LIMIT * 3, "y", 0),  # smaller, still over the limit
        (LIMIT - 1, "y", 0),  # smaller, under the limit
    ],
)
def test_a_large_file_fails_only_when_the_change_makes_it_bigger(
    repo: Repo, new_size: int, fill: str, status: int
) -> None:
    repo.write("docs/img/demo.gif", LIMIT * 5)
    base = repo.commit("start")
    repo.write("docs/img/demo.gif", new_size, fill)
    repo.commit("re-encode")

    assert repo.check(base) == status


def test_the_message_for_a_grown_file_gives_its_old_size(
    repo: Repo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("demo.gif", LIMIT * 5)
    base = repo.commit("start")
    repo.write("demo.gif", LIMIT * 6, "y")
    repo.commit("re-encode")

    assert repo.check(base) == 1
    assert f"it was {LIMIT * 5:,} bytes and the change makes it bigger" in capsys.readouterr().err


def test_moving_a_large_file_is_not_adding_one(repo: Repo) -> None:
    repo.write("docs/demo/old.mp4", LIMIT * 5)
    base = repo.commit("start")
    repo.git("mv", "docs/demo/old.mp4", "docs/old.mp4")
    repo.commit("move")

    assert repo.check(base) == 0


def test_deleting_a_large_file_passes(repo: Repo) -> None:
    repo.write("docs/demo/old.mp4", LIMIT * 5)
    base = repo.commit("start")
    repo.git("rm", "-q", "docs/demo/old.mp4")
    repo.commit("delete")

    assert repo.check(base) == 0


# ---- the allowlist ---------------------------------------------------------------


def test_a_path_in_the_allowlist_passes_and_the_others_still_fail(repo: Repo) -> None:
    base = repo.commit("start")
    repo.write("media/kept.mp4", LIMIT * 4)
    repo.write("media/other.mp4", LIMIT * 4)
    repo.write_text(ALLOW, "# why\n\nmedia/kept.mp4  # the tutorial\n")
    repo.commit("add media")

    assert repo.check(base) == 1
    repo.write_text(ALLOW, "media/kept.mp4\nmedia/other.mp4\n")
    repo.commit("allow the other one too")
    assert repo.check(base) == 0


def test_an_allow_file_can_be_named_on_the_command_line(repo: Repo, tmp_path: Path) -> None:
    base = repo.commit("start")
    repo.write("media/kept.mp4", LIMIT * 4)
    repo.commit("add media")
    elsewhere = tmp_path / "allowed.txt"
    elsewhere.write_text("media/kept.mp4\n", encoding="utf-8")

    assert repo.check(base) == 1
    assert repo.check(base, "HEAD", "--allow-file", str(elsewhere)) == 0


def test_the_allowlist_ignores_comments_and_blank_lines(tmp_path: Path) -> None:
    allow = tmp_path / "allowed.txt"
    allow.write_text(
        "# a comment\n\n   \na/b.mp4\n  c d/e.gif   # with a reason\nf#g.png\n", encoding="utf-8"
    )
    script = _script()

    assert script.read_allowed(allow) == {"a/b.mp4", "c d/e.gif", "f#g.png"}
    assert script.read_allowed(tmp_path / "missing.txt") == set()


# ---- where the comparison starts -------------------------------------------------


def test_the_comparison_starts_at_the_merge_base(repo: Repo) -> None:
    """A base branch that moved on since the change was made does not count against it.

    main shrinks a file that is over the limit; the change never touches it. Compared with
    main's tip directly the file would look bigger, so the check starts at the shared commit.
    """
    repo.write("docs/demo/old.mp4", LIMIT * 5)
    root = repo.commit("start")
    repo.git("checkout", "-q", "--detach", root)
    repo.write("docs/demo/old.mp4", LIMIT * 2, "y")
    main_tip = repo.commit("main shrinks the video")
    repo.git("checkout", "-q", "--detach", root)
    repo.write("notes.txt", 5)
    change = repo.commit("the change")

    assert repo.check(main_tip, change) == 0


# ---- names and special entries ---------------------------------------------------


def test_names_with_spaces_and_accents_are_reported_as_they_are(
    repo: Repo, capsys: pytest.CaptureFixture[str]
) -> None:
    base = repo.commit("start")
    name = "docs/img/my shot é.png"
    repo.write(name, LIMIT + 1)
    repo.commit("add")

    assert repo.check(base) == 1
    err = unicodedata.normalize("NFC", capsys.readouterr().err)
    assert f"{name} is" in err


def test_a_submodule_is_not_a_file(repo: Repo) -> None:
    root = repo.commit("start")
    repo.git("update-index", "--add", "--cacheinfo", f"160000,{root},vendor/lib")
    repo.commit("add a submodule entry")

    assert repo.check(root) == 0


def test_changes_lists_sizes_before_and_after(repo: Repo) -> None:
    repo.write("kept.bin", 7)
    repo.write("grows.bin", 10)
    base = repo.commit("start")
    repo.write("grows.bin", 25, "y")
    repo.write("new.bin", 4)
    repo.commit("change")

    found = {c.path: (c.size, c.before) for c in _script().changes(repo.path, base, "HEAD")}
    assert found == {"grows.bin": (25, 10), "new.bin": (4, None)}


# ---- what goes wrong --------------------------------------------------------------


def test_an_unknown_base_is_reported_without_a_traceback(
    repo: Repo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.commit("start")

    assert repo.check("no-such-branch") == 2
    assert capsys.readouterr().err.startswith("error: cannot compare HEAD with no-such-branch")


def test_histories_with_nothing_in_common_say_to_fetch_more(
    repo: Repo, capsys: pytest.CaptureFixture[str]
) -> None:
    first = repo.commit("start")
    repo.git("checkout", "-q", "--orphan", "elsewhere")
    repo.write("other.txt", 1)
    other = repo.commit("a root of its own")

    assert repo.check(first, other) == 2
    assert "no common ancestor" in capsys.readouterr().err


def test_a_negative_limit_is_refused(repo: Repo) -> None:
    repo.commit("start")
    with pytest.raises(SystemExit) as stopped:
        _script().main(["--repo", str(repo.path), "--max-bytes", "-1"])
    assert stopped.value.code == 2


# ---- the repository's own files --------------------------------------------------


def _workflow() -> dict[str, Any]:
    yaml = pytest.importorskip("yaml")
    if not WORKFLOW.is_file():
        pytest.skip(".github/workflows/large-files.yml is not next to the tests")
    loaded = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def test_the_workflow_looks_at_every_pull_request_and_sees_the_history() -> None:
    workflow = _workflow()
    # PyYAML follows YAML 1.1, where a bare ``on`` key loads as ``True``.
    triggers = workflow.get("on", workflow.get(True))
    assert isinstance(triggers, dict)
    # A path filter would let a large file in a folder no filter names go unchecked.
    assert "pull_request" in triggers
    assert "paths" not in (triggers["pull_request"] or {})
    assert "paths" not in triggers["push"]
    assert set(triggers["push"]["branches"]).issuperset({"main", "improve/**"})
    assert "workflow_dispatch" in triggers

    steps = [step for job in workflow["jobs"].values() for step in job["steps"]]
    checkout = next(
        step for step in steps if str(step.get("uses", "")).startswith("actions/checkout")
    )
    assert checkout["with"]["fetch-depth"] == 0
    run = "\n".join(step["run"] for step in steps if "run" in step)
    assert "scripts/check_large_files.py --base" in run
    assert (SCRIPTS_DIR / "check_large_files.py").is_file()


def test_the_allowlist_names_files_that_exist() -> None:
    allow = REPO_ROOT / ALLOW
    if not allow.is_file():
        pytest.skip(f"{ALLOW} is not next to the tests")
    for path in _script().read_allowed(allow):
        assert (REPO_ROOT / path).is_file(), f"{ALLOW} names {path}, which is not a file"


def test_contributing_gives_the_limit_and_the_two_files_to_know() -> None:
    contributing = REPO_ROOT / "CONTRIBUTING.md"
    if not contributing.is_file():
        pytest.skip("CONTRIBUTING.md is not next to the tests")
    text = contributing.read_text(encoding="utf-8")
    script = _script()
    assert script.DEFAULT_LIMIT == 1024 * 1024
    assert "## Media and other large files" in text
    section = text.split("## Media and other large files", 1)[1].split("\n## ", 1)[0]
    assert "1 MiB" in section
    assert "scripts/check_large_files.py" in section
    assert script.ALLOW_FILE in section
    assert (REPO_ROOT / script.ALLOW_FILE).is_file()
