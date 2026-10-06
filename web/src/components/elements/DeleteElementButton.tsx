import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useDeleteElement } from '@/api/queries';
import { ProblemDetailsError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import type { StaticElementKind } from '@/store/case';
import {
  deletedElementKey,
  disturbanceSummary,
  disturbanceTime,
  disturbancesActingOn,
  useDisturbanceStore,
} from '@/store/disturbance';
import type { DeviceRef, DisturbanceLocal } from '@/store/disturbance';
import type {
  DeleteBlockedResponse,
  DeletedDisturbance,
  DeleteElementResponse,
  TopologyEntry,
} from '@/api/types';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';

/**
 * DeleteElementButton — trash-icon button + Radix Dialog confirm cycle
 * for deleting an element of the pre-setup system, whether the case file
 * brought it or it was added since.
 *
 * Render placement: the header of the RightInspector, beside the element's
 * name, NOT per-row alongside EditElementButton. It deletes while the case
 * is not set up; once it is, the parent passes ``disabledReason`` and the
 * button stays in place, greyed out, with the reason as its hover text.
 *
 * Dialog state machine (driven by the in-flight mutation + the latest
 * 422 body shape):
 *
 * - ``confirm``: default — "Delete <kind> <idx>?" with Cancel + Delete
 *   (danger). It says that Undo brings the element back, and names the
 *   disturbances of the timeline that act on it, which go with it.
 * - ``deleting``: appears at >200ms after the user clicks Delete. Below
 *   200ms we close the dialog directly on success without a spinner
 *   flash — ANDES delete on small cases resolves in 50-150ms.
 * - ``blocked``: 422 with the typed ``DeleteBlockedResponse`` body: other
 *   elements depend on this one, or disturbances act on it or on one of
 *   those. Lists up to 25 of each. An element is a button: a click
 *   closes the dialog, navigates the inspector to it, and pushes the
 *   *remaining* dependents into ``case.pendingDependents`` so the SLD
 *   canvas highlights them with a warning ring. "Delete all" sends the
 *   delete again with ``cascade``, which takes them all in one edit.
 * - ``error-other``: any other failure surfaces inline above the
 *   confirm buttons; the user can retry or cancel.
 *
 * The wire contract is on the route,
 * ``DELETE /sessions/{id}/elements/{model}/{idx}``.
 */

/** Minimum elapsed time (ms) before showing the in-flight spinner. */
const SPINNER_DELAY_MS = 200;

/** Runtime narrow for the ``DeleteBlockedResponse`` body shape. */
function isDeleteBlockedResponse(body: unknown): body is DeleteBlockedResponse {
  if (body === null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return Array.isArray(obj.dependents) && typeof obj.total === 'number';
}

/**
 * Map an ANDES model class name onto the inspector's kind taxonomy. Returns
 * only the static kinds: a dependent of another model (a controller, an
 * area) is listed without a link.
 */
function modelToInspectorKind(model: string): StaticElementKind | null {
  const m = model.toLowerCase();
  if (m === 'bus') return 'bus';
  if (m === 'line') return 'line';
  if (m === 'transformer' || m.startsWith('xfmr') || m.startsWith('trans')) return 'transformer';
  // PV / Slack / GENROU / GENCLS all map to "generator" in the SLD.
  if (m === 'generator' || m === 'pv' || m === 'slack' || m.startsWith('gen')) {
    return 'generator';
  }
  if (m === 'load' || m === 'pq' || m === 'zip') return 'load';
  if (m === 'shunt' || m.startsWith('shunt')) return 'shunt';
  return null;
}

/** "1 element", "3 elements". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

const SOURCE_NOTE: Record<DeletedDisturbance['source'], string> = {
  case: 'set by the case file',
  restored: 'from the bundle or snapshot',
  committed: 'committed for the next run',
};

const KIND_NOUN: Record<DeletedDisturbance['kind'], string> = {
  fault: 'Fault on',
  toggle: 'Toggle of',
  alter: 'Change to',
};

/** "Toggle of Line Line_1 at 1 s, set by the case file". */
function deletedDisturbanceSummary(d: DeletedDisturbance): string {
  const target = `${d.model ?? 'device'} ${d.dev_idx == null ? '?' : String(d.dev_idx)}`;
  const when = d.t == null ? 'which never fires' : `at ${d.t} s`;
  return `${KIND_NOUN[d.kind]} ${target} ${when}, ${SOURCE_NOTE[d.source]}`;
}

/**
 * The timeline's disturbances to name beside the server's: the ones that act on
 * ``devices``, less those the server already lists as committed (after a commit
 * the same disturbance is in both lists).
 */
function timelineOnly(
  timeline: readonly DisturbanceLocal[],
  devices: readonly DeviceRef[],
  listed: readonly DeletedDisturbance[],
): DisturbanceLocal[] {
  return disturbancesActingOn(timeline, devices).filter(
    (local) =>
      !listed.some(
        (d) =>
          d.source === 'committed' &&
          d.kind === local.spec.kind &&
          d.t === disturbanceTime(local.spec) &&
          String(d.dev_idx) ===
            String(local.spec.kind === 'fault' ? local.spec.bus_idx : local.spec.dev_idx),
      ),
  );
}

export interface DeleteElementButtonProps {
  /** ANDES model class name (e.g., "Bus", "Line", "PV"). */
  model: string;
  /** ANDES idx, stringified. */
  idx: string;
  /** What the element is called in the dialog text: "bus", "line", "exciter". */
  kind: string;
  /**
   * Why the element cannot be deleted now (the case is set up for a run). The
   * button is then greyed out, says this on hover, and opens nothing.
   */
  disabledReason?: string;
  className?: string;
}

type DialogMode =
  | { kind: 'confirm' }
  | { kind: 'deleting' }
  | { kind: 'blocked'; body: DeleteBlockedResponse }
  | { kind: 'error-other'; message: string };

export function DeleteElementButton({
  model,
  idx,
  kind,
  disabledReason,
  className,
}: DeleteElementButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const setPendingDependents = useCaseStore((s) => s.setPendingDependents);
  const clearPendingDependents = useCaseStore((s) => s.clearPendingDependents);
  const timeline = useDisturbanceStore((s) => s.disturbances);
  const deleteMutation = useDeleteElement();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DialogMode>({ kind: 'confirm' });
  // Track the spinner-delay timer so we can cancel it on fast resolves.
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSpinnerTimer = useCallback(() => {
    if (spinnerTimerRef.current !== null) {
      clearTimeout(spinnerTimerRef.current);
      spinnerTimerRef.current = null;
    }
  }, []);

  // Cleanup any pending timer on unmount.
  useEffect(() => {
    return () => {
      cancelSpinnerTimer();
    };
  }, [cancelSpinnerTimer]);

  const reset = useCallback(() => {
    cancelSpinnerTimer();
    setMode({ kind: 'confirm' });
  }, [cancelSpinnerTimer]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Don't allow closing the dialog while the request is in flight; the
      // user's attention should stay pinned on the spinner. They can
      // always Cancel from the rendered footer once a result returns.
      if (deleteMutation.isPending) return;
      setOpen(next);
      if (!next) reset();
    },
    [deleteMutation.isPending, reset],
  );

  const submit = useCallback(
    (cascade: boolean) => {
      if (!sessionId) return;
      cancelSpinnerTimer();
      spinnerTimerRef.current = setTimeout(() => {
        // Only flip into the "deleting" copy if the request hasn't resolved
        // yet AND the dialog is still asking; an error path that resolved
        // sub-200ms shouldn't get retroactively re-painted as "deleting".
        setMode((curr) =>
          curr.kind === 'confirm' || curr.kind === 'blocked' ? { kind: 'deleting' } : curr,
        );
      }, SPINNER_DELAY_MS);

      // ``mutateAsync``, not ``mutate`` with callbacks: those only run while
      // the component that called it is mounted, and this button is gone the
      // moment the delete succeeds (the Inspector has nothing left to show).
      // What was deleted must still be said.
      deleteMutation.mutateAsync({ sessionId, model, idx, cascade }).then(
        (data) => {
          cancelSpinnerTimer();
          setOpen(false);
          setMode({ kind: 'confirm' });
          announceDeleted(data, model, idx);
        },
        (err: unknown) => {
          cancelSpinnerTimer();
          if (err instanceof ProblemDetailsError && err.status === 422) {
            // Two sub-cases share the 422 status:
            // (a) something depends on the element → typed
            //     ``DeleteBlockedResponse`` body
            // (b) anything else the substrate refuses → ``ProblemDetails``
            const body = err.rawBody;
            if (isDeleteBlockedResponse(body)) {
              setMode({ kind: 'blocked', body });
              return;
            }
          }
          setMode({ kind: 'error-other', message: describeError(err) });
        },
      );
    },
    [sessionId, model, idx, deleteMutation, cancelSpinnerTimer],
  );

  const onDependentClick = useCallback(
    (entry: TopologyEntry) => {
      // Map the ANDES model on the entry back into the inspector taxonomy.
      // If the mapping fails (an exotic model class we don't know about),
      // skip the navigation — falling back to the empty inspector with no
      // hint would confuse the user worse than leaving the dialog open.
      const targetKind = modelToInspectorKind(entry.kind);
      if (targetKind === null) return;
      // Push the *remaining* dependents (everything except the one the
      // user just navigated to) into ``case.pendingDependents`` so the
      // SLD canvas can highlight them with a warning ring. The clicked
      // entry itself becomes the inspector's selectedElement; once the
      // user deletes it, the next 422 (if any) will repopulate this list.
      if (mode.kind === 'blocked') {
        const remaining = mode.body.dependents.filter(
          (d) => !(d.kind === entry.kind && String(d.idx) === String(entry.idx)),
        );
        if (remaining.length > 0) {
          setPendingDependents(remaining);
        } else {
          clearPendingDependents();
        }
      }
      setSelectedElement({ kind: targetKind, idx: String(entry.idx), modelClass: entry.kind });
      setOpen(false);
      reset();
    },
    [mode, setSelectedElement, setPendingDependents, clearPendingDependents, reset],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (disabledReason === undefined) setOpen(true);
        }}
        aria-label={`Delete ${kind} ${idx}`}
        // aria-disabled, not disabled: the button stays reachable, so the reason
        // can be read by hovering it or tabbing to it.
        aria-disabled={disabledReason === undefined ? undefined : true}
        title={disabledReason ?? 'Delete this element'}
        data-testid="delete-element-button"
        className={cn(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
          'transition-colors duration-[var(--duration-fast)]',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          disabledReason === undefined
            ? 'text-muted-foreground hover:text-danger hover:bg-danger/10'
            : 'text-muted-foreground/50 cursor-not-allowed',
          className,
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4 L13.5 4" />
          <path d="M6 4 V2.5 H10 V4" />
          <path d="M3.5 4 L4.5 13.5 L11.5 13.5 L12.5 4" />
          <path d="M6.5 7 V11" />
          <path d="M9.5 7 V11" />
        </svg>
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent data-testid="delete-element-dialog">
          {renderDialogBody({
            mode,
            model,
            kind,
            idx,
            timeline,
            isPending: deleteMutation.isPending,
            onSubmit: submit,
            onCancel: () => handleOpenChange(false),
            onDependentClick,
          })}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Say what a delete took, and that Undo brings it back: the element, what
 * depended on it, and the disturbances that acted on any of them (the server's
 * and the timeline's, which the delete hook has just taken off the list).
 */
function announceDeleted(data: DeleteElementResponse, model: string, idx: string): void {
  const others = Math.max((data.deleted ?? []).length - 1, 0);
  const fromTimeline =
    useDisturbanceStore.getState().removedWith[deletedElementKey(model, idx)]?.length ?? 0;
  const disturbances = (data.disturbances ?? []).length + fromTimeline;
  const went = [
    others > 0 ? `${count(others, 'element')} that depended on it` : null,
    disturbances > 0 ? `${count(disturbances, 'disturbance')} that acted on it` : null,
  ].filter((part) => part !== null);
  toast.success(`Deleted ${model} ${idx}`, {
    description: `${went.length > 0 ? `With it: ${went.join(' and ')}. ` : ''}Undo in the Edit menu brings ${went.length > 0 ? 'them' : 'it'} back.`,
  });
}

interface DialogBodyProps {
  mode: DialogMode;
  model: string;
  kind: string;
  idx: string;
  timeline: readonly DisturbanceLocal[];
  isPending: boolean;
  onSubmit: (cascade: boolean) => void;
  onCancel: () => void;
  onDependentClick: (entry: TopologyEntry) => void;
}

const LIST_ROW = cn(
  'flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)]',
  'border-border bg-background border px-2 py-1 text-left text-xs',
);

function renderDialogBody({
  mode,
  model,
  kind,
  idx,
  timeline,
  isPending,
  onSubmit,
  onCancel,
  onDependentClick,
}: DialogBodyProps) {
  if (mode.kind === 'deleting') {
    return (
      <>
        <DialogTitle>
          Deleting {kind} {idx}…
        </DialogTitle>
        <DialogDescription className="mt-2 flex items-center gap-2">
          <Spinner />
          <span>Deleting…</span>
        </DialogDescription>
      </>
    );
  }
  if (mode.kind === 'blocked') {
    const { dependents, total } = mode.body;
    const listed = mode.body.disturbances ?? [];
    const listedTotal = mode.body.disturbances_total ?? listed.length;
    const local = timelineOnly(
      timeline,
      [{ model, idx }, ...dependents.map((d) => ({ model: d.kind, idx: d.idx }))],
      listed,
    );
    const disturbanceCount = listedTotal + local.length;
    return (
      <>
        <DialogTitle>
          Delete {kind} {idx} with what depends on it?
        </DialogTitle>
        <DialogDescription className="mt-2">
          It cannot be deleted alone.{' '}
          {total > 0
            ? `${count(total, 'element')} ${total === 1 ? 'depends' : 'depend'} on it and cannot stay without it:`
            : null}
        </DialogDescription>
        {total > 0 ? (
          <ul
            data-testid="delete-dependents-list"
            className="mt-3 max-h-48 space-y-1 overflow-auto"
          >
            {dependents.map((entry) => {
              const row = (
                <>
                  <span className="font-mono">
                    {entry.kind} {String(entry.idx)}
                  </span>
                  <span className="text-muted-foreground truncate text-[10px]">{entry.name}</span>
                </>
              );
              return (
                <li key={`${entry.kind}-${String(entry.idx)}`}>
                  {modelToInspectorKind(entry.kind) === null ? (
                    <div
                      data-testid={`delete-dependent-${entry.kind}-${String(entry.idx)}`}
                      className={LIST_ROW}
                    >
                      {row}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDependentClick(entry)}
                      title="Show this element in the Inspector"
                      data-testid={`delete-dependent-${entry.kind}-${String(entry.idx)}`}
                      className={cn(
                        LIST_ROW,
                        'hover:bg-muted focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
                        'transition-colors focus-visible:outline-none',
                      )}
                    >
                      {row}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {total > dependents.length ? (
          <small
            data-testid="delete-dependents-cap-footer"
            className="text-muted-foreground mt-2 block text-[10px]"
          >
            Showing {dependents.length} of {total} dependents.
          </small>
        ) : null}
        {disturbanceCount > 0 ? (
          <>
            <p className="text-warning mt-3 text-xs" data-testid="delete-disturbances-warning">
              {count(disturbanceCount, 'disturbance')} {disturbanceCount === 1 ? 'acts' : 'act'} on{' '}
              {total > 0 ? 'these elements' : 'it'} and would be removed too:
            </p>
            <ul
              data-testid="delete-disturbances-list"
              className="mt-2 max-h-32 space-y-1 overflow-auto"
            >
              {listed.map((d, i) => (
                <li key={`listed-${i}`} className={LIST_ROW}>
                  {deletedDisturbanceSummary(d)}
                </li>
              ))}
              {local.map((d) => (
                <li key={d.id} className={LIST_ROW}>
                  {disturbanceSummary(d.spec)}, in the timeline
                </li>
              ))}
            </ul>
            {listedTotal > listed.length ? (
              <small className="text-muted-foreground mt-2 block text-[10px]">
                Showing {listed.length + local.length} of {disturbanceCount} disturbances.
              </small>
            ) : null}
          </>
        ) : null}
        <p className="text-muted-foreground mt-3 text-xs">
          Deleting them together is one change, which Undo in the Edit menu brings back whole.
        </p>
        <DialogFooter className="mt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isPending}
            data-testid="delete-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => onSubmit(true)}
            disabled={isPending}
            data-testid="delete-cascade"
          >
            {total > 0 ? `Delete all ${total + 1} elements` : 'Delete anyway'}
          </Button>
        </DialogFooter>
      </>
    );
  }
  // Default + error-other share the confirm layout; error-other layers an
  // inline message above the buttons.
  const local = disturbancesActingOn(timeline, [{ model, idx }]);
  return (
    <>
      <DialogTitle>
        Delete {kind} {idx}?
      </DialogTitle>
      <DialogDescription className="mt-2">Undo in the Edit menu brings it back.</DialogDescription>
      {local.length > 0 ? (
        <div className="mt-3" data-testid="delete-timeline-warning">
          <p className="text-warning text-xs">
            {count(local.length, 'disturbance')} in the timeline{' '}
            {local.length === 1 ? 'acts' : 'act'} on it and will be removed with it:
          </p>
          <ul className="mt-2 max-h-32 space-y-1 overflow-auto">
            {local.map((d) => (
              <li key={d.id} className={LIST_ROW}>
                {disturbanceSummary(d.spec)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {mode.kind === 'error-other' ? (
        <p role="alert" data-testid="delete-error" className="text-danger mt-3 text-xs">
          {mode.message}
        </p>
      ) : null}
      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
          data-testid="delete-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => onSubmit(false)}
          disabled={isPending}
          data-testid="delete-confirm"
        >
          Delete
        </Button>
      </DialogFooter>
    </>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="animate-spin"
      data-testid="delete-spinner"
    >
      <path d="M8 1.5 A6.5 6.5 0 1 1 1.5 8" />
    </svg>
  );
}
