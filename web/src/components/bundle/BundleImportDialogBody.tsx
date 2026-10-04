/**
 * BundleImportDialogBody: the content of the bundle-import dialog (file
 * picker, manifest preview, conflict resolver, confirm). ``BundleImportButton``
 * in ``BundleImportDialog.tsx`` renders it inside its ``<Dialog>`` once the user
 * opens the dialog. It is a module of its own so that it, with the conflict
 * resolver and the import mutation it uses, loads on that first open and not
 * with the file picker the button sits in.
 *
 * State ownership: this component owns the picked file, the most recent plan,
 * and the user's resolution choices. The mutation itself lives in queries.ts
 * (``useImportBundle``) so other call sites can re-use it.
 */
import { useState } from 'react';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useImportBundle } from '@/api/queries';
import type { BundleImportResponse } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';
import { ProblemDetailsError } from '@/api/client';
import { parseWorkspacePath } from '@/api/types';
import { BundleConflictResolver } from './BundleConflictResolver';
import { cn } from '@/lib/cn';
import { useSafeTimeout } from '@/lib/useSafeTimeout';

export interface BundleImportDialogBodyProps {
  onClose: () => void;
}

export function BundleImportDialogBody({ onClose }: BundleImportDialogBodyProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const setCase = useCaseStore((s) => s.setCase);

  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<BundleImportResponse | null>(null);
  const [useBundleCase, setUseBundleCase] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const importMutation = useImportBundle();
  const isPending = importMutation.isPending;

  // The auto-close beat after a committed import must not outlive the dialog:
  // closing it by hand inside the beat (or before the import answered) would
  // otherwise let the timer shut a dialog that was re-opened since.
  const schedule = useSafeTimeout();

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
      // Choosing a case starts a fresh edit journal, which forgets what the import's
      // own success handler noted: the system is the bundle's, not that file's, so
      // Save must not write it over the file. Say so again, after the selection.
      useEditJournalStore.getState().markReplaced();
      setSuccessMessage(
        `Imported ${response.case_filename}. ${response.disturbances_replayed} disturbance${
          response.disturbances_replayed === 1 ? '' : 's'
        } replayed.`,
      );
      // Auto-close after a brief beat (mirrors BundleExportDialog).
      schedule(() => {
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
