"""Entry point for ``python -m tensa``.

Delegates to the Typer CLI defined in ``tensa.cli``.
"""

from __future__ import annotations

from tensa.cli import app


def main() -> None:
    app()


if __name__ == "__main__":
    main()
