/** PMU placement: place, list and remove a PMU, and export its CSV. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, NetworkError, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import type { AddPmuRequest, ListPmusResponse, SessionId, TopologyEntry } from '@/api/types';
import { useEditJournalStore } from '@/store/editJournal';
import { usePmuStore } from '@/store/pmu';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';
import { useCaseReady } from './caseReady';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

export interface AddPmuVars {
  sessionId: SessionId;
  /** Body forwarded to ``POST /sessions/{id}/pmu``. */
  body: AddPmuRequest;
}

/**
 * ``POST /api/sessions/{id}/pmu`` — place a PMU at the given bus
 * pre-setup. On success: append the new entry to the PMU slice +
 * invalidate the listPmus query so any other consumer sees the
 * placement without an extra round-trip.
 *
 * Errors:
 *
 * - 409 — session committed; caller surfaces a "reload to recover"
 *   banner.
 * - 422 — bus does not exist OR ANDES rejected the add.
 */
export function useAddPmu(): UseMutationResult<TopologyEntry, Error, AddPmuVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, body }: AddPmuVars) => {
      return await andesClient.post<TopologyEntry>(
        `/sessions/${encodeURIComponent(sessionId)}/pmu`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: () => ({ jobId: registerJob('pmu-add') }),
    onSuccess: (data, { sessionId }, ctx) => {
      // A placement the edit journal does not replay.
      useEditJournalStore.getState().markOpaque();
      usePmuStore.getState().appendPmu(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pmus(sessionId) });
      // The PMU also lives in the topology bucket (controllers) — a
      // fresh placement should refresh the SLD's controller layer.
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``GET /api/sessions/{id}/pmu`` — list every PMU on the session.
 * Empty list when none placed (the common case for a fresh load).
 *
 * On success: writes through to the PMU slice so non-Query consumers
 * (the placement dialog list, the SLD overlay) read synchronously.
 */
export function useListPmus(): UseQueryResult<ListPmusResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const queryClient = useQueryClient();
  // Gate on a loaded case: PMUs are session+case-scoped, so a fresh session
  // with no case loaded 409s (landing-page console noise). The placement
  // mutation invalidates this key, so it refetches once a case lands.
  const hasCase = useCaseReady();
  const enabled = sessionId !== null && hasCase;
  return useQuery({
    queryKey: enabled ? queryKeys.pmus(sessionId) : ['pmus', 'noop'],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useListPmus enabled without a session id');
      }
      const data = await andesClient.get<ListPmusResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/pmu`,
        { timeoutMs: TIMEOUTS.workspace },
      );
      // Mirror into the Zustand store so the placement dialog reads
      // synchronously; the query cache stays the source of truth for
      // re-fetches / cache invalidation.
      usePmuStore.getState().setPmus(data.pmus);
      queryClient.setQueryData(queryKeys.pmus(sessionId), data);
      return data;
    },
  });
}

export interface DeletePmuVars {
  sessionId: SessionId;
  /** ANDES idx of the PMU (e.g., ``"PMU_1"``). */
  idx: string;
}

/**
 * ``DELETE /api/sessions/{id}/pmu/{idx}`` — remove a PMU pre-setup.
 *
 * On success: drop the entry from the PMU slice + invalidate the
 * listPmus query so any other consumer sees the removal without
 * waiting for a refetch.
 *
 * Errors:
 *
 * - 404 — unknown PMU idx.
 * - 409 — session committed; caller must reload first.
 */
export function useDeletePmu(): UseMutationResult<void, Error, DeletePmuVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, idx }: DeletePmuVars) => {
      await andesClient.delete<unknown>(
        `/sessions/${encodeURIComponent(sessionId)}/pmu/${encodeURIComponent(idx)}`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: ({ idx }) => ({ jobId: registerJob('pmu-delete', { idx }) }),
    onSuccess: (data, { sessionId, idx }, ctx) => {
      useEditJournalStore.getState().markOpaque();
      usePmuStore.getState().removePmu(idx);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pmus(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

export interface ExportPmuCsvVars {
  sessionId: SessionId;
  /**
   * Run identifier — opaque on the substrate side (the substrate
   * exposes only the latest ``ss.dae.ts``); used to name the
   * downloaded file and the ``Content-Disposition`` header.
   */
  runId: string;
}

/**
 * ``GET /api/sessions/{id}/pmu/{run_id}/export.csv`` — download the
 * PMU am/vm CSV for the most recent TDS run.
 *
 * Returns a ``Blob`` of the CSV body — the caller is responsible for
 * triggering the browser download (typically via ``downloadBlob`` from
 * ``components/export/downloadBlob.ts``).
 *
 * The default ``andesClient.get`` parses JSON; this endpoint returns
 * ``text/csv``, so we bypass the client and call ``fetch`` directly.
 * We still honour the project's ``ProblemDetailsError`` taxonomy so the
 * global recovery cascade and the in-dialog error inline path work the
 * same way as every other mutation.
 */
export function useExportPmuCsv(): UseMutationResult<Blob, Error, ExportPmuCsvVars> {
  return useMutation({
    mutationFn: async ({ sessionId, runId }: ExportPmuCsvVars) => {
      const url =
        `/api/sessions/${encodeURIComponent(sessionId)}/pmu/` +
        `${encodeURIComponent(runId)}/export.csv`;
      const headers = new Headers();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.workspace);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new NetworkError(`Network error on GET ${url}`, err);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        let parsed: unknown = undefined;
        try {
          parsed = await response.json();
        } catch {
          // ignore
        }
        const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
        const problem = {
          type: typeof obj.type === 'string' ? obj.type : 'about:blank',
          title: typeof obj.title === 'string' ? obj.title : `HTTP ${response.status}`,
          status: typeof obj.status === 'number' ? obj.status : response.status,
          detail: typeof obj.detail === 'string' ? obj.detail : null,
          instance: typeof obj.instance === 'string' ? obj.instance : null,
        };
        throw new ProblemDetailsError(problem, parsed, url);
      }

      return await response.blob();
    },
  });
}
