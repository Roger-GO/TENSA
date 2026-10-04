/**
 * SaveAsCustomCaseDialog (v3.1 Unit 22): "Save parameter edits as case".
 *
 * Modal that captures a name and writes the current clone-on-write case (the
 * case files with the controller parameter edits made in Edit mode, in the
 * format of the case that was opened) to the workspace as a custom case via
 * ``POST /sessions/{id}/case/clone/save-as``. Save system as is the other way
 * to write a new file: the whole system, in a format chosen there.
 * Mirrors ``SaveSnapshotDialog``'s deferred-mount pattern: the inner body (which
 * uses ``useMutation`` + the workspace-files query) only renders when the dialog
 * is open so unit-test renderings without a QueryClientProvider stay green.
 *
 * Validation:
 *  - name rule: ``userNameProblem`` (1-64 chars of ``[A-Za-z0-9._-]`` starting
 *    with an alphanumeric, no trailing dot, no Windows device name), the same
 *    rule the substrate enforces.
 *  - collision: case-insensitive comparison of the stem against existing
 *    workspace files. A collision is a hard inline error ("Name already in
 *    use…") — unlike snapshots, save-as has no force-overwrite affordance here.
 *
 * On a successful save the workspace-files query is invalidated by
 * ``useCloneSaveAs`` so the new case appears in ``SavedCasesList`` immediately.
 */
import { useEffect, useId, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { useCloneSaveAs, useListWorkspaceFiles } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { subscribePaletteDialog } from '@/lib/commands';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';
import { userNameProblem } from '@/lib/fileName';
import { stemOf } from '@/lib/paths';
import { useSafeTimeout } from '@/lib/useSafeTimeout';

export interface SaveAsCustomCaseDialogProps {
  /** Controlled open state. When omitted the dialog self-manages via the
   *  palette bridge (the ``clone.save-as`` command). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SaveAsCustomCaseDialog({ open, onOpenChange }: SaveAsCustomCaseDialogProps) {
  // Self-managed open state when uncontrolled — the palette command fires the
  // ``save-as-custom`` bridge event to open it.
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const dialogOpen = isControlled ? open : internalOpen;

  useEffect(() => {
    if (isControlled) return;
    return subscribePaletteDialog((key) => {
      if (key === 'save-as-custom') setInternalOpen(true);
    });
  }, [isControlled]);

  const setOpen = (next: boolean) => {
    if (isControlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      {dialogOpen ? <SaveAsCustomCaseDialogInner onClose={() => setOpen(false)} /> : null}
    </Dialog>
  );
}

function SaveAsCustomCaseDialogInner({ onClose }: { onClose: () => void }) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const nameErrorId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const saveAs = useCloneSaveAs();
  const filesQuery = useListWorkspaceFiles();
  // The auto-close beat after a save must not outlive this body: dismissing
  // the dialog inside the beat (or before the save answered) and opening it
  // again would otherwise let the old timer close the new dialog.
  const schedule = useSafeTimeout();

  const existingStems = new Set(
    (filesQuery.data?.files ?? []).map((f) => stemOf(f.name).toLowerCase()),
  );

  const shapeError = name.length === 0 ? null : userNameProblem(name);
  const collision = name.length > 0 && existingStems.has(name.toLowerCase());
  const validation =
    shapeError ?? (collision ? 'Name already in use; pick a different name.' : null);
  const isPending = saveAs.isPending;

  const submit = () => {
    if (sessionId === null || name.length === 0 || validation !== null || isPending) return;
    setError(null);
    saveAs.mutate(
      { sessionId, name },
      {
        onSuccess: () => {
          setSaved(true);
          schedule(onClose, 600);
        },
        onError: (err) => {
          const detail =
            err instanceof ProblemDetailsError
              ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
              : err instanceof Error
                ? err.message
                : 'unknown error';
          setError(`Save failed: ${detail}`);
        },
      },
    );
  };

  return (
    <DialogContent data-testid="save-as-custom-case-dialog">
      <DialogTitle>Save parameter edits as case</DialogTitle>
      <DialogDescription className="mt-2">
        Write the current edited case to your workspace as a new case file, in the format of the
        case you opened. The original case is never modified; the saved case carries all of your
        controller parameter edits.
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-foreground text-xs font-medium">Case name</span>
          <Input
            type="text"
            data-testid="save-as-custom-name-input"
            value={name}
            onChange={(next) => {
              setName(next);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="kundur_tuned"
            disabled={isPending}
            aria-invalid={validation !== null || error !== null}
            aria-describedby={validation !== null || error !== null ? nameErrorId : undefined}
            autoFocus
          />
        </label>
        {/* Single described-by region so the name input announces whichever
            message is active (validation or server error). */}
        <div id={nameErrorId}>
          {validation !== null ? (
            <p
              role="alert"
              data-testid="save-as-custom-validation-error"
              className="text-danger text-xs"
            >
              {validation}
            </p>
          ) : null}
          {error !== null ? (
            <div
              role="alert"
              data-testid="save-as-custom-error"
              className={cn(
                'border-danger/30 bg-danger/10 text-foreground',
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
              )}
            >
              {error}
            </div>
          ) : null}
        </div>
        {saved ? (
          <div
            role="status"
            data-testid="save-as-custom-success"
            className={cn(
              'border-success/30 bg-success/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            Case saved to workspace.
          </div>
        ) : null}
      </div>

      <DialogFooter className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={isPending}
          data-testid="save-as-custom-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={isPending || sessionId === null || name.length === 0 || validation !== null}
          data-testid="save-as-custom-confirm"
        >
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
