# Getting help with TENSA

TENSA has one maintainer, who looks after it alongside other work. Replies are best effort, and nothing here is a service level. Asking in the right place is the quickest way to an answer, and it leaves the answer where the next person with the same problem can find it.

## Where to ask

- **A question** (how do I, why does this result look like this, is this the intended behavior): open a thread in the **Q&A** category of [GitHub Discussions](https://github.com/Roger-GO/TENSA/discussions/categories/q-a). Ideas and things you built go to the other categories there.
- **A bug** (something broke, or the program does what the documentation says it should not): open an [issue](https://github.com/Roger-GO/TENSA/issues/new/choose) and fill in the bug report template. It asks for what a report needs: the version, the case file or a small case that shows it, and the error card or the problem document, if there was one.
- **A feature request**: open an issue with the feature request template, and say what you are trying to do rather than only what you would like added.
- **A vulnerability**: do not open an issue or a discussion. Use [private vulnerability reporting](https://github.com/Roger-GO/TENSA/security/advisories/new), which only the maintainer can read. [SECURITY.md](./SECURITY.md) has the details.
- **A conduct concern**: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) says how to report it.

Before you ask, [Troubleshooting](https://roger-go.github.io/TENSA/troubleshooting/) covers the problems that come up most, and the [documentation](https://roger-go.github.io/TENSA/) answers most of the rest. `tensa --version` prints the TENSA and ANDES versions that a report should name.

## Which versions are supported

The latest release on [PyPI](https://pypi.org/project/tensa/) is the supported one: bug fixes and security fixes go into a new release, and earlier releases are not patched. If you hit a problem on an older version, upgrade first (`pip install --upgrade tensa`) and see whether it is still there. The documentation describes the version of the repository it was built from, which is the latest release or a little ahead of it; the [changelog](./CHANGELOG.md) says what changed.

## ANDES compatibility

TENSA does the computation with [ANDES](https://github.com/CURENT/andes) and declares the range it works with: `andes>=2.0,<3.0`. It is verified against ANDES 2.0.0. Inside the range, a later ANDES release that breaks TENSA is a bug in TENSA, and a report of it is welcome. ANDES 3 and later are not supported until TENSA has been checked against them.

TENSA relies on a few parts of ANDES that ANDES does not publish as its API, such as the per-step hook of the time-domain run, so a move to a new ANDES minor release is deliberate: [`server/ANDES_VERSIONS.md`](./server/ANDES_VERSIONS.md) lists the fifteen contracts that are checked first. A problem that comes from ANDES itself (a model equation, a solver that does not converge on a case that should) belongs in [ANDES's issue tracker](https://github.com/CURENT/andes/issues), with TENSA mentioned only if it matters.

## Helping the maintainer help you

- Give the smallest case that shows the problem, and the steps from opening it.
- Say which operating system, Python version and TENSA version you run, and whether it is a browser or `tensa desktop`.
- Paste the text the server printed and, for a failed request, the problem document it answered with.
- One problem per issue or thread.
