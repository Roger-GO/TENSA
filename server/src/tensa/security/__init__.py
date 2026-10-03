"""Security primitives: paths, portable file names + ASGI middleware.

The trust model lives in ``tensa.__init__``'s docstring (canonical
statement). This subpackage implements the defenses the trust model relies on:
workspace path canonicalization, portable (Windows-safe) file-name validation,
and the Host/Origin ASGI middleware. There is no authentication; the server is
a local-first tool that binds to loopback by default.
"""
