"""Security primitives: paths + ASGI middleware.

The trust model lives in ``andes_app.__init__``'s docstring (canonical
statement). This subpackage implements the defenses the trust model relies on:
workspace path canonicalization and the Host/Origin ASGI middleware. There is
no authentication — the server is a local-first tool that binds to loopback
by default.
"""
