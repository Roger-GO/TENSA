/** Session lifecycle: ``POST /sessions`` and ``DELETE /sessions/{id}``. */
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import { parseSessionId } from '@/api/types';
import type { SessionDescriptor, SessionId } from '@/api/types';
import { useSessionStore } from '@/store/session';

/** `POST /sessions` → creates a session and writes the id to the session store. */
export function useCreateSession(): UseMutationResult<SessionDescriptor, Error, void> {
  return useMutation({
    mutationFn: async () => {
      return await andesClient.post<SessionDescriptor>('/sessions', {
        body: {},
        timeoutMs: TIMEOUTS.sessionLifecycle,
      });
    },
    onSuccess: (data) => {
      useSessionStore.getState().setSessionId(parseSessionId(data.session_id));
    },
  });
}

/** `DELETE /sessions/{id}` → close a session and clear the session store. */
export function useDeleteSession(): UseMutationResult<void, Error, SessionId> {
  return useMutation({
    mutationFn: async (id: SessionId) => {
      await andesClient.delete<void>(`/sessions/${encodeURIComponent(id)}`, {
        timeoutMs: TIMEOUTS.sessionLifecycle,
      });
    },
    onSuccess: () => {
      useSessionStore.getState().clearSession();
    },
  });
}
