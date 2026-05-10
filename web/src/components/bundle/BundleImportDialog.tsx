/**
 * BundleImportDialog (Unit 10 of the v2.0 plan).
 *
 * Counterpart to ``BundleExportDialog``. Modal that lets the user
 * import a previously-exported reproducibility ``.zip`` bundle into
 * the current session.
 *
 * Flow:
 *
 * 1. User clicks "Import bundle" (rendered next to "Open case" in the
 *    workspace file picker). Dialog mounts in the file-picker state.
 * 2. User picks a ``.zip`` from disk. Dialog flips into the
 *    "validating…" state and POSTs the file to
 *    ``/api/sessions/{id}/bundle/import`` (no ``force_resolve``).
 * 3. Substrate returns either:
 *    - ``status="committed"`` → success state; auto-closes after a
 *      brief beat. Topology and workspace caches are invalidated by
 *      the mutation hook.
 *    - ``status="plan"`` (carried over a 409) → BundleConflictResolver
 *      mounts inline. User picks resolution. Confirm fires the
 *      mutation again with ``force_resolve=true`` and the resolution
 *      flags.
 * 4. Errors (400/422) surface inline; the user can pick a different
 *    file and retry.
 *
 * State ownership: this component owns the picked file, the most
 * recent plan, and the user's resolution choices. The mutation
 * itself lives in queries.ts (``useImportBundle``) so other call
 * sites (e.g., a future "Import from URL" affordance) can re-use it.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useImportBundle } from '@/api/queries';
import type { BundleImportResponse } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { ProblemDetailsError } from '@/api/client';
import { parseWorkspacePath } from '@/api/types';
import { BundleConflictResolver } from './BundleConflictResolver';
import { cn } from '@/lib/cn';

export interface BundleImportButtonProps {
  /**
   * Optional className passthrough so the picker can style the
   * button to match the surrounding "Open case" affordance.
   */
  className?: string;
}

/**
 * Trigger button. Renders next to "Open case" / "Load" in the
 * WorkspaceFilePicker. Disabled when no session is present (the
 * import endpoint is session-scoped).
 */
export function BundleImportButton({ className }: BundleImportButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={sessionId === null}
          data-testid="bundle-import-button"
          className={className}
        >
          Import bundle
        </Button>
      </DialogTrigger>
      {open ? <BundleImportDialogInner onClose={() => setOpen(false)} /> : null}
    </Dialog>
  );
}

interface BundleImportDialogInnerProps {
  onClose: () => void;
}

function BundleImportDialogInner({ onClose }: BundleImportDialogInnerProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const setCase = useCaseStore((s) => s.setCase);

  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<BundleImportResponse | null>(null);
  const [useBundleCase, setUseBundleCase] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const importMutation = useImportBundle();
  const isPending = importMutation.isPending;

  const reset = () => {
    setFile(null);
    setPlan(null);
    setUseBundleCase(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    importMutation.reset();
  };

  const submit = async ({ forceResolve }: { forceResolve: boolean }) => {
    if (sessionId === null || file === null) return;
    setErrorMessage(null);
    try {
      const response = await importMutation.mutateAsync({
        sessionId,
        file,
        forceResolve,
        useBundleCase,
      });
      if (response.status === 'plan') {
        setPlan(response);
        return;
      }
      // Committed — mirror the substrate's case selection into the
      // case slice so the picker swaps to the summary card without
      // requiring a manual "Load" click. The case_filename is the
      // basename; addfile_filenames is the relative addfile list.
      const primary = parseWorkspacePath(response.case_filename ?? '');
      const addfiles = response.addfile_filenames.map((f) => parseWorkspacePath(f));
      setCase({ primaryPath: primary, addfiles });
      setSuccessMessage(
        `Imported ${response.case_filename}. ${response.disturbances_replayed} disturbance${
          response.disturbances_replayed === 1 ? '' : 's'
        } replayed.`,
      );
      // Auto-close after a brief beat (mirrors BundleExportDialog).
      setTimeout(() => {
        reset();
        onClose();
      }, 800);
    } catch (err) {
      const detail =
        err instanceof ProblemDetailsError
          ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
          : err instanceof Error
            ? err.message
            : 'unknown error';
      setErrorMessage(`Import failed: ${detail}`);
    }
  };

  // The file-picker state is when we have no plan yet.
  const showPicker = plan === null;
  // The conflict-resolver state is when the substrate returned a plan
  // with conflicts. The "Confirm" button is disabled while a blocker
  // is unresolved.
  const showConflicts = plan !== null && plan.plan.has_conflicts;
  const blockedByConflict = plan?.plan.blocked === true;

  return (
    <DialogContent data-testid="bundle-import-dialog">
      <DialogTitle>Import reproducibility bundle</DialogTitle>
      <DialogDescription className="mt-2">
        Restore a case + disturbances + last TDS run from a colleague&apos;s ``.zip`` bundle. The
        substrate validates the bundle against your workspace before committing; conflicts (case
        already in workspace, ANDES version mismatch, missing addfile) are surfaced inline.
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3">
        {showPicker ? (
          <div className="flex flex-col gap-2">
            <label
              htmlFor="bundle-import-file"
              className="text-muted-foreground text-xs font-medium"
            >
              Bundle file
            </label>
            <input
              id="bundle-import-file"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null;
                setFile(next);
                setErrorMessage(null);
              }}
              data-testid="bundle-import-file-input"
              className={cn(
                'border-border bg-background text-foreground',
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
                'file:bg-muted file:text-foreground file:mr-2 file:rounded-[var(--radius-sm)]',
                'file:border-0 file:px-2 file:py-1 file:text-xs',
              )}
            />
            {file !== null ? (
              <p
                className="text-muted-foreground font-mono text-xs"
                data-testid="bundle-import-file-name"
              >
                {file.name} ({Math.ceil(file.size / 1024)} KB)
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              data-testid="bundle-import-manifest-preview"
              className={cn(
                'border-border bg-muted/30 rounded-[var(--radius-sm)] border px-3 py-2',
                'text-xs',
              )}
            >
              <p className="text-muted-foreground font-medium">Bundle manifest</p>
              <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 font-mono">
                <dt className="text-muted-foreground">case</dt>
                <dd>{plan.plan.manifest.case_filename ?? '—'}</dd>
                <dt className="text-muted-foreground">andes</dt>
                <dd>{plan.plan.manifest.andes_version}</dd>
                <dt className="text-muted-foreground">disturbances</dt>
                <dd>{plan.plan.manifest.disturbance_count}</dd>
                <dt className="text-muted-foreground">exported</dt>
                <dd className="truncate" title={plan.plan.manifest.exported_at}>
                  {plan.plan.manifest.exported_at}
                </dd>
              </dl>
            </div>
            <BundleConflictResolver
              plan={plan.plan}
              useBundleCase={useBundleCase}
              onUseBundleCaseChange={setUseBundleCase}
            />
          </div>
        )}

        {errorMessage !== null ? (
          <div
            role="alert"
            data-testid="bundle-import-error"
            className={cn(
              'border-danger/30 bg-danger/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            {errorMessage}
          </div>
        ) : null}
        {successMessage !== null ? (
          <div
            role="status"
            data-testid="bundle-import-success"
            className={cn(
              'border-success/30 bg-success/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            {successMessage}
          </div>
        ) : null}
      </div>

      <DialogFooter className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            reset();
            onClose();
          }}
          disabled={isPending}
          data-testid="bundle-import-cancel"
        >
          Cancel
        </Button>
        {showConflicts ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void submit({ forceResolve: true })}
            disabled={isPending || blockedByConflict || sessionId === null}
            data-testid="bundle-import-confirm-resolution"
          >
            {isPending ? 'Importing…' : 'Confirm resolution'}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void submit({ forceResolve: false })}
            disabled={isPending || file === null || sessionId === null}
            data-testid="bundle-import-validate"
          >
            {isPending ? 'Validating…' : 'Import'}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
