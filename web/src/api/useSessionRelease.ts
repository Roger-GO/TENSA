/**
 * Gives the session back when the tab goes away.
 *
 * A session lives on the substrate until it is closed or has been idle for its
 * timeout (three minutes by default), and the substrate holds only a few at a
 * time (four by default). A tab that was closed or reloaded used to leave its
 * session to the timeout, so reloading the page a few times in a row filled the
 * cap with sessions no tab had, and the page that came up next could not get
 * one. On `pagehide` this hook sends `DELETE /sessions/{id}` with `keepalive`,
 * which the browser completes after the page is gone.
 *
 * A page the browser keeps for Back and Forward (`persisted`) keeps its session:
 * it may be shown again as it was. If it is not, the timeout takes the session,
 * as before. A page that comes back to a session that is gone (the request was
 * sent and the unload then cancelled, or the timeout took it) finds out at its
 * next heartbeat and goes through the recovery in `useSessionRecovery`.
 *
 * Mounted once from `App.tsx`, beside `useSessionHeartbeat`.
 */
import { useEffect } from 'react';
import type { SessionId } from './types';
import { useSessionStore } from '@/store/session';

/** Close `sessionId` with a request that outlives the page. Never throws. */
export function releaseSession(sessionId: SessionId): void {
  try {
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => {
      // The page is going away; there is no one to tell.
    });
  } catch {
    // A browser without `keepalive`, or one that refuses the request outright.
  }
}

export function useSessionRelease(): void {
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      const sessionId = useSessionStore.getState().sessionId;
      if (sessionId !== null) releaseSession(sessionId);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);
}
