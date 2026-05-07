"""Entry point for ``python -m andes_app``.

Delegates to the Typer CLI defined in ``andes_app.cli``.
"""

from __future__ import annotations

from andes_app.cli import app


def main() -> None:
    app()


if __name__ == "__main__":
    main()
