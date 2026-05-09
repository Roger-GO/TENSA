import { useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useUiStore } from '@/store/ui';
import type { RightDockTopPanel } from '@/store/ui';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore } from '@/store/runs';
import { cn } from '@/lib/cn';

/**
 * PanelPickerTabs — the per-region tab strip that swaps which dockable
 * panel mounts in the right-dock top region. v0.2 Unit 8.
 *
 * Behavior (per the v0.2 plan, "Panel-picker disable rules"):
 *
 * - All four candidate panels swap freely when no active TDS run.
 * - While a TDS run is in ``starting`` or ``streaming``, the
 *   ``disturbance`` tab is greyed (mid-run edits aren't possible per the
 *   ANDES contract). Tooltip explains.
 * - Other tabs remain swappable during a run; this is a deliberate
 *   choice — the user often wants to compare config or inspect state
 *   while frames stream in.
 *
 * State lives on ``useUiStore.activeRightDockTopPanel``. The component
 * is driven entirely by the store; consumers (App.tsx) read the same
 * value to decide which panel to render.
 *
 * Light use of Radix would be nicer here long-term but a flat
 * ``role="tablist"`` keeps the bundle smaller and matches the existing
 * v0.1 segmented-control pattern in ``RunButton``.
 */

interface TabSpec {
  id: RightDockTopPanel;
  label: string;
  /** Optional hint shown on hover when the tab is enabled. */
  hint?: string;
  /** When set, the tab is disabled and the tooltip explains why. */
  disabledReason?: string;
}

export interface PanelPickerTabsProps {
  className?: string;
}

export function PanelPickerTabs({ className }: PanelPickerTabsProps) {
  const active = useUiStore((s) => s.activeRightDockTopPanel);
  const setActive = useUiStore((s) => s.setActiveRightDockTopPanel);

  const disturbanceCount = useDisturbanceStore((s) => s.disturbances.length);
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const activeRunState = useRunsStore((s) =>
    activeRunId === null ? null : (s.runs[activeRunId]?.state ?? null),
  );
  const isRunning =
    activeRunState === 'starting' || activeRunState === 'streaming';

  const tabs = useMemo<TabSpec[]>(() => {
    const disturbanceDisabled = isRunning
      ? 'Disturbances cannot be edited mid-run. Abort or wait for the run to finish.'
      : undefined;
    return [
      { id: 'inspector', label: 'Inspector', hint: 'Element properties + last PF result' },
      {
        id: 'disturbance',
        label: 'Disturbances',
        hint:
          disturbanceCount > 0
            ? `${disturbanceCount} scheduled`
            : 'Define faults, line trips, or parameter changes',
        disabledReason: disturbanceDisabled,
      },
      { id: 'plot', label: 'Plot', hint: 'Streaming time-series + scrub' },
      {
        id: 'analyze',
        label: 'Analyze',
        hint: 'PF / TDS / EIG sub-modes + result views',
      },
    ];
  }, [isRunning, disturbanceCount]);

  return (
    <div
      role="tablist"
      aria-label="Right dock top panel"
      data-testid="panel-picker-tabs"
      className={cn(
        'flex items-center gap-0.5',
        'border-border border-b px-2 py-1',
        'overflow-x-auto',
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        const disabled = Boolean(tab.disabledReason);
        const hintCopy = tab.disabledReason ?? tab.hint;
        const trigger = (
          <button
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={disabled || undefined}
            tabIndex={isActive ? 0 : -1}
            data-testid={`panel-picker-tab-${tab.id}`}
            data-active={isActive ? 'true' : 'false'}
            data-disabled={disabled ? 'true' : 'false'}
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              setActive(tab.id);
            }}
            className={cn(
              'inline-flex items-center justify-center rounded-[var(--radius-sm)]',
              'px-2.5 py-1 text-xs font-medium whitespace-nowrap',
              'transition-[background-color,color]',
              'duration-[var(--duration-fast)] ease-[var(--ease-out-spring)]',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              isActive
                ? 'bg-primary/15 text-foreground'
                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            {tab.label}
          </button>
        );

        if (!hintCopy) return <span key={tab.id}>{trigger}</span>;
        return (
          <TooltipProvider key={tab.id} delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>{trigger}</TooltipTrigger>
              <TooltipPortal>
                <TooltipContent>{hintCopy}</TooltipContent>
              </TooltipPortal>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </div>
  );
}
