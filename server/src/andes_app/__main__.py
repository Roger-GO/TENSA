"""Entry point for ``python -m andes_app``.

The Typer CLI lands in Unit 3 of the Phase A plan. Until then, this module
exits with a clear scaffolding-only message.
"""

from __future__ import annotations

import sys


def main() -> int:
    print(
        "andes-app: the CLI is not yet implemented (lands in Unit 3 of Phase A).\n"
        "Until then, this is a scaffolding-only build.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
