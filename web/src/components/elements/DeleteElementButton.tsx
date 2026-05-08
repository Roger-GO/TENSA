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
import type { SelectedElement } from '@/store/case';
import type { DeleteBlockedResponse, TopologyEntry } from '@/api/types';
import { cn } from '@/lib/cn';

/**
 * DeleteElementButton — trash-icon button + Radix Dialog confirm cycle
 * for deleting a previously-added pre-setup element.
 *
 * Render placement: per-element header of the ElementInspector, NOT
 * per-row alongside EditElementButton. Always visible when state is
 * pre-setup and PF is not running; otherwise the parent guards render.
 *
 * Dialog state machine (driven by the in-flight mutation + the latest
 * 422 body shape):
 *
 * - ``confirm``: default — "Delete <kind> <idx>? This cannot be undone."
 *   with Cancel + Delete (danger).
 * - ``deleting``: appears at >200ms after the user clicks Delete. Below
 *   200ms we close the dialog directly on success without a spinner
 *   flash — ANDES delete on small cases resolves in 50-150ms.
 * - ``blocked-dependents``: 422 with the typed ``DeleteBlockedResponse``
 *   body. Lists up to 25 dependent topology entries as clickable buttons;
 *   each click closes the dialog, navigates the inspector to that
 *   element, and pushes the *remaining* dependents into
 *   ``case.pendingDependents`` so the SLD canvas highlights them with a
 *   warning ring.
 * - ``blocked-case-file``: 422 with the verbatim "case-file-originated"
 *   ProblemDetails message. Cancel-only; the user must use the Reload
 *   button in the workflow toolbar to revert.
 * - ``error-other``: any other failure surfaces inline above the
 *   confirm buttons; the user can retry or cancel.
 *
 * The wire contract for ``DELETE /sessions/{id}/elements/{model}/{idx}``
 * is finalized in v0.1.y Unit 1; see the plan for the full taxonomy.
 */

/** Minimum elapsed time (ms) before showing the in-flight spinner. */
const SPINNER_DELAY_MS = 200;

const CASE_FILE_MESSAGE =
  'This element came from the loaded case file. Use the Reload button in the workflow toolbar to reset to the original case.';

/** Runtime narrow for the ``DeleteBlockedResponse`` body shape. */
function isDeleteBlockedResponse(body: unknown): body is DeleteBlockedResponse {
  if (body === null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return Array.isArray(obj.dependents) && typeof obj.total === 'number';
}

/** Map an ANDES model class name onto the inspector's kind taxonomy. */
function modelToInspectorKind(model: string): SelectedElement['kind'] | null {
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

export interface DeleteElementButtonProps {
  /** ANDES model class name (e.g., "Bus", "Line", "PV"). */
  model: string;
  /** ANDES idx, stringified. */
  idx: string;
  /** Inspector-taxonomy kind for the dialog text + dependents lookup. */
  kind: SelectedElement['kind'];
  className?: string;
}

type DialogMode =
  | { kind: 'confirm' }
  | { kind: 'deleting' }
  | { kind: 'blocked-dependents'; body: DeleteBlockedResponse }
  | { kind: 'blocked-case-file'; message: string }
  | { kind: 'error-other'; message: string };

export function DeleteElementButton({ model, idx, kind, className }: DeleteElementButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const setPendingDependents = useCaseStore((s) => s.setPendingDependents);
  const clearPendingDependents = useCaseStore((s) => s.clearPendingDependents);
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

  const onSubmit = useCallback(() => {
    if (!sessionId) return;
    cancelSpinnerTimer();
    spinnerTimerRef.current = setTimeout(() => {
      // Only flip into the "deleting" copy if the request hasn't resolved
      // yet AND the dialog is still showing the confirm view; an error
      // path that resolved sub-200ms shouldn't get retroactively
      // re-painted as "deleting".
      setMode((curr) => (curr.kind === 'confirm' ? { kind: 'deleting' } : curr));
    }, SPINNER_DELAY_MS);

    deleteMutation.mutate(
      { sessionId, model, idx },
      {
        onSuccess: () => {
          cancelSpinnerTimer();
          setOpen(false);
          setMode({ kind: 'confirm' });
        },
        onError: (err) => {
          cancelSpinnerTimer();
          if (err instanceof ProblemDetailsError && err.status === 422) {
            // Two sub-cases share the 422 status:
            // (a) cascade dependents → typed ``DeleteBlockedResponse`` body
            // (b) case-file-originated / unknown model → ``ProblemDetails``
            const body = err.rawBody;
            if (isDeleteBlockedResponse(body)) {
              setMode({ kind: 'blocked-dependents', body });
              return;
            }
            // Pattern-match the case-file-originated detail string. The
            // server emits it verbatim (we keep it as a single source of
            // truth on the server side per the plan). For any other 422
            // (e.g., unknown model), surface the detail text.
            const detail = err.detail ?? err.title;
            if (detail.includes('came from the loaded case file')) {
              setMode({ kind: 'blocked-case-file', message: CASE_FILE_MESSAGE });
            } else {
              setMode({ kind: 'error-other', message: detail });
            }
            return;
          }
          if (err instanceof ProblemDetailsError) {
            setMode({
              kind: 'error-other',
              message: err.detail ?? err.title ?? 'Delete failed',
            });
            return;
          }
          setMode({ kind: 'error-other', message: err.message ?? 'Delete failed' });
        },
      },
    );
  }, [sessionId, model, idx, deleteMutation, cancelSpinnerTimer]);

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
      if (mode.kind === 'blocked-dependents') {
        const remaining = mode.body.dependents.filter(
          (d) => !(d.kind === entry.kind && String(d.idx) === String(entry.idx)),
        );
        if (remaining.length > 0) {
          setPendingDependents(remaining);
        } else {
          clearPendingDependents();
        }
      }
      setSelectedElement({ kind: targetKind, idx: String(entry.idx) });
      setOpen(false);
      reset();
    },
    [mode, setSelectedElement, setPendingDependents, clearPendingDependents, reset],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Delete ${kind} ${idx}`}
        title="Delete this element"
        data-testid="delete-element-button"
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)]',
          'text-muted-foreground hover:text-destructive hover:bg-destructive/10',
          'transition-colors duration-[var(--duration-fast)]',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
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
            kind,
            idx,
            isPending: deleteMutation.isPending,
            onSubmit,
            onCancel: () => handleOpenChange(false),
            onDependentClick,
          })}
        </DialogContent>
      </Dialog>
    </>
  );
}

interface DialogBodyProps {
  mode: DialogMode;
  kind: SelectedElement['kind'];
  idx: string;
  isPending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onDependentClick: (entry: TopologyEntry) => void;
}

function renderDialogBody({
  mode,
  kind,
  idx,
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
  if (mode.kind === 'blocked-dependents') {
    const { dependents, total } = mode.body;
    return (
      <>
        <DialogTitle>Delete blocked</DialogTitle>
        <DialogDescription className="mt-2">
          {total} element{total === 1 ? '' : 's'} reference this {kind}. Delete those first:
        </DialogDescription>
        <ul data-testid="delete-dependents-list" className="mt-3 max-h-64 space-y-1 overflow-auto">
          {dependents.map((entry) => (
            <li key={`${entry.kind}-${String(entry.idx)}`}>
              <button
                type="button"
                onClick={() => onDependentClick(entry)}
                data-testid={`delete-dependent-${entry.kind}-${String(entry.idx)}`}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)]',
                  'border-border bg-background border px-2 py-1 text-left text-xs',
                  'hover:bg-muted focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
                  'transition-colors focus-visible:outline-none',
                )}
              >
                <span className="font-mono">
                  {entry.kind} {String(entry.idx)}
                </span>
                <span className="text-muted-foreground truncate text-[10px]">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {total > dependents.length ? (
          <small
            data-testid="delete-dependents-cap-footer"
            className="text-muted-foreground mt-2 block text-[10px]"
          >
            Showing {dependents.length} of {total} dependents. Delete the visible ones first.
          </small>
        ) : null}
        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (mode.kind === 'blocked-case-file') {
    return (
      <>
        <DialogTitle>Cannot delete</DialogTitle>
        <DialogDescription data-testid="delete-case-file-message" className="mt-2">
          {mode.message}
        </DialogDescription>
        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  }
  // Default + error-other share the confirm layout; error-other layers an
  // inline message above the buttons.
  return (
    <>
      <DialogTitle>
        Delete {kind} {idx}?
      </DialogTitle>
      <DialogDescription className="mt-2">This cannot be undone.</DialogDescription>
      {mode.kind === 'error-other' ? (
        <p role="alert" data-testid="delete-error" className="text-destructive mt-3 text-xs">
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
          onClick={onSubmit}
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
