/**
 * SaveSnapshotDialog (Unit 7 of the v2.0 plan).
 *
 * Modal that captures a snapshot name from the user and POSTs to
 * ``/api/sessions/{id}/snapshot``. Mirrors BundleExportDialog's
 * deferred-mount pattern: the inner body (which uses ``useMutation``)
 * is only rendered when ``saveDialogOpen`` is true so unit-test
 * renderings of the menu without a QueryClientProvider stay green.
 *
 * Validation is client-side (1-64 chars of [A-Za-z0-9._-] starting with
 * an alphanumeric — same regex the substrate enforces). The substrate
 * gets the final say; a 422 from a name we didn't catch surfaces inline.
 *
 * Collision policy: the substrate returns 409 on name reuse unless
 * ``force=true``. The dialog catches the 409 and shows a "Snapshot
 * already exists — overwrite?" inline confirm; clicking re-issues the
 * mutation with ``force=true``.
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
import { Input } from '@/components/ui/Input';
import { useSaveSnapshot } from '@/api/queries';
import { useSnapshotStore } from '@/store/snapshot';
import { useSessionStore } from '@/store/session';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateName(name: string): string | null {
  if (name.length === 0) return 'Name is required.';
  if (!NAME_RE.test(name)) return 'Use 1-64 chars of letters, digits, dot, underscore, or dash.';
  return null;
}

export function SaveSnapshotDialog() {
  const dialogOpen = useSnapshotStore((s) => s.saveDialogOpen);
  const closeDialogs = useSnapshotStore((s) => s.closeDialogs);
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) closeDialogs();
      }}
    >
      {dialogOpen ? <SaveSnapshotDialogInner /> : null}
    </Dialog>
  );
}

function SaveSnapshotDialogInner() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const pendingName = useSnapshotStore((s) => s.pendingName);
  const setPendingName = useSnapshotStore((s) => s.setPendingName);
  const status = useSnapshotStore((s) => s.saveStatus);
  const error = useSnapshotStore((s) => s.saveError);
  const closeDialogs = useSnapshotStore((s) => s.closeDialogs);
  const markPending = useSnapshotStore((s) => s.markSavePending);
  const markSuccess = useSnapshotStore((s) => s.markSaveSuccess);
  const markError = useSnapshotStore((s) => s.markSaveError);

  const saveMutation = useSaveSnapshot();
  const [collisionName, setCollisionName] = useState<string | null>(null);

  const validation = validateName(pendingName);
  const isPending = status === 'pending';

  const submit = async (force: boolean) => {
    if (sessionId === null || validation !== null) return;
    markPending();
    try {
      await saveMutation.mutateAsync({ sessionId, name: pendingName, force });
      markSuccess();
      setCollisionName(null);
      // Auto-close after a short beat so the user sees success.
      setTimeout(() => closeDialogs(), 600);
    } catch (err) {
      if (err instanceof ProblemDetailsError && err.status === 409) {
        // Surface an inline overwrite confirm rather than a hard error.
        setCollisionName(pendingName);
        markError(err.detail ?? 'Snapshot already exists.');
        return;
      }
      const detail =
        err instanceof ProblemDetailsError
          ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
          : err instanceof Error
            ? err.message
            : 'unknown error';
      markError(`Save failed: ${detail}`);
    }
  };

  return (
    <DialogContent data-testid="save-snapshot-dialog">
      <DialogTitle>Save snapshot</DialogTitle>
      <DialogDescription className="mt-2">
        Capture the current operating point + disturbance log as a named snapshot. Snapshots live
        under the workspace and survive across sessions; the dill optimisation kicks in when the
        ANDES version matches.
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-foreground text-xs font-medium">Name</span>
          <Input
            type="text"
            data-testid="save-snapshot-name-input"
            value={pendingName}
            onChange={(next) => {
              setPendingName(next);
              setCollisionName(null);
            }}
            placeholder="scenario-A"
            disabled={isPending}
            autoFocus
          />
        </label>
        {validation !== null && pendingName.length > 0 ? (
          <p
            role="alert"
            data-testid="save-snapshot-validation-error"
            className="text-danger text-xs"
          >
            {validation}
          </p>
        ) : null}
        {error !== null && collisionName === null ? (
          <div
            role="alert"
            data-testid="save-snapshot-error"
            className={cn(
              'border-danger/30 bg-danger/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            {error}
          </div>
        ) : null}
        {collisionName !== null ? (
          <div
            role="alert"
            data-testid="save-snapshot-collision"
            className={cn(
              'border-warning/30 bg-warning/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            A snapshot named <code>{collisionName}</code> already exists. Overwrite?
          </div>
        ) : null}
        {status === 'success' ? (
          <div
            role="status"
            data-testid="save-snapshot-success"
            className={cn(
              'border-success/30 bg-success/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            Snapshot saved.
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
          data-testid="save-snapshot-cancel"
        >
          Cancel
        </Button>
        {collisionName !== null ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void submit(true)}
            disabled={isPending}
            data-testid="save-snapshot-confirm-overwrite"
          >
            {isPending ? 'Saving…' : 'Overwrite'}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void submit(false)}
            disabled={isPending || sessionId === null || validation !== null}
            data-testid="save-snapshot-confirm"
          >
            {isPending ? 'Saving…' : 'Save'}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
