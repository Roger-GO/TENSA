# Support

TENSA has one maintainer, who looks after it alongside other work. Replies are best effort, and nothing on this page is a service level. Asking in the right place is the quickest way to an answer, and it leaves the answer where the next person with the same problem can find it. [SUPPORT.md](https://github.com/Roger-GO/TENSA/blob/main/SUPPORT.md) in the repository says the same.

## Where to ask

| If you have | Go to |
| --- | --- |
| A question: how do I, why does this result look like this, is this intended | The **Q&A** category of [GitHub Discussions](https://github.com/Roger-GO/TENSA/discussions/categories/q-a) |
| A bug | A new [issue](https://github.com/Roger-GO/TENSA/issues/new/choose), with the bug report template |
| A feature request | A new issue, with the feature request template. Say what you are trying to do, not only what you would like added |
| A security vulnerability | [Private vulnerability reporting](https://github.com/Roger-GO/TENSA/security/advisories/new), which only the maintainer can read. Do not open an issue or a discussion for it |
| A conduct concern | [CODE_OF_CONDUCT.md](https://github.com/Roger-GO/TENSA/blob/main/CODE_OF_CONDUCT.md) says how to report it |

Before you ask, [Troubleshooting](troubleshooting.md) covers the problems that come up most. `tensa --version` prints the TENSA and ANDES versions that a report should name.

## Which versions are supported

The latest release on [PyPI](https://pypi.org/project/tensa/) is the supported one. Bug fixes and security fixes go into a new release, and earlier releases are not patched. If you hit a problem on an older version, upgrade first (`pip install --upgrade tensa`) and see whether it is still there. These pages describe the version of the repository they were built from, which is the latest release or a little ahead of it, and the [changelog](https://github.com/Roger-GO/TENSA/blob/main/CHANGELOG.md) says what changed.

## ANDES compatibility

TENSA does the computation with [ANDES](https://github.com/CURENT/andes) and declares the range it works with: `andes>=2.0,<3.0`. It is verified against ANDES 2.0.0. Inside the range, a later ANDES release that breaks TENSA is a bug in TENSA, and a report of it is welcome. ANDES 3 and later are not supported until TENSA has been checked against them.

TENSA relies on a few parts of ANDES that ANDES does not publish as its API, such as the per-step hook of the time-domain run, so a move to a new ANDES minor release is deliberate. [`server/ANDES_VERSIONS.md`](https://github.com/Roger-GO/TENSA/blob/main/server/ANDES_VERSIONS.md) lists the fourteen contracts that are checked first. A problem that comes from ANDES itself (a model equation, a solver that does not converge on a case that should) belongs in [ANDES's issue tracker](https://github.com/CURENT/andes/issues).

## What makes a report easy to act on

- The smallest case that shows the problem, and the steps from opening it.
- The operating system, the Python version and the TENSA version, and whether it was a browser or `tensa desktop`.
- The text the server printed and, for a failed request, the problem document it answered with.
- One problem per issue or thread.
