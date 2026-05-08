/**
 * Session slice. Tracks the active substrate session (the worker subprocess
 * the substrate spawned on `POST /sessions`).
 *
 * Lifecycle: cleared when auth clears (cross-slice cascade in
 * `store/index.ts`). Cleared when the user explicitly closes the session.
 * On a 404 from a session-scoped endpoint, the queries layer is expected
 * to call `clearSession()` and recreate via `useCreateSession`.
 *
 * NOT persisted — the session id is only valid for the current substrate
 * process; persisting it across reloads would just produce a 404 on the
 * first request. The auth token is the only thing worth persisting.
 */
import { create } from 'zustand';
import type { SessionId } from '@/api/types';

export interface SessionState {
  sessionId: SessionId | null;
  setSessionId: (id: SessionId) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  setSessionId: (id: SessionId) => set({ sessionId: id }),
  clearSession: () => set({ sessionId: null }),
}));
