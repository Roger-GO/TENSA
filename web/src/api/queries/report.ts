/** ANDES's reports of a routine, as ``GET /sessions/{id}/report`` returns them. */
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';
import type { ReportRoutine } from './keys';

/** One tabular block in a routine's structured report. */
export interface ReportTable {
  title: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

/** Response shape of ``GET /api/sessions/{id}/report``. */
export interface ReportResponse {
  routine: ReportRoutine;
  plain_text: string;
  structured: { tables: readonly ReportTable[] };
}

/**
 * ``GET /api/sessions/{id}/report?routine=...`` — fetches a routine's
 * report payload.
 *
 * Gating: enabled only when (a) a session is active AND (b) the
 * relevant routine has produced a result on the current session. The
 * caller passes the precomputed ``hasRunResult`` flag so this hook
 * doesn't need to subscribe to two stores; the dialog component owns
 * the gating logic.
 *
 * On 409 (no PF/TDS run yet), the error surfaces as a
 * ``ProblemDetailsError`` whose ``status`` the dialog inspects to
 * render the empty-state instead of the error banner.
 *
 * The ``staleTime`` is short (10 s) so a fresh PF/TDS run invalidates
 * naturally as the user re-opens the dialog. Components can also call
 * ``queryClient.invalidateQueries({ queryKey: ['report', id, routine] })``
 * after the run mutation lands to force a refetch.
 */
export function useReport(
  routine: ReportRoutine,
  hasRunResult: boolean,
): UseQueryResult<ReportResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const enabled = sessionId !== null && hasRunResult;
  return useQuery({
    queryKey: enabled ? queryKeys.report(sessionId, routine) : ['report', 'noop', routine],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useReport enabled without a session id');
      }
      return await andesClient.get<ReportResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/report`,
        { query: { routine }, timeoutMs: TIMEOUTS.workspace },
      );
    },
  });
}
