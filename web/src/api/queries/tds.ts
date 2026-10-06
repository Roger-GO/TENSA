/**
 * The time-domain run's lifecycle around the stream (commit the disturbances, abort,
 * reset) and the two requests on a run's signals that hold no session.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type {
  AbortResponse,
  AddDisturbancesRequest,
  AddDisturbancesResponse,
  ComtradeExportRequest,
  DisturbanceSpec,
  ResponseMetricsRequest,
  ResponseMetricsResponse,
  SessionId,
  TopologySummary,
} from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { useEditJournalStore } from '@/store/editJournal';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { queryKeys } from './keys';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

export interface CommitDisturbancesVars {
  sessionId: SessionId;
  /** Local disturbance specs to commit. Caller MUST ensure ``length >= 1`` —
   *  the substrate's ``AddDisturbancesRequest`` has ``min_length=1`` and
   *  rejects an empty list with 422. The Unit 7 RunButton path skips this
   *  call entirely when the local list is empty. */
  disturbances: readonly DisturbanceSpec[];
}

/**
 * ``POST /sessions/{id}/disturbances``. Commits the local disturbance
 * editor list to the substrate ahead of a TDS run. On 201, the
 * disturbance slice's ``markCommitted`` flag is flipped so the UI
 * reflects "in sync". 422 surfaces as a thrown ``ProblemDetailsError`` —
 * the caller (Unit 7's RunButton) inspects the error and shows it on the
 * failing disturbance row rather than as a global toast.
 */
export function useCommitDisturbances(): UseMutationResult<
  AddDisturbancesResponse,
  Error,
  CommitDisturbancesVars
> {
  return useMutation({
    mutationFn: async ({ sessionId, disturbances }: CommitDisturbancesVars) => {
      const body: AddDisturbancesRequest = {
        // Spread to convert ``readonly`` into a mutable array shape so the
        // generated type's mutable ``disturbances`` field accepts it.
        disturbances: [...disturbances],
      };
      return await andesClient.post<AddDisturbancesResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/disturbances`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: ({ disturbances }) => ({
      jobId: registerJob('disturbance-commit', { count: disturbances.length }),
    }),
    onSuccess: (data, _vars, ctx) => {
      useDisturbanceStore.getState().markCommitted();
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``POST /sessions/{id}/abort`` (Unit 1b endpoint). Signals the worker to
 * cooperatively halt the active TDS run at the next ``callpert`` tick.
 * The actual stream end is asynchronous — the WS emits the terminal
 * ``done`` message with ``final_t < tf`` once the integration loop exits.
 *
 * On a successful HTTP response, the active run's ``abortedLocally`` flag
 * is set to true so the runs slice can distinguish user-initiated abort
 * from numerical instability when the eventual ``done`` arrives (see Unit
 * 7's state-inference rules).
 */
export function useAbortRun(): UseMutationResult<AbortResponse, Error, SessionId> {
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<AbortResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/abort`,
        { body: {}, timeoutMs: TIMEOUTS.sessionLifecycle },
      );
    },
    onSuccess: () => {
      const activeRunId = useRunsStore.getState().activeRunId;
      if (activeRunId !== null) {
        useRunsStore.getState().setAbortedLocally(activeRunId, true);
      }
    },
  });
}

/**
 * ``POST /sessions/{id}/reload`` wrapped for the v0.2 "Reset run" affordance.
 * Same wire endpoint as ``useReloadCase`` but with different post-success
 * cleanup tailored to the TDS run lifecycle:
 *
 * - Release the active run (``runs.clearActiveRun()``) so the Run buttons are
 *   free again, and keep every run, the one just finished included. Reset run
 *   throws away the System's state, which the reload did; the results are the
 *   researcher's to keep, compare with the next run, and delete from History
 *   when they want the memory back.
 * - Clear the disturbance commit flag (the substrate's reload threw away
 *   the committed disturbance list; the timeline editor's local list is
 *   preserved per the v0.2 plan's Open Questions decision so the user can
 *   retry without redefining everything).
 * - Invalidate topology + clear PF cache (mirrors ``useReloadCase`` because
 *   the underlying endpoint is the same).
 */
export function useResetRun(): UseMutationResult<TopologySummary, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/reload`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onSuccess: (data, sessionId) => {
      useEditJournalStore.getState().record({ op: 'reload' });
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      usePflowStore.getState().clearPflow();
      useRunsStore.getState().clearActiveRun();
      // Disturbance timeline list is preserved (per the plan's Open
      // Questions decision); only the "committed against substrate" flag
      // is reset so the next Run TDS re-commits the (possibly-edited)
      // local list.
      useDisturbanceStore.setState({ committed: false, dirty: true });
    },
  });
}

/**
 * `POST /response-metrics`: nadir, rate of change, settling time, overshoot and
 * damping of the signals in ``body``. Holds no session, so it works on a run
 * the substrate has forgotten, which is every run once the worker restarts.
 */
export async function fetchResponseMetrics(
  body: ResponseMetricsRequest,
  signal?: AbortSignal,
): Promise<ResponseMetricsResponse> {
  return await andesClient.post<ResponseMetricsResponse>('/response-metrics', {
    body,
    timeoutMs: 30_000,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * `POST /comtrade`: the signals in ``body`` as an IEEE C37.111 record, a `.zip`
 * of its `.cfg` and its ASCII `.dat`. Holds no session, so a run kept from an
 * earlier session or another case exports like the active one.
 */
export async function fetchComtradeRecord(
  body: ComtradeExportRequest,
  signal?: AbortSignal,
): Promise<Blob> {
  return await andesClient.postBlob('/comtrade', {
    body,
    timeoutMs: TIMEOUTS.comtradeExport,
    ...(signal === undefined ? {} : { signal }),
  });
}
