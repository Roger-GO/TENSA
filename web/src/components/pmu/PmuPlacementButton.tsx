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
import { PmuPlacementDialog } from './PmuPlacementDialog';

/**
 * Top-bar entry point for PMU placement (Unit 14).
 *
 * Sits next to the "+ Add element" button in the top bar's left slot.
 * Opens ``PmuPlacementDialog`` which lets the user check buses and
 * place PMUs in bulk.
 *
 * Enable rules mirror ``AddElementButton``:
 * - Disabled when no topology is loaded.
 * - Disabled when the session is committed (PMU placement is pre-setup
 *   only — the substrate returns 409 with a "reload to recover" hint).
 * - Disabled while PFlow is running.
 */
export function PmuPlacementButton() {
  const topology = useCurrentTopology();
  const isRunning = usePflowStore((s) => s.isRunning);
  const [open, setOpen] = useState(false);

  const noTopology = topology === null;
  const committed = topology?.state === 'committed';

  let disabledReason: string | null = null;
  if (noTopology) disabledReason = 'Load or start a system first.';
  else if (committed) disabledReason = 'Reset the run to add PMUs.';
  else if (isRunning) disabledReason = 'Wait for PF to finish.';

  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabledReason !== null}
      onClick={() => setOpen(true)}
      data-testid="pmu-placement-button"
    >
      <span aria-hidden="true">＋</span>
      <span className="ml-1">Add PMU…</span>
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
      <PmuPlacementDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
