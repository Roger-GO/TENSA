import { forwardRef, useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { BundleExportButton, BundleExportDialog } from '@/components/bundle/BundleExportDialog';
import { ReportDialog, ReportDialogButton } from '@/components/reports/ReportDialog';
import { SnapshotMenu } from '@/components/snapshot/SnapshotMenu';
import { HistoryDrawer, HistoryDrawerToggle } from '@/components/history/HistoryDrawer';
import { SweepDialog } from '@/components/sweep/SweepDialog';
import { Button } from '@/components/ui/button';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSweepStore } from '@/store/sweep';

/**
 * TopBar. Fixed-height (~44px) bar with three slots — left, center, right —
 * exposed as ReactNode props so other units can inject controls without the
 * shell needing to know about them.
 *
 * The three-prop shape was chosen over a children-with-data-slot or
 * subcomponent pattern because:
 *
 * - It keeps the public API trivially type-checked (each slot is just
 *   ReactNode).
 * - It avoids the runtime work of `React.Children.toArray` + filtering.
 * - It composes naturally with conditional rendering (`right={isLoaded ? …
 *   : null}`) without callers needing to remember a wrapper component.
 *
 * Per R18, the top bar is intentionally thin — it hosts the case label
 * (left), title or breadcrumbs (center), and run controls + view toggles
 * (right). All three slots are optional; an empty top bar still renders so
 * that the shell layout collapses predictably.
 *
 * The reproducibility-bundle export button (Unit 3 of the v2.0 plan) is
 * mounted inside the right slot region so it sits next to the existing
 * view-toggles and recovery badge. The dialog itself is portaled by Radix
 * and only mounts its hook-using inner body when the user opens it, so
 * test renderings of ``<TopBar />`` without a ``QueryClientProvider``
 * stay green.
 */
export interface TopBarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(
  { left, center, right, className, ...props },
  ref,
) {
  const [sweepDialogOpen, setSweepDialogOpen] = useState(false);
  return (
    <header
      ref={ref}
      role="banner"
      aria-label="Application top bar"
      className={cn(
        // 44px tall, full-width strip with a hairline border below.
        // Slot-level gap is bumped to gap-3 and we render thin
        // dividers between functional groups so the bar stops reading
        // as a 14-button wall (Phase-1 polish).
        'flex h-11 w-full shrink-0 items-center gap-3 px-3',
        'border-border bg-background/95 border-b backdrop-blur-sm',
        // soft shadow to anchor the bar against the canvas
        'shadow-[0_1px_0_0_rgba(0,0,0,0.02),0_1px_2px_-1px_rgba(0,0,0,0.04)]',
        // ensure the focus ring of any contained interactive element
        // isn't clipped at the top
        'relative z-10',
        className,
      )}
      {...props}
    >
      <div
        data-slot="left"
        className="flex min-w-0 flex-1 items-center justify-start gap-1"
      >
        {left}
      </div>
      <div
        data-slot="center"
        className="flex min-w-0 flex-initial items-center justify-center gap-2"
      >
        {center}
      </div>
      <div data-slot="right" className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {right}
        <span aria-hidden className="bg-border/80 mx-1 h-5 w-px" />
        <SnapshotMenu />
        <ReportDialogButton />
        <BundleExportButton />
        <SweepDialogButton onOpen={() => setSweepDialogOpen(true)} />
        <HistoryDrawerToggle />
      </div>
      <BundleExportDialog />
      <ReportDialog />
      <HistoryDrawer />
      <SweepDialog open={sweepDialogOpen} onOpenChange={setSweepDialogOpen} />
    </header>
  );
});

/** Trigger button for the SweepDialog. Mounted in the TopBar's right slot. */
function SweepDialogButton({ onOpen }: { onOpen: () => void }) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const activeSweepId = useSweepStore((s) => s.activeSweepId);
  const enabled =
    sessionId !== null && caseSelection !== null && activeSweepId === null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!enabled}
      onClick={onOpen}
      data-testid="sweep-dialog-trigger"
      aria-label="Start a sensitivity sweep"
    >
      Sweep
    </Button>
  );
}
