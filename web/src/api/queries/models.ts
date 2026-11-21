/**
 * The models ANDES ships and its documentation of each: the catalogue of
 * ``GET /sessions/{id}/models`` and the plain-text documentation of
 * ``GET /sessions/{id}/models/{model}/doc``. Both need a session and no case.
 *
 * Both are read by the session's worker, which serves one operation at a time
 * and answers any other 409 "session is busy" at once. The dialog asks for the
 * list and the first model's text together, and a pick can follow another
 * before its answer, so each request is sent again while the session is busy
 * (``retryWhileBusy``) before it counts as failed.
 */
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import { retryWhileBusy } from '@/api/replayJournal';
import type { components } from '@/api/generated';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';

/** ``GET /sessions/{id}/models``: the models ANDES ships, grouped as ANDES groups them. */
type SupportedModels = components['schemas']['SupportedModels'];
/** ``GET /sessions/{id}/models/{model}/doc``: ANDES's documentation of one model. */
type ModelDoc = components['schemas']['ModelDoc'];

/**
 * ``GET /api/sessions/{id}/models``: every model ANDES ships, grouped as
 * ANDES groups them (``groups``: the model class names, keyed by the group
 * ANDES puts each in). The catalogue is static per server version, so it is
 * cached for a minute.
 *
 * Errors:
 *
 * - 404: the session was not found or is already closed.
 * - 409: the session's engine is not ANDES, and only ANDES documents its
 *   models.
 */
export function useSupportedModels(): UseQueryResult<SupportedModels, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useQuery({
    queryKey: sessionId ? queryKeys.models(sessionId) : ['models', 'noop'],
    enabled: sessionId !== null,
    staleTime: 60_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useSupportedModels enabled without a session');
      }
      return await retryWhileBusy(() =>
        andesClient.get<SupportedModels>(`/sessions/${encodeURIComponent(sessionId)}/models`, {
          timeoutMs: TIMEOUTS.workspace,
        }),
      );
    },
  });
}

/**
 * ``GET /api/sessions/{id}/models/{model}/doc``: ANDES's own documentation
 * of one model (``model``: the ANDES model class name the documentation is
 * for; ``doc``: the text ANDES prints for the model, verbatim). Enabled only
 * with a session and a model.
 *
 * Errors:
 *
 * - 404: the session was not found or is already closed, or no model ANDES
 *   ships has that name. The dialog shows the unknown model as its own state.
 * - 409: the session's engine is not ANDES, and only ANDES documents its
 *   models.
 * - 422: ANDES failed to write the documentation of that model.
 */
export function useModelDoc(model: string | null): UseQueryResult<ModelDoc, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useQuery({
    queryKey:
      sessionId !== null && model !== null
        ? queryKeys.modelDoc(sessionId, model)
        : ['models', 'doc', 'noop'],
    enabled: sessionId !== null && model !== null,
    staleTime: 60_000,
    queryFn: async () => {
      if (!sessionId || model === null) {
        throw new Error('useModelDoc enabled without session/model');
      }
      return await retryWhileBusy(() =>
        andesClient.get<ModelDoc>(
          `/sessions/${encodeURIComponent(sessionId)}/models/${encodeURIComponent(model)}/doc`,
          { timeoutMs: TIMEOUTS.workspace },
        ),
      );
    },
  });
}
