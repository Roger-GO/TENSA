/** Loading, reloading, starting and saving a case. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type {
  BlankSystemResponse,
  LoadCaseRequest,
  SaveCaseRequest,
  SaveCaseResponse,
  SessionId,
  TopologySummary,
} from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';
import { useMessagesStore } from '@/store/messages';
import { usePflowStore } from '@/store/pflow';
import { useRecentCasesStore } from '@/store/recentCases';
import { queryKeys, snapshotsKey } from './keys';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

export interface LoadCaseVars {
  sessionId: SessionId;
  request: LoadCaseRequest;
}

/**
 * `POST /sessions/{id}/case`. Invalidates the topology query so the next
 * read picks up the new case, and drops the Messages tab's account of the case
 * it replaces (what the load itself logs stays), so the tab and its warning
 * count describe the case that is open. A load that fails changes nothing there.
 */
export function useLoadCase(): UseMutationResult<TopologySummary, Error, LoadCaseVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, request }: LoadCaseVars) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/case`,
        { body: request, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: ({ sessionId, request }) => {
      useCaseStore.getState().setLoadingPath(request.primary_path);
      // The newest message about the old case that has been read; the load's own come after.
      const messages = useMessagesStore.getState();
      return {
        jobId: registerJob('case-load', { primary_path: request.primary_path }),
        messagesBefore: messages.sessionId === sessionId ? messages.cursor : 0,
      };
    },
    onSuccess: (data, { sessionId, request }, ctx) => {
      if (ctx) useMessagesStore.getState().dropThrough(sessionId, ctx.messagesBefore);
      // Seed the topology cache with the load response (the substrate's
      // load handler returns the topology already; saves a round-trip).
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      useRecentCasesStore.getState().record(request.primary_path, request.addfiles ?? []);
      // Snapshots are listed per-case (scanned from
      // ``<workspace>/snapshots/<case>/``). The snapshots query first runs
      // on session-create — before any case is loaded — and caches ``[]``;
      // loading a case must invalidate it or the new case's existing
      // snapshots never surface (panel shows "No snapshots", and Sweep's
      // picker stays empty) even though they exist on disk.
      void queryClient.invalidateQueries({ queryKey: snapshotsKey(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
    onSettled: () => {
      useCaseStore.getState().setLoadingPath(null);
    },
  });
}

/**
 * `POST /sessions/{id}/reload`. Re-parses the case (full cost, not a
 * fast path); invalidates topology + clears PF cache.
 */
export function useReloadCase(): UseMutationResult<TopologySummary, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/reload`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: () => ({ jobId: registerJob('case-reload') }),
    onSuccess: (data, sessionId, ctx) => {
      useEditJournalStore.getState().record({ op: 'reload' });
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      usePflowStore.getState().clearPflow();
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * `POST /sessions/{id}/blank`. Creates a brand-new empty `andes.System()`
 * for the session. Caller seeds the topology query cache with the
 * returned blank summary so the canvas renders the empty-state prompt
 * without an extra round-trip.
 */
export function useBlankSystem(): UseMutationResult<BlankSystemResponse, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<BlankSystemResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/blank`,
        { body: {}, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onSuccess: (data, sessionId) => {
      queryClient.setQueryData(queryKeys.topology(sessionId), data.topology);
      useCaseStore.getState().setTopology(data.topology);
    },
  });
}

export interface SaveCaseVars {
  sessionId: SessionId;
  body: SaveCaseRequest;
}

/**
 * The key of every `useSaveCase` mutation, so a caller can ask the query client
 * whether any instance of the hook has a save running (`isMutating`).
 */
export const SAVE_CASE_MUTATION_KEY = ['save-case'] as const;

/**
 * `POST /sessions/{id}/save`. Writes the current System to the workspace
 * as xlsx or json. ANDES 2.0 has no PSS/E .raw writer — that format is
 * read-only on this substrate. On success the workspace lister query is
 * invalidated so the new file shows up immediately in the picker. A write over
 * the open case's own file also moves the edit journal's base to that file, as
 * the substrate moves its own (`Wrapper.save_case`): the substrate then has no
 * edit left to undo or redo, so the topology is read again for what it says of
 * the two.
 */
export function useSaveCase(): UseMutationResult<SaveCaseResponse, Error, SaveCaseVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: SAVE_CASE_MUTATION_KEY,
    mutationFn: async ({ sessionId, body }: SaveCaseVars) => {
      return await andesClient.post<SaveCaseResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/save`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: () => ({ jobId: registerJob('case-save') }),
    onSuccess: (data, { sessionId, body }, ctx) => {
      const journal = useEditJournalStore.getState();
      if (body.filename === useCaseStore.getState().selection?.primaryPath) {
        journal.markSavedInPlace();
        // Until this read is back the cached `undo` and `redo` name edits the
        // substrate no longer holds, and Undo and Redo wait for it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      } else {
        journal.markSaved();
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}
