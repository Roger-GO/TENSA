/** Snapshots of a case's operating point: save, restore, list and delete. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type { SessionId, SidecarLayout } from '@/api/types';
import {
  cancelPendingSidecarPut,
  connectorStyleOf,
  dragOverridesFromLayout,
  samePlacement,
  unitStatesOf,
} from '@/components/sld/sidecar';
import { diagramLayoutForSave } from '@/lib/diagramLayout';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { useEditJournalStore } from '@/store/editJournal';
import { useSessionStore } from '@/store/session';
import { queryKeys, snapshotsKey } from './keys';
import { useCaseReady } from './caseReady';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

/** Sidecar-JSON shape echoed in save/restore/list responses. */
export interface SnapshotMetadata {
  andes_version: string;
  tensa_version: string;
  case_filename: string | null;
  case_sha256: string | null;
  disturbance_log: readonly Record<string, unknown>[];
  saved_at: string;
  has_pflow: boolean;
  has_tds: boolean;
  /** Whether the snapshot holds the diagram's layout (a restore returns it). */
  has_layout?: boolean;
}

/** Response of ``POST /sessions/{id}/snapshot``. */
export interface SaveSnapshotResponse {
  name: string;
  metadata: SnapshotMetadata;
  dill_bytes: number;
  metadata_bytes: number;
}

/** Response of ``POST /sessions/{id}/snapshot/restore``. */
export interface RestoreSnapshotResponse {
  used_dill: boolean;
  fallback_reason: string | null;
  disturbances_replayed: number;
  metadata: SnapshotMetadata;
  /**
   * The diagram's layout the snapshot held, or ``null`` when it held none. For a
   * case opened from a file the server has already written it beside that file.
   */
  layout?: SidecarLayout | null;
}

/** One entry of the ``GET /sessions/{id}/snapshots`` response. */
export interface SnapshotListEntry {
  name: string;
  saved_at: string;
  has_pflow: boolean;
  has_tds: boolean;
  has_dill: boolean;
  andes_version: string;
  disturbance_count: number;
}

/** Response shape of ``GET /sessions/{id}/snapshots``. */
export interface ListSnapshotsResponse {
  snapshots: readonly SnapshotListEntry[];
}

export interface SaveSnapshotVars {
  sessionId: SessionId;
  name: string;
  /** When True, overwrite an existing snapshot under the same name. */
  force?: boolean;
  /** When True, also write the solver-state (dill) blob, which costs a couple
   *  of seconds and a few MB. Default False saves the metadata only. */
  includeDill?: boolean;
}

export interface RestoreSnapshotVars {
  sessionId: SessionId;
  name: string;
  /** When True, try the dill blob first and skip the replay and PF re-solve.
   *  Default False restores by replaying the snapshot's disturbances. */
  useDillOptimization?: boolean;
}

export interface DeleteSnapshotVars {
  sessionId: SessionId;
  name: string;
}

/**
 * ``POST /sessions/{id}/snapshot`` — save the current operating point, with the
 * diagram's layout as it is drawn now, which a restore brings back.
 *
 * On success, invalidates the snapshot listing so a re-open of the
 * load dialog picks up the new entry without a manual refetch.
 */
export function useSaveSnapshot(): UseMutationResult<
  SaveSnapshotResponse,
  Error,
  SaveSnapshotVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name, force, includeDill }: SaveSnapshotVars) => {
      // With no diagram drawn the field is left out, and the server keeps the
      // layout saved beside the case file.
      const layout = diagramLayoutForSave();
      return await andesClient.post<SaveSnapshotResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshot`,
        {
          body: {
            name,
            force: force ?? false,
            include_dill: includeDill ?? false,
            ...(layout === null ? {} : { layout }),
          },
          timeoutMs: TIMEOUTS.caseLoad,
        },
      );
    },
    onMutate: ({ name }) => ({ jobId: registerJob('snapshot-save', { name }) }),
    onSuccess: (data, { sessionId }, ctx) => {
      void queryClient.invalidateQueries({ queryKey: snapshotsKey(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * Draw the diagram from the layout a restored snapshot held.
 *
 * For a case opened from a file the server has written the layout beside that
 * file, so the cached copy is replaced with it and the canvas redraws from
 * there. The drags of this visit sit on top of any saved layout and would hide
 * it, so they go, and a write of them still waiting to be sent is dropped: it
 * would put the layout of before the restore back. A system built from scratch
 * has no file to keep a layout beside; its positions are applied as drags, and
 * its connector style and the control chains it draws out as the ones chosen.
 *
 * A diagram arranged since the snapshot was saved is work, and the restore was
 * asked for the operating point. So when the diagram on screen changes, a toast
 * says so and offers to keep the arrangement it had; the operating point stays
 * restored either way.
 */
function applyRestoredLayout(queryClient: QueryClient, layout: SidecarLayout): void {
  const store = useCaseStore.getState();
  const selection = store.selection;
  const primaryPath = selection?.primaryPath ?? null;
  const before = {
    drawn: store.diagramLayout,
    overrides: store.dragOverrides,
    connectorStyle: store.connectorStyle,
    unitExpansion: store.unitExpansion,
  };
  if (primaryPath === null) {
    store.setDragOverrides(dragOverridesFromLayout(layout));
    store.setConnectorStyle(connectorStyleOf(layout));
    store.setUnitExpansion(
      Object.fromEntries([...unitStatesOf(layout)].map(([idx, unit]) => [idx, unit.expanded])),
    );
  } else {
    cancelPendingSidecarPut(primaryPath);
    queryClient.setQueryData(queryKeys.sidecar(primaryPath), layout);
    store.setDragOverrides({});
    // The connector style chosen in this visit sits on top of the saved
    // layout's, as the drags do, and goes with them. So do the control
    // chains drawn out or folded away in it.
    store.setConnectorStyle(null);
    store.setUnitExpansion({});
  }
  // No diagram was drawn, or it is drawn just as the snapshot has it: nothing
  // on screen changed, so there is nothing to tell or to take back.
  const drawnBefore = before.drawn;
  if (drawnBefore === null || samePlacement(drawnBefore, layout)) return;

  const keepPreviousLayout = (): void => {
    // The file gets the earlier arrangement back whatever is open by now; the
    // diagram on screen is only touched while it is still this case's.
    const stillOpen = useCaseStore.getState().selection === selection;
    if (stillOpen) {
      useCaseStore.getState().setDragOverrides(before.overrides);
      useCaseStore.getState().setConnectorStyle(before.connectorStyle);
      useCaseStore.getState().setUnitExpansion(before.unitExpansion);
    }
    if (primaryPath === null) return;
    queryClient.setQueryData(queryKeys.sidecar(primaryPath), drawnBefore);
    andesClient
      .put<void>('/workspace/layout', {
        query: { case_path: primaryPath },
        body: drawnBefore,
        timeoutMs: TIMEOUTS.workspace,
      })
      .catch((err: unknown) => {
        toast.error('Could not save the earlier layout back', {
          description: err instanceof Error ? err.message : undefined,
        });
      });
  };
  toast.info('The diagram is placed as it was when the snapshot was saved.', {
    duration: 12_000,
    action: { label: 'Keep my layout', onClick: keepPreviousLayout },
  });
}

/**
 * ``POST /sessions/{id}/snapshot/restore`` — restore a saved snapshot.
 *
 * On success, invalidates session-scoped caches that the restore
 * mutated under the hood (topology, pflow, EIG) so the UI re-fetches
 * the post-restore state without a stale render, and redraws the diagram
 * from the snapshot's layout when it has one.
 */
export function useRestoreSnapshot(): UseMutationResult<
  RestoreSnapshotResponse,
  Error,
  RestoreSnapshotVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name, useDillOptimization }: RestoreSnapshotVars) => {
      return await andesClient.post<RestoreSnapshotResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshot/restore`,
        {
          body: {
            name,
            use_dill_optimization: useDillOptimization ?? false,
          },
          timeoutMs: TIMEOUTS.caseLoad,
        },
      );
    },
    onMutate: ({ name }) => ({ jobId: registerJob('snapshot-restore', { name }) }),
    onSuccess: (data, { sessionId }, ctx) => {
      // The restored system is not something the journal's edits can rebuild.
      useEditJournalStore.getState().markReplaced();
      // Restore swaps the System; every session-scoped query is now
      // potentially stale. Invalidate the broad set rather than
      // hand-list each one — a snapshot restore is a rare operation
      // so the over-invalidation cost is fine.
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.eig(sessionId) });
      // Disturbance log is reset by the restore; tell the disturbance
      // store to mark itself dirty so the next TDS run re-syncs.
      useDisturbanceStore.setState({ committed: false, dirty: true });
      if (data.layout) applyRestoredLayout(queryClient, data.layout);
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * ``GET /sessions/{id}/snapshots`` — list snapshots for the current case.
 *
 * Gating: enabled only when a session is active. Returns an empty list
 * when no snapshots have been saved against the case yet.
 */
export function useListSnapshots(): UseQueryResult<ListSnapshotsResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  // Gate on a loaded case: snapshots are listed per-case, so on a fresh
  // session with no case loaded this 409s (landing-page console noise). The
  // load mutation invalidates this key, so it refetches once a case lands.
  const hasCase = useCaseReady();
  const enabled = sessionId !== null && hasCase;
  return useQuery({
    queryKey: enabled ? snapshotsKey(sessionId) : ['snapshots', 'noop'],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useListSnapshots enabled without a session id');
      }
      return await andesClient.get<ListSnapshotsResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshots`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
  });
}

/**
 * ``DELETE /sessions/{id}/snapshot/{name}`` — remove a snapshot.
 *
 * On success, invalidates the listing so the load dialog rerenders
 * without the deleted entry.
 */
export function useDeleteSnapshot(): UseMutationResult<void, Error, DeleteSnapshotVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name }: DeleteSnapshotVars) => {
      await andesClient.delete<unknown>(
        `/sessions/${encodeURIComponent(sessionId)}/snapshot/${encodeURIComponent(name)}`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
    onMutate: ({ name }) => ({ jobId: registerJob('snapshot-delete', { name }) }),
    onSuccess: (data, { sessionId }, ctx) => {
      void queryClient.invalidateQueries({ queryKey: snapshotsKey(sessionId) });
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}
