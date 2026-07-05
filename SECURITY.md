# Security Policy

## Trust model

TENSA is a **local-first research tool**. Its security model is deliberately simple:

- **No authentication.** The server binds to `127.0.0.1` (loopback) by default. The local OS user is the only intended actor.
- **Host/Origin checking.** A pure-ASGI middleware rejects requests whose `Host`/`Origin` headers are not on the allow-list, which defends against DNS-rebinding and random browser tabs poking at the loopback port. Extend the allow-list with `--allow-origin`.
- **Case files are code.** ANDES case files can contain Python expressions evaluated at parse time. Loading a case file is equivalent to running it. Only load files you trust — and never expose the server to actors whose files you would not run by hand.
- **Network exposure is opt-in and unauthenticated.** `--bind 0.0.0.0` (or any non-loopback bind) exposes the full API — including case loading — to everyone who can reach the port. The server prints a prominent warning when you do this. Only bind to non-loopback addresses on networks where you trust every host, or put an authenticating reverse proxy (e.g., Caddy/nginx with basic auth, Tailscale, an SSH tunnel) in front of it.

## Reporting a vulnerability

If you find a vulnerability that matters within this trust model (e.g., workspace path-traversal escape, Host/Origin bypass, cross-session data leakage), please open a [GitHub security advisory](../../security/advisories/new) or email the maintainer privately rather than filing a public issue. You should get a response within a week.

Reports that amount to "an unauthenticated server is reachable when bound to a non-loopback address" are working as documented and not considered vulnerabilities.
