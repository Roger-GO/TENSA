/** Editing the system before it is set up: add, change, delete, and Undo and Redo of those. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type {
  AddElementRequest,
  DeleteElementResponse,
  EditElementRequest,
  ElementCreated,
  ParamValue,
  SessionId,
  TopologyEntry,
  TopologySummary,
} from '@/api/types';
import { useCaseStore } from '@/store/case';
import { deletedElementKey, disturbancesActingOn, useDisturbanceStore } from '@/store/disturbance';
import { useEditJournalStore } from '@/store/editJournal';
import { elementsGone, findTopologyEntry } from '@/lib/topology';
import { queryKeys } from './keys';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

export interface AddElementVars {
  sessionId: SessionId;
  body: AddElementRequest;
}

/**
 * `POST /sessions/{id}/elements`. Adds a new topology element. On 201,
 * invalidates the topology query so the SLD picks up the new device on
 * the next render. The optimistic-update story for `BusIdxSelect` lives
 * in Unit 6 alongside the AddElementPanel.
 */
export function useAddElement(): UseMutationResult<ElementCreated, Error, AddElementVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, body }: AddElementVars) => {
      return await andesClient.post<ElementCreated>(
        `/sessions/${encodeURIComponent(sessionId)}/elements`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: ({ body }) => ({ jobId: registerJob('element-add', { model: body.model }) }),
    onSuccess: (data, { sessionId, body }, ctx) => {
      useEditJournalStore.getState().record({
        op: 'add',
        model: body.model,
        params: { ...body.params },
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

export interface EditElementVars {
  sessionId: SessionId;
  model: string;
  idx: string;
  params: Record<string, ParamValue>;
}

/**
 * `PUT /sessions/{id}/elements/{model}/{idx}`. Edits one or more
 * parameters on an existing pre-setup element. Returns the updated
 * `TopologyEntry`; invalidates topology so the SLD label updates.
 */
export function useEditElement(): UseMutationResult<TopologyEntry, Error, EditElementVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, model, idx, params }: EditElementVars) => {
      const body: EditElementRequest = { params };
      return await andesClient.put<TopologyEntry>(
        `/sessions/${encodeURIComponent(sessionId)}/elements/${encodeURIComponent(model)}/${encodeURIComponent(idx)}`,
        { body, timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: ({ model, idx }) => ({ jobId: registerJob('element-edit', { model, idx }) }),
    onSuccess: (data, { sessionId, model, idx, params }, ctx) => {
      useEditJournalStore.getState().record({ op: 'edit', model, idx, params: { ...params } });
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

export interface DeleteElementVars {
  sessionId: SessionId;
  model: string;
  idx: string;
  /** Delete with the element what depends on it, instead of being refused. */
  cascade?: boolean;
}

/**
 * ``DELETE /sessions/{id}/elements/{model}/{idx}``. Removes an element of the
 * pre-setup system, whether the case file brought it or it was added since.
 * Returns the post-delete topology with what went (``deleted``,
 * ``disturbances``), so the SLD updates without an extra GET round-trip.
 *
 * The 422 ``DeleteBlockedResponse`` (other elements depend on it, or
 * disturbances act on it; send ``cascade`` to delete them too) and 422
 * ``ProblemDetails`` (unknown model) come back as thrown
 * ``ProblemDetailsError``s — the caller (``DeleteElementButton``) narrows on
 * ``status === 422`` and reads the typed body off ``error.rawBody``.
 *
 * On success: seed the topology cache with the new summary, clear
 * ``case.selectedElement`` if the deleted element was the one being
 * inspected (otherwise the inspector's findEntry would silently render
 * a stale snapshot until the next click), and take the disturbances of the
 * timeline that act on anything deleted off it: committed for the next run,
 * they would name a device that is gone.
 */
export function useDeleteElement(): UseMutationResult<
  DeleteElementResponse,
  Error,
  DeleteElementVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, model, idx, cascade }: DeleteElementVars) => {
      return await andesClient.delete<DeleteElementResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/elements/${encodeURIComponent(model)}/${encodeURIComponent(idx)}`,
        {
          // The system is built again from the case file, as for a reload.
          timeoutMs: TIMEOUTS.caseLoad,
          query: cascade === true ? { cascade: 'true' } : undefined,
        },
      );
    },
    onMutate: ({ model, idx }) => ({ jobId: registerJob('element-delete', { model, idx }) }),
    onSuccess: (data, { sessionId, model, idx, cascade }, ctx) => {
      useEditJournalStore
        .getState()
        .record(
          cascade === true
            ? { op: 'delete', model, idx, cascade: true }
            : { op: 'delete', model, idx },
        );
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
      const { deleted = [], disturbances: _removed, ...topology } = data;
      queryClient.setQueryData(queryKeys.topology(sessionId), topology);
      useCaseStore.getState().setTopology(topology);
      const timeline = useDisturbanceStore.getState();
      const acting = disturbancesActingOn(
        timeline.disturbances,
        deleted.map((entry) => ({ model: entry.kind, idx: entry.idx })),
      );
      timeline.removeWith(
        deletedElementKey(model, idx),
        acting.map((d) => d.id),
      );
      // If the element being inspected went (the one deleted, or one a
      // cascade took with it), fall back to the "no element selected" empty
      // state rather than leave the inspector on something that is not there.
      const selected = useCaseStore.getState().selectedElement;
      if (selected !== null && findTopologyEntry(topology, selected) === null) {
        useCaseStore.getState().setSelectedElement(null);
      }
      // Clear pending dependents — the cascade chain may have changed,
      // and the next 422 (if any) will repopulate the list with the
      // current truth.
      useCaseStore.getState().clearPendingDependents();
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * `POST /sessions/{id}/undo-last-edit`. Takes back the newest edit made before a
 * run, whatever it was: an element added, changed or deleted. Returns the
 * post-undo topology snapshot, which we seed into the topology cache so the SLD
 * updates without a re-fetch round-trip; its `redo` names the edit just taken
 * back. When that was a delete, the timeline's disturbances the delete took off
 * come back with the element.
 */
export function useUndoLastEdit(): UseMutationResult<TopologySummary, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/undo-last-edit`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: () => ({ jobId: registerJob('element-undo') }),
    onSuccess: (data, sessionId, ctx) => {
      useEditJournalStore.getState().record({ op: 'undo' });
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      const undone = data.redo;
      if (undone?.op === 'delete' && undone.idx != null) {
        useDisturbanceStore.getState().restoreWith(deletedElementKey(undone.model, undone.idx));
      }
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * `POST /sessions/{id}/redo-edit`. Puts back the edit the last undo took back.
 * The returned topology's `undo` names it. A delete that is redone takes the
 * timeline's disturbances on the element off again, and with them the ones put
 * on the timeline since the undo that act on anything the redo took: the
 * substrate hears of a timeline disturbance only when it is committed, and by
 * then it would name a device that is gone.
 */
export function useRedoEdit(): UseMutationResult<TopologySummary, Error, SessionId> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: SessionId) => {
      return await andesClient.post<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/redo-edit`,
        { body: {}, timeoutMs: TIMEOUTS.caseLoad },
      );
    },
    onMutate: () => ({ jobId: registerJob('element-redo') }),
    onSuccess: (data, sessionId, ctx) => {
      useEditJournalStore.getState().record({ op: 'redo' });
      // Read before it is replaced: what the topology listed and no longer
      // lists is what a redone delete took, the cascade included.
      const before = queryClient.getQueryData<TopologySummary>(queryKeys.topology(sessionId));
      queryClient.setQueryData(queryKeys.topology(sessionId), data);
      useCaseStore.getState().setTopology(data);
      const redone = data.undo;
      if (redone?.op === 'delete' && redone.idx != null) {
        const timeline = useDisturbanceStore.getState();
        const acting = disturbancesActingOn(timeline.disturbances, [
          { model: redone.model, idx: redone.idx },
          ...(before === undefined ? [] : elementsGone(before, data)),
        ]);
        timeline.removeAgainWith(
          deletedElementKey(redone.model, redone.idx),
          acting.map((d) => d.id),
        );
      }
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}
