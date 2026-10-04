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
 * This module holds the trigger button and the dialog shell. The dialog's
 * content, which owns the picked file, the most recent plan, and the
 * user's resolution choices, is ``BundleImportDialogBody`` and loads when
 * the dialog first opens. The mutation itself lives in queries.ts
 * (``useImportBundle``) so other call sites (e.g., a future "Import from
 * URL" affordance) can re-use it.
 */
import { Suspense, useState } from 'react';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSessionStore } from '@/store/session';
import { lazyNamed } from '@/lib/lazyNamed';

// The dialog's content (and the conflict resolver and import mutation behind
// it) loads the first time the dialog opens; the button is what ships with the
// file picker and the Workspace menu.
const BundleImportDialogBody = lazyNamed(
  () => import('./BundleImportDialogBody'),
  'BundleImportDialogBody',
  'overlay',
);

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
      {open ? (
        <Suspense fallback={null}>
          <BundleImportDialogBody onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </Dialog>
  );
}
