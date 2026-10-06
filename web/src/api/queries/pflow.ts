/** The power flow: the run, and the operating point read back after a time-domain run. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { andesClient, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import { parseRunId } from '@/api/types';
import type { PflowResult, SessionId, TopologySummary } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { announceViolations } from '@/lib/announceViolations';
import { elementNamesOf } from '@/lib/elementNames';
import { stemOf } from '@/lib/paths';
import { caseSettingsFromRun, pflowRequestBody } from '@/lib/pflowOptions';
import { queryKeys } from './keys';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

/**
 * `POST /sessions/{id}/pflow`. Invalidates topology because PF triggers
 * `ss.setup()`, flipping the topology's `state` from "pre-setup" to
 * "committed".
 */
export function useRunPflow(): UseMutationResult<PflowResult, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      // The options form's settings, read when the run starts so every control
      // that runs a power flow uses the same ones.
      const body = pflowRequestBody(usePflowOptionsStore.getState().options);
      return await andesClient.post<PflowResult>(
        `/sessions/${encodeURIComponent(sessionId)}/pflow`,
        { body, timeoutMs: TIMEOUTS.pflowRun },
      );
    },
    onMutate: () => {
      usePflowStore.getState().setRunning(true);
      // What the request sets, so the reply can say what the case itself sets for
      // the rest.
      const sent = pflowRequestBody(usePflowOptionsStore.getState().options);
      return { jobId: registerJob('pflow'), sent };
    },
    onSuccess: (data, sessionId, ctx) => {
      const solved = { ...data, run_id: parseRunId(data.run_id) };
      usePflowStore.getState().setLastRun(solved);
      if (ctx) {
        usePflowOptionsStore
          .getState()
          .noteCaseSettings(caseSettingsFromRun(ctx.sent, data.settings));
      }
      // The buses, lines and generators the run is judged against, before the
      // invalidation below fetches the committed topology.
      const topology = queryClient.getQueryData<TopologySummary>(queryKeys.topology(sessionId));
      announceViolations(solved, topology);
      // A converged result is kept, with the names its idx stand for now, so a
      // later run (after an edit, or on another case) can be compared with it.
      if (solved.converged) {
        const primaryPath = useCaseStore.getState().selection?.primaryPath ?? null;
        usePflowHistoryStore.getState().record(solved, {
          caseName: primaryPath === null ? 'New system' : stemOf(primaryPath),
          names: elementNamesOf(topology),
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _sessionId, ctx) => {
      if (err instanceof ProblemDetailsError) {
        usePflowStore.getState().setError(err);
      }
      if (ctx) failJob(ctx.jobId, err);
    },
    onSettled: () => {
      usePflowStore.getState().setRunning(false);
    },
  });
}

/**
 * Refresh the data grid's solved values from the System's CURRENT operating
 * point (read-only `GET /sessions/{id}/operating-point`).
 *
 * The Buses grid reads V/θ from `usePflowStore.lastRun`, which only a PF run
 * sets. After a TDS-only run the grid sat empty even though the substrate
 * holds the final-time operating point. Calling this on TDS completion writes
 * those values into the same store slot so the grid (and every other
 * `lastRun` consumer) populates. Best-effort: a failure leaves the grid as-is.
 */
export async function loadOperatingPointIntoStore(sessionId: SessionId): Promise<void> {
  try {
    const op = await andesClient.get<PflowResult>(
      `/sessions/${encodeURIComponent(sessionId)}/operating-point`,
      { timeoutMs: TIMEOUTS.workspace },
    );
    if (op.converged) {
      usePflowStore.getState().setLastRun({ ...op, run_id: parseRunId(op.run_id) });
    }
  } catch {
    // Read-only refresh; if the substrate has no solved state yet (or the
    // session expired), leave the grid untouched rather than surfacing noise.
  }
}
