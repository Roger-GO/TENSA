import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { ProfileImportDialog } from './ProfileImportDialog';

/**
 * Top-bar entry point for TimeSeries profile import (Unit 15).
 *
 * Sits next to the PMU placement button in the top bar's left slot.
 * Opens ``ProfileImportDialog`` for the upload + assignment flow.
 *
 * Enable rules mirror ``PmuPlacementButton``:
 * - Disabled when no topology is loaded.
 * - Disabled when the session is committed (TimeSeries staging is
 *   pre-setup only — the substrate returns 409 with a "reload to
 *   recover" hint).
 * - Disabled while PFlow is running.
 */
export function ProfileImportButton() {
  const topology = useCurrentTopology();
  const isRunning = usePflowStore((s) => s.isRunning);
  const [open, setOpen] = useState(false);

  const noTopology = topology === null;
  const committed = topology?.state === 'committed';

  let disabledReason: string | null = null;
  if (noTopology) disabledReason = 'Load or start a system first.';
  else if (committed) disabledReason = 'Reset the run to import profiles.';
  else if (isRunning) disabledReason = 'Wait for PF to finish.';

  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabledReason !== null}
      onClick={() => setOpen(true)}
      data-testid="profile-import-button"
    >
      <span aria-hidden="true">＋</span>
      <span className="ml-1">Import profile…</span>
    </Button>
  );

  if (disabledReason !== null) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-block">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>{disabledReason}</TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <>
      {button}
      <ProfileImportDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
