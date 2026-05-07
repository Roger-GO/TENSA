"""Security primitives: token, paths, ASGI middleware.

The trust model lives in ``andes_app.__init__``'s docstring (canonical
statement). This subpackage implements the defenses the trust model relies on:
per-launch token + token-file, workspace path canonicalization, and the
Host/Origin + token-redaction ASGI middleware.
"""
