/**
 * LoadSnapshotDialog (Unit 7 of the v2.0 plan).
 *
 * Modal that fetches the substrate's snapshot listing and lets the user
 * pick one to restore (or delete). Mirrors SaveSnapshotDialog's
 * deferred-mount pattern so unit tests of the menu without a
 * QueryClientProvider stay green.
 *
 * Restore flow: ``useRestoreSnapshot`` POSTs to
 * ``/api/sessions/{id}/snapshot/restore``. On success the response's
 * ``used_dill`` flag drives an inline toast: when False (the slow
 * always-works path was taken because of a version mismatch or missing
 * dill), the toast surfaces ``fallback_reason`` so the user understands
 * why a re-converge happened.
 *
 * Delete flow: each row has a small "Delete" button; confirmation is
 * inline (a second click within 3 s). The listing refetches on success.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EmptyState, SnapshotIcon } from '@/components/ui/EmptyState';
import { useDeleteSnapshot, useListSnapshots, useRestoreSnapshot } from '@/api/queries';
import type { SnapshotListEntry } from '@/api/queries';
import { useSnapshotStore } from '@/store/snapshot';
import { useSessionStore } from '@/store/session';
import { ProblemDetailsError } from '@/api/client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

export function LoadSnapshotDialog() {
  const dialogOpen = useSnapshotStore((s) => s.loadDialogOpen);
  const closeDialogs = useSnapshotStore((s) => s.closeDialogs);
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) closeDialogs();
      }}
    >
      {dialogOpen ? <LoadSnapshotDialogInner /> : null}
    </Dialog>
  );
}

function LoadSnapshotDialogInner() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const closeDialogs = useSnapshotStore((s) => s.closeDialogs);
  const status = useSnapshotStore((s) => s.restoreStatus);
  const lastOutcome = useSnapshotStore((s) => s.lastRestoreOutcome);
  const markPending = useSnapshotStore((s) => s.markRestorePending);
  const markSuccess = useSnapshotStore((s) => s.markRestoreSuccess);
  const markError = useSnapshotStore((s) => s.markRestoreError);

  // Surface restore / delete failures via the global toast surface
  // (Unit 3 of the v2.0 polish plan). The substrate still owns the
  // error string in the snapshot slice so the dialog can re-open and
  // re-arm without losing the failure context, but the user-visible
  // surface is now the toast (with a Retry action that re-fires the
  // last attempt). Success keeps its inline rendering because the
  // outcome carries content-rich detail (`fallback_reason`,
  // `disturbances_replayed`) that doesn't fit a 4s toast.
  const surfaceErrorToast = (message: string, onRetry?: () => void) => {
    if (onRetry) {
      toast.error(message, { action: { label: 'Retry', onClick: onRetry } });
    } else {
      toast.error(message);
    }
  };

  const listQuery = useListSnapshots();
  const restoreMutation = useRestoreSnapshot();
  const deleteMutation = useDeleteSnapshot();

  // Local state for which row the user has selected for restore + which
  // row's delete button has been "armed" (clicked once; second click
  // confirms).
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [armedDeleteName, setArmedDeleteName] = useState<string | null>(null);
  const [useDillOpt, setUseDillOpt] = useState(true);
  // Unit 14 — "Force replay (debug)" toggle behind an Advanced
  // disclosure (collapsed by default). When ON it forces the
  // always-works replay+PF path by sending ``use_dill_optimization=false``
  // regardless of the dill checkbox above. Default OFF keeps behaviour
  // unchanged.
  const [forceReplay, setForceReplay] = useState(false);

  const isPending = status === 'pending';

  const submitRestore = async () => {
    if (sessionId === null || selectedName === null) return;
    markPending();
    try {
      const result = await restoreMutation.mutateAsync({
        sessionId,
        name: selectedName,
        // Force-replay (debug) wins: when ON the dill fast path is
        // bypassed regardless of the checkbox above.
        useDillOptimization: forceReplay ? false : useDillOpt,
      });
      markSuccess({
        used_dill: result.used_dill,
        fallback_reason: result.fallback_reason,
        disturbances_replayed: result.disturbances_replayed,
        name: selectedName,
      });
      // Close after a short beat so the user reads the success toast
      // (especially when fallback_reason is non-null).
      setTimeout(() => closeDialogs(), 1200);
    } catch (err) {
      const detail =
        err instanceof ProblemDetailsError
          ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
          : err instanceof Error
            ? err.message
            : 'unknown error';
      const message = `Restore failed: ${detail}`;
      markError(message);
      surfaceErrorToast(message, () => void submitRestore());
    }
  };

  const submitDelete = async (name: string) => {
    if (sessionId === null) return;
    if (armedDeleteName !== name) {
      // First click — arm. Auto-disarm after 3s so a stale prompt
      // doesn't surprise the user.
      setArmedDeleteName(name);
      setTimeout(() => setArmedDeleteName((prev) => (prev === name ? null : prev)), 3000);
      return;
    }
    setArmedDeleteName(null);
    try {
      await deleteMutation.mutateAsync({ sessionId, name });
      if (selectedName === name) setSelectedName(null);
    } catch (err) {
      const detail =
        err instanceof ProblemDetailsError
          ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
          : err instanceof Error
            ? err.message
            : 'unknown error';
      const message = `Delete failed: ${detail}`;
      markError(message);
      surfaceErrorToast(message, () => void submitDelete(name));
    }
  };

  const snapshots: readonly SnapshotListEntry[] = listQuery.data?.snapshots ?? [];
  const openSaveDialog = useSnapshotStore((s) => s.openSaveDialog);

  return (
    <DialogContent data-testid="load-snapshot-dialog" className="max-w-2xl">
      <DialogTitle>Load snapshot</DialogTitle>
      <DialogDescription className="mt-2">
        Restore a previously-saved operating point. The dill optimisation skips the PF re-solve when
        the ANDES version matches; otherwise the always-works replay+PF path takes over.
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3">
        {listQuery.isLoading ? (
          <p data-testid="load-snapshot-loading" className="text-muted-foreground text-xs">
            Loading snapshots…
          </p>
        ) : snapshots.length === 0 ? (
          <div data-testid="load-snapshot-empty">
            <EmptyState
              icon={<SnapshotIcon />}
              title="No snapshots yet"
              description="Save the current operating point to restore it later."
              action={{
                label: 'Save snapshot',
                onClick: () => {
                  closeDialogs();
                  openSaveDialog();
                },
              }}
              emptyStateKey="load-snapshot-empty"
            />
          </div>
        ) : (
          <ul
            data-testid="load-snapshot-list"
            role="listbox"
            className={cn(
              'border-border bg-muted/30 max-h-72 overflow-y-auto',
              'flex flex-col gap-1 rounded-[var(--radius-sm)] border p-1',
            )}
          >
            {snapshots.map((s) => (
              <li
                key={s.name}
                data-testid={`load-snapshot-row-${s.name}`}
                role="option"
                aria-selected={selectedName === s.name}
              >
                <div
                  className={cn(
                    'flex items-center justify-between gap-2',
                    'rounded-[var(--radius-sm)] px-2 py-1.5',
                    selectedName === s.name ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60',
                  )}
                >
                  <button
                    type="button"
                    data-testid={`load-snapshot-select-${s.name}`}
                    onClick={() => setSelectedName(s.name)}
                    className="flex flex-1 flex-col items-start text-left text-xs"
                  >
                    <span className="font-mono text-sm font-medium">{s.name}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {s.saved_at} · ANDES {s.andes_version}
                      {s.has_pflow ? ' · PF' : ''}
                      {s.has_tds ? ' · TDS' : ''}
                      {s.disturbance_count > 0
                        ? ` · ${s.disturbance_count} disturbance${
                            s.disturbance_count === 1 ? '' : 's'
                          }`
                        : ''}
                      {s.has_dill ? '' : ' · dill missing'}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void submitDelete(s.name)}
                    data-testid={`load-snapshot-delete-${s.name}`}
                    disabled={isPending}
                  >
                    {armedDeleteName === s.name ? 'Confirm delete' : 'Delete'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            data-testid="load-snapshot-use-dill"
            checked={forceReplay ? false : useDillOpt}
            onChange={(e) => setUseDillOpt(e.target.checked)}
            disabled={isPending || forceReplay}
          />
          <span>Use dill optimisation (skips PF re-solve when ANDES version matches)</span>
        </label>

        <details className="group" data-testid="load-snapshot-advanced">
          <summary
            className={cn(
              'text-muted-foreground hover:text-foreground cursor-pointer text-[11px] font-medium',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
          >
            Advanced
          </summary>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="load-snapshot-force-replay"
              checked={forceReplay}
              onChange={(e) => setForceReplay(e.target.checked)}
              disabled={isPending}
            />
            <span>
              Force replay (debug) — always re-converge via replay+PF (sends{' '}
              <code className="font-mono">use_dill_optimization=false</code>).
            </span>
          </label>
        </details>

        {/* Error rendering moved to the global toast surface — see
            `surfaceErrorToast` above + `@/lib/toast`. */}
        {status === 'success' && lastOutcome !== null ? (
          <div
            role="status"
            data-testid="load-snapshot-success"
            className={cn(
              'border-success/30 bg-success/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            <p className="font-medium">
              Restored {lastOutcome.name} ({lastOutcome.used_dill ? 'dill fast path' : 'replay+PF'};{' '}
              {lastOutcome.disturbances_replayed} disturbance
              {lastOutcome.disturbances_replayed === 1 ? '' : 's'} replayed).
            </p>
            {lastOutcome.fallback_reason !== null ? (
              <p className="text-muted-foreground mt-1 text-[10px]">
                {lastOutcome.fallback_reason}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <DialogFooter className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={closeDialogs}
          disabled={isPending}
          data-testid="load-snapshot-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void submitRestore()}
          disabled={isPending || selectedName === null || sessionId === null}
          data-testid="load-snapshot-confirm"
        >
          {isPending ? 'Restoring…' : 'Restore'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
