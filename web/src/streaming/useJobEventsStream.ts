/**
 * ``useJobEventsStream`` — the app-root owner of the per-session
 * ``JobStream`` (v3.1 Unit 11; the mount Unit 6 deferred).
 *
 * Unit 6 built ``JobStream`` (one WebSocket per session against
 * ``WS /ws/{id}/jobs/events``) but never mounted it. This hook is that
 * owner: for the CURRENT active session it opens exactly one ``JobStream``,
 * writes every transition into ``useJobsStore`` (the stream does that
 * internally), and disposes the stream on session change / token loss /
 * unmount.
 *
 * Mounted ONCE at the app root (``App.tsx`` ``AppInner``, beside
 * ``useSessionRecovery``) and NOT gated on whether the Activity panel is
 * open — the store must receive live job events regardless of panel
 * visibility so the TopBar in-flight chip and the panel's history are both
 * always current.
 *
 * Lifecycle:
 *
 * - ``sessionId`` null / no token → no stream (nothing to subscribe to).
 * - ``sessionId`` set + token present → open a ``JobStream`` and ``start()``.
 * - ``sessionId`` changes → dispose the old stream, open a fresh one for the
 *   new session (job state is session-scoped on the substrate).
 * - unmount → dispose.
 *
 * On an ``auth_failed`` close the stream cascades the same way the TDS /
 * sweep streams do — clearing the auth token re-opens ``TokenPasteModal``.
 */
import { useEffect, useRef } from 'react';
import { JobStream } from '@/streaming/JobStream';
import { buildRunStreamWsUrl } from '@/streaming/wsUrl';
import { useSessionStore } from '@/store/session';
import { useAuthStore } from '@/store/auth';
import { useJobsStore } from '@/store/jobs';

/**
 * Cadence of the staleness-sweep backstop. Every ~30s we drive any
 * invoke-backed in-flight record past ``STALE_INFLIGHT_THRESHOLD_S`` (90s) to
 * ``failed`` so the TopBar InFlightChip pill can never spin forever when a
 * routine's terminal event never lands (the server coalesced the failure under
 * a different job_id, the WS dropped, etc.). Streaming kinds are excluded by
 * ``sweepStaleJobs`` itself. Exported so the app-root owner and tests share the
 * value.
 */
export const STALE_SWEEP_INTERVAL_MS = 30_000;

export function useJobEventsStream(): void {
  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useAuthStore((s) => s.token);
  const authDisabled = useAuthStore((s) => s.authDisabled);
  const streamRef = useRef<JobStream | null>(null);

  useEffect(() => {
    // Tear down any prior stream before (re)evaluating — covers session
    // change, token loss, and unmount.
    if (streamRef.current) {
      streamRef.current.dispose();
      streamRef.current = null;
    }

    if (sessionId === null) return;
    // A `serve --no-auth` substrate accepts an empty token; otherwise we
    // need a real one. The WS handshake sends ``{type:'auth', token}`` —
    // an empty string is fine against a no-auth backend.
    if (token === null && !authDisabled) return;

    const wsUrl = buildRunStreamWsUrl();
    if (wsUrl === '') return; // SSR / jsdom without a location — skip the open.

    const stream = new JobStream({
      sessionId,
      token: token ?? '',
      wsUrl,
      onError: (err) => {
        if (err.code === 'auth_failed') {
          // Token is stale; cascade-clear re-opens TokenPasteModal via the
          // v0.1 path (matches RunStream / SweepStream behaviour).
          useAuthStore.getState().clearToken();
        }
        // session_not_found / internal_error are non-fatal here — the store
        // simply stops receiving events; a later session/recovery cycle
        // re-mounts a fresh stream. No toast: the chip/panel degrade
        // gracefully (they fall back to the optimistic mutation path).
      },
    });
    streamRef.current = stream;
    stream.start();

    return () => {
      stream.dispose();
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [sessionId, token, authDisabled]);

  // STUCK-PILL BACKSTOP: independent of the stream lifecycle (the pill must
  // clear even when no stream is open / the WS is down), run the staleness
  // sweep on a timer for the whole app lifetime. ``sweepStaleJobs`` is a no-op
  // when nothing is stale, so the interval is cheap.
  useEffect(() => {
    const id = setInterval(() => {
      useJobsStore.getState().sweepStaleJobs();
    }, STALE_SWEEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}
