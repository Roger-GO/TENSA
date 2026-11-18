# Security Policy

## Trust model

TENSA is a **local-first research tool**. Its security model is deliberately simple:

- **No authentication.** The server binds to `127.0.0.1` (loopback) by default. The local OS user is the only intended actor.
- **Host/Origin checking.** A pure-ASGI middleware rejects requests whose `Host`/`Origin` headers are not on the allow-list, which defends against DNS-rebinding and random browser tabs poking at the loopback port. Extend the allow-list with `--allow-origin`.
- **Security headers.** Every HTTP response carries `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, so another page cannot put the UI in a frame, a browser does not guess a response's content type, and the address is not sent in a `Referer`.
- **Case files are code.** ANDES case files can contain Python expressions evaluated at parse time. Loading a case file is equivalent to running it. Only load files you trust, and never expose the server to actors whose files you would not run by hand.
- **Results are kept in the browser.** The UI stores finished time-domain runs and the last converged power flows in the browser's own storage (IndexedDB) so they survive a reload: sample values, solved voltages and flows, element and case names, and the names you gave the runs. No request, file path or server error text is stored. Like any site data, it belongs to the address the UI was opened at (for example `http://127.0.0.1:8000`), so another program later served from the same host and port could read it. Delete runs from History and results from the Compare tab, discard the session with Change case, or clear the site's data in the browser, to remove them.
- **Network exposure is opt-in and unauthenticated.** `--bind 0.0.0.0` (or any non-loopback bind) exposes the full API, including uploading and loading case files, to everyone who can reach the port. The server prints a prominent warning when you do this. Only bind to non-loopback addresses on networks where you trust every host, or put an authenticating reverse proxy (e.g., Caddy/nginx with basic auth, Tailscale, an SSH tunnel) in front of it.

## Reporting a vulnerability

If you find a vulnerability that matters within this trust model (for example a workspace path-traversal escape, a Host/Origin bypass or cross-session data leakage), report it privately through GitHub's private vulnerability reporting: open the [Security tab of the repository](https://github.com/Roger-GO/TENSA/security) and choose **Report a vulnerability**, or go straight to the [report form](https://github.com/Roger-GO/TENSA/security/advisories/new). Only the maintainer can read the report. Please do not file it as a public issue or a discussion.

Say which version you ran (`tensa --version` prints the TENSA and ANDES versions), what you did, what you expected and what happened, and attach the case file or the request that shows it if you can.

TENSA has one maintainer, so replies are best effort. A fix goes into a new release, and the advisory is published once that release is out, with credit to the reporter unless you ask otherwise.

Only the latest release gets security fixes: [SUPPORT.md](./SUPPORT.md) says which versions are supported.

Reports that amount to "an unauthenticated server is reachable when bound to a non-loopback address" are working as documented and not considered vulnerabilities.
