/**
 * Build the WebSocket URL prefix that ``RunStream`` appends ``/ws/{id}``
 * to. We compute it from ``window.location`` so the WS connection lands
 * back at the page origin — under the Vite dev proxy this rewrites to
 * the substrate's ``/api/ws/{id}`` (see ``vite.config.ts``); in a
 * production bundle served by the substrate itself, the same origin
 * resolves directly.
 *
 * The ``ws:`` / ``wss:`` scheme is selected by mirroring the page's HTTP
 * scheme (``https:`` → ``wss:``, otherwise ``ws:``). This matches the
 * v0.2 plan's mandate that WSS is required on any non-loopback bind.
 *
 * Returns an empty string when ``window`` is unavailable (SSR / jsdom
 * without a location) — callers should treat that as "skip the WS open".
 * In every reachable browser context the page has a ``window.location``
 * with at least a protocol + host.
 */
export function buildRunStreamWsUrl(): string {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    return '';
  }
  const { protocol, host } = window.location;
  const wsScheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsScheme}//${host}`;
}
