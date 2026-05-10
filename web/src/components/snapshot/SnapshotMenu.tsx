/**
 * SnapshotMenu (Unit 7 of the v2.0 plan).
 *
 * TopBar-mounted dropdown that exposes the snapshot save / load actions.
 * Uses ``Popover`` (the project's existing non-modal disclosure
 * primitive) rather than a raw ``select`` so the menu's keyboard nav +
 * focus management come from Radix.
 *
 * Items:
 *
 * - "Save snapshot..." → opens ``<SaveSnapshotDialog />`` with a name
 *   input.
 * - "Load snapshot..." → opens ``<LoadSnapshotDialog />`` showing the
 *   substrate's listing.
 *
 * Disabled when no session + case is loaded — snapshot save / restore
 * scope to a loaded case.
 *
 * The dialogs themselves are rendered alongside the trigger so they can
 * portal into the document body without depending on the popover
 * portal's lifetime. The deferred-mount pattern from Unit 3's
 * BundleExportDialog keeps the QueryClient-using inner dialog body off
 * the tree until the user opens it (so unit-test renderings of TopBar
 * without a QueryClientProvider stay green).
 */
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSnapshotStore } from '@/store/snapshot';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { SaveSnapshotDialog } from '@/components/snapshot/SaveSnapshotDialog';
import { LoadSnapshotDialog } from '@/components/snapshot/LoadSnapshotDialog';
import { cn } from '@/lib/cn';
import { useState } from 'react';

export function SnapshotMenu() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const openSaveDialog = useSnapshotStore((s) => s.openSaveDialog);
  const openLoadDialog = useSnapshotStore((s) => s.openLoadDialog);
  const enabled = sessionId !== null && caseSelection !== null;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!enabled}
            data-testid="snapshot-menu-trigger"
          >
            Snapshots
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-2" data-testid="snapshot-menu-content">
          <button
            type="button"
            onClick={() => {
              openSaveDialog();
              setOpen(false);
            }}
            data-testid="snapshot-menu-save"
            className={cn(
              'hover:bg-muted/60 focus:bg-muted/60 w-full',
              'rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm',
              'outline-none focus:ring-2 focus:ring-[var(--ring-color)]',
            )}
          >
            Save snapshot…
          </button>
          <button
            type="button"
            onClick={() => {
              openLoadDialog();
              setOpen(false);
            }}
            data-testid="snapshot-menu-load"
            className={cn(
              'hover:bg-muted/60 focus:bg-muted/60 w-full',
              'rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm',
              'outline-none focus:ring-2 focus:ring-[var(--ring-color)]',
            )}
          >
            Load snapshot…
          </button>
          <p className="text-muted-foreground mt-2 px-2 text-[10px] leading-snug">
            Snapshots capture the converged operating point + disturbance log. Composable with ANDES
            upgrades (slow-path replay always works); the dill optimisation kicks in when versions
            match.
          </p>
        </PopoverContent>
      </Popover>
      <SaveSnapshotDialog />
      <LoadSnapshotDialog />
    </>
  );
}
