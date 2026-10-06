/** TimeSeries profiles: upload a profile file, stage it on a device, list and remove. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, NetworkError, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import type {
  AddProfileRequest,
  ListProfilesResponse,
  SessionId,
  TopologyEntry,
  UploadProfileResponse,
} from '@/api/types';
import { useEditJournalStore } from '@/store/editJournal';
import { useProfilesStore } from '@/store/profiles';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';
import { useCaseReady } from './caseReady';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

export interface UploadProfileVars {
  sessionId: SessionId;
  /**
   * The CSV / XLSX ``File`` (or ``Blob``) the user picked. The
   * substrate writes a fresh ``<uuid>.xlsx`` under
   * ``<workspace>/profiles/`` and returns the absolute path so the
   * follow-up ``addProfile`` mutation can reference it.
   */
  file: File;
}

/**
 * ``POST /api/sessions/{id}/profiles/upload`` — multipart upload of a
 * profile CSV/XLSX. Errors:
 *
 * - 409 — substrate has no workspace configured.
 * - 413 — payload over the 8 MB cap.
 * - 422 — unsupported extension OR malformed CSV.
 * - 500 — disk write failed.
 */
export function useUploadProfile(): UseMutationResult<
  UploadProfileResponse,
  Error,
  UploadProfileVars
> {
  return useMutation({
    mutationFn: async ({ sessionId, file }: UploadProfileVars) => {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/profiles/upload`;
      const headers = new Headers();
      const form = new FormData();
      form.set('file', file, file.name);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.workspace);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: form,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new NetworkError(`Network error on POST ${url}`, err);
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

      return (await response.json()) as UploadProfileResponse;
    },
    onMutate: ({ file }) => ({ jobId: registerJob('profile-upload', { filename: file.name }) }),
    onSuccess: (data, _vars, ctx) => {
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

export interface AddProfileVars {
  sessionId: SessionId;
  /** Body forwarded to ``POST /sessions/{id}/profiles``. */
  body: AddProfileRequest;
}

/**
 * ``POST /api/sessions/{id}/profiles`` — stage a TimeSeries device
 * pre-setup. On success: append the new entry to the profiles slice +
 * invalidate the listProfiles + topology queries so any other consumer
 * sees the new device without an extra round-trip.
 *
 * Errors:
 *
 * - 409 — session committed; caller surfaces a "reload to recover"
 *   banner.
 * - 422 — profile path missing / outside workspace, target device
 *   absent, mode=2, or ANDES rejected the underlying ``ss.add``.
 */
export function useAddProfile(): UseMutationResult<TopologyEntry, Error, AddProfileVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, body }: AddProfileVars) => {
      return await andesClient.post<TopologyEntry>(
        `/sessions/${encodeURIComponent(sessionId)}/profiles`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: () => ({ jobId: registerJob('profile-add') }),
    onSuccess: (data, { sessionId }, ctx) => {
      useEditJournalStore.getState().markOpaque();
      useProfilesStore.getState().appendProfile(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles(sessionId) });
      // The new TimeSeries also lives in the topology bucket
      // (controllers) — refresh that too.
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``GET /api/sessions/{id}/profiles`` — list every TimeSeries on the
 * session. Empty list when none staged (the common case for a fresh
 * load).
 *
 * On success: writes through to the profiles slice so non-Query
 * consumers (the import dialog list) read synchronously.
 */
export function useListProfiles(): UseQueryResult<ListProfilesResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const queryClient = useQueryClient();
  // Gate on a loaded case: profiles are session+case-scoped, so a fresh
  // session with no case loaded 409s (landing-page console noise). The
  // add/upload mutations invalidate this key, so it refetches once a case
  // lands.
  const hasCase = useCaseReady();
  const enabled = sessionId !== null && hasCase;
  return useQuery({
    queryKey: enabled ? queryKeys.profiles(sessionId) : ['profiles', 'noop'],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useListProfiles enabled without a session id');
      }
      const data = await andesClient.get<ListProfilesResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/profiles`,
        { timeoutMs: TIMEOUTS.workspace },
      );
      useProfilesStore.getState().setProfiles(data.profiles);
      queryClient.setQueryData(queryKeys.profiles(sessionId), data);
      return data;
    },
  });
}

export interface DeleteProfileVars {
  sessionId: SessionId;
  /** ANDES idx of the TimeSeries (e.g., ``"TimeSeries_1"``). */
  idx: string;
}

/**
 * ``DELETE /api/sessions/{id}/profiles/{idx}`` — remove a TimeSeries
 * pre-setup.
 *
 * On success: drop the entry from the profiles slice + invalidate the
 * listProfiles query so any other consumer sees the removal without
 * waiting for a refetch.
 *
 * Errors:
 *
 * - 404 — unknown TimeSeries idx.
 * - 409 — session committed; caller must reload first.
 */
export function useDeleteProfile(): UseMutationResult<void, Error, DeleteProfileVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, idx }: DeleteProfileVars) => {
      await andesClient.delete<unknown>(
        `/sessions/${encodeURIComponent(sessionId)}/profiles/${encodeURIComponent(idx)}`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: ({ idx }) => ({ jobId: registerJob('profile-delete', { idx }) }),
    onSuccess: (data, { sessionId, idx }, ctx) => {
      useEditJournalStore.getState().markOpaque();
      useProfilesStore.getState().removeProfile(idx);
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}
