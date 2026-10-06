/** Clone-on-write editing of a case's controller parameters. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import { retryWhileBusy } from '@/api/replayJournal';
import type {
  CloneDiffResponse,
  CloneEditRequest,
  CloneEditResponse,
  CloneInitResponse,
  CloneResetResponse,
  CloneSaveAsRequest,
  CloneSaveAsResponse,
  ParamValue,
  SessionId,
} from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

/**
 * Invalidate every server-state query that a clone mutation may have changed:
 * the topology (the re-setup System reflects the edit), and all clone-diff
 * queries (a different set of params now differs from the original). Centralised
 * so the edit / undo / redo / reset hooks stay consistent.
 */
function invalidateAfterCloneChange(queryClient: QueryClient, sessionId: SessionId): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
  void queryClient.invalidateQueries({ queryKey: ['clone-diff', sessionId] });
}

/**
 * ``POST /sessions/{id}/case/clone`` — initialise the per-session clone-on-write
 * copy of the active case (idempotent). Used by the Edit-mode toggle so the
 * inspector has a clone to write into before the first param edit. On success
 * the case store records ``cloneInitialized``.
 */
export function useInitClone(): UseMutationResult<CloneInitResponse, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<CloneInitResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/case/clone`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: () => ({ jobId: registerJob('clone-init') }),
    onSuccess: (data, sessionId, ctx) => {
      useEditJournalStore.getState().record({ op: 'clone-init' });
      useCaseStore.getState().setCloneInitialized(true);
      invalidateAfterCloneChange(queryClient, sessionId);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/** Variables for ``useCloneEdit`` — the device path + the new value. */
export interface CloneEditVars {
  sessionId: SessionId;
  model: string;
  idx: string;
  param: string;
  value: ParamValue;
}

/**
 * How long a clone edit waits before each new attempt while the session is
 * busy: about a second in all, which outlasts a read and not a run.
 */
export const CLONE_EDIT_BUSY_RETRY_DELAYS_MS: readonly number[] = [150, 300, 600];

/**
 * ``PUT /sessions/{id}/case/clone/params/{model}/{idx}/{param}`` — commit one
 * whitelisted controller-param edit to the clone (write + reload + setup). On
 * success the response carries the post-setup ``new_value`` plus the undo/redo
 * stack depths, which we push into the case store; the topology + clone-diff
 * queries are invalidated so the inspector re-renders with the edited value and
 * the Modified-from-Original dot updates.
 */
export function useCloneEdit(): UseMutationResult<CloneEditResponse, Error, CloneEditVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, model, idx, param, value }: CloneEditVars) => {
      const body: CloneEditRequest = { value };
      // Selecting a controller reads its diff, which holds the session for a
      // moment: an edit committed within it is sent again, not refused.
      return await retryWhileBusy(
        () =>
          andesClient.put<CloneEditResponse>(
            `/sessions/${encodeURIComponent(sessionId)}/case/clone/params/${encodeURIComponent(model)}/${encodeURIComponent(idx)}/${encodeURIComponent(param)}`,
            { body, timeoutMs: TIMEOUTS.caseLoad },
          ),
        CLONE_EDIT_BUSY_RETRY_DELAYS_MS,
      );
    },
    onMutate: ({ model, idx, param }) => ({
      jobId: registerJob('clone-edit', { model, idx, param }),
    }),
    onSuccess: (data, { sessionId, model, idx, param, value }, ctx) => {
      useEditJournalStore.getState().record({ op: 'clone-edit', model, idx, param, value });
      useCaseStore.getState().setCloneDepths(data.undo_depth, data.redo_depth);
      invalidateAfterCloneChange(queryClient, sessionId);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``POST /sessions/{id}/case/clone/undo`` — pop the most recent clone edit and
 * re-setup against the restored files. Updates the stack depths + invalidates
 * the topology / diff queries so the inspector reverts to the prior value.
 */
export function useCloneUndo(): UseMutationResult<CloneEditResponse, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<CloneEditResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/case/clone/undo`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: () => ({ jobId: registerJob('clone-undo') }),
    onSuccess: (data, sessionId, ctx) => {
      useEditJournalStore.getState().record({ op: 'clone-undo' });
      useCaseStore.getState().setCloneDepths(data.undo_depth, data.redo_depth);
      invalidateAfterCloneChange(queryClient, sessionId);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``POST /sessions/{id}/case/clone/redo`` — re-apply the most recently undone
 * edit. Mirror of ``useCloneUndo``.
 */
export function useCloneRedo(): UseMutationResult<CloneEditResponse, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<CloneEditResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/case/clone/redo`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: () => ({ jobId: registerJob('clone-redo') }),
    onSuccess: (data, sessionId, ctx) => {
      useEditJournalStore.getState().record({ op: 'clone-redo' });
      useCaseStore.getState().setCloneDepths(data.undo_depth, data.redo_depth);
      invalidateAfterCloneChange(queryClient, sessionId);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/** Variables for ``useCloneSaveAs`` — the owning session + the new case name. */
export interface CloneSaveAsVars {
  sessionId: SessionId;
  name: string;
  /**
   * When true, overwrite an existing workspace file of the same name. Default
   * false — the substrate refuses a collision (protecting the loaded original)
   * and the dialog blocks colliding names client-side. (review(phase6))
   */
  overwrite?: boolean;
}

/**
 * ``POST /sessions/{id}/case/clone/save-as`` — write the clone to the workspace
 * as a custom case. On success the workspace-files query is invalidated so the
 * new case appears in ``SavedCasesList`` without a refresh.
 */
export function useCloneSaveAs(): UseMutationResult<CloneSaveAsResponse, Error, CloneSaveAsVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name, overwrite = false }: CloneSaveAsVars) => {
      const body: CloneSaveAsRequest = { name, overwrite };
      return await andesClient.post<CloneSaveAsResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/case/clone/save-as`,
        { body, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: ({ name }) => ({ jobId: registerJob('clone-save-as', { name }) }),
    onSuccess: (data, _vars, ctx) => {
      useEditJournalStore.getState().markSaved();
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``POST /sessions/{id}/case/clone/reset`` — discard the clone and revert to the
 * original case files. Resets the case store's clone flags and invalidates the
 * topology / diff queries.
 */
export function useCloneReset(): UseMutationResult<CloneResetResponse, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<CloneResetResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/case/clone/reset`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: () => ({ jobId: registerJob('clone-reset') }),
    onSuccess: (data, sessionId, ctx) => {
      useEditJournalStore.getState().record({ op: 'clone-reset' });
      const store = useCaseStore.getState();
      store.setCloneInitialized(false);
      store.setCloneDepths(0, 0);
      // setCloneDepths flips cloneInitialized true; reset it back to false
      // since the clone is now gone.
      store.setCloneInitialized(false);
      invalidateAfterCloneChange(queryClient, sessionId);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``GET /sessions/{id}/case/clone/diff/{model}/{idx}`` — read which whitelisted
 * controller params on a device differ between the clone file and the original
 * file (Unit 23). Gated on a live clone (``cloneInitialized``) AND a non-empty
 * ``(model, idx)`` — there is nothing to diff before any edit. The query key
 * includes ``cloneInitialized``-driven enablement, and the edit/undo/redo hooks
 * invalidate the ``['clone-diff', sessionId]`` prefix so the dot stays current.
 */
export function useCloneDiff(
  model: string | null,
  idx: string | null,
): UseQueryResult<CloneDiffResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const cloneInitialized = useCaseStore((s) => s.cloneInitialized);
  const enabled =
    sessionId !== null &&
    cloneInitialized &&
    model !== null &&
    model.length > 0 &&
    idx !== null &&
    idx.length > 0;
  return useQuery({
    queryKey:
      enabled && sessionId !== null && model !== null && idx !== null
        ? queryKeys.cloneDiff(sessionId, model, idx)
        : ['clone-diff', 'noop'],
    enabled,
    // The diff refetch (fired by `invalidateAfterCloneChange` right after an
    // edit) races the post-edit query storm for the substrate's non-blocking
    // session lock and can transiently 409. Retry briefly so the
    // Modified-from-Original dot resolves once the lock frees, instead of
    // sticking on the empty pre-edit diff.
    retry: (failureCount, error) =>
      error instanceof ProblemDetailsError && error.status === 409 && failureCount < 5,
    retryDelay: 250,
    queryFn: async () => {
      if (!sessionId || !model || !idx) {
        throw new Error('clone-diff query enabled without a session / model / idx');
      }
      return await andesClient.get<CloneDiffResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/case/clone/diff/${encodeURIComponent(model)}/${encodeURIComponent(idx)}`,
        { timeoutMs: TIMEOUTS.topology },
      );
    },
  });
}
