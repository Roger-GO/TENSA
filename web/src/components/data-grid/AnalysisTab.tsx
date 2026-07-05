/**
 * AnalysisTab (v3 Unit 14).
 *
 * Inner sub-tab strip for the Analysis bucket of the BottomDrawer:
 * Plot | EIG | CPF | SE | TDS. Per F-FEAS-3 each sub-tab mounts an
 * existing chart component as-is — no rewrites:
 *
 *   - Plot → ``<TimeSeriesPlot /> + <ScrubControl /> + <VariableTreePicker />``
 *     (same composition that lived in App.tsx's PlotPanelContent
 *     before Unit 1 deleted it).
 *   - EIG  → ``<AnalyzeEigSubMode />``  (the existing one, exported
 *     for re-use in v3 Unit 14).
 *   - CPF  → ``<AnalyzeCpfSubMode />``
 *   - SE   → ``<AnalyzeSeSubMode />``
 *   - TDS  → ``<TdsConfigPanel />`` + ``<RunStatusBadge />`` (per
 *     F-FEAS-3: "TDS sub-tab hosts the TdsConfigPanel + status badge").
 *
 * Sub-tab visual treatment per F-DESIGN-4: ``text-xs`` + a
 * ``bg-muted/30`` background so this strip reads as nested under the
 * outer drawer tab strip (which uses ``text-sm`` per Unit 11).
 *
 * Sub-tab change wires both layout state AND analyze sub-mode per the
 * F-FEAS-2 dual-write resolution. The owner (BottomDrawer) passes the
 * ``onSubTabChange`` callback that performs the dual write.
 */
import { useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';
import { ANALYSIS_SUB_TABS, type AnalysisSubTab } from '@/store/layout';
import {
  AnalyzeEigSubMode,
  AnalyzeCpfSubMode,
  AnalyzeSeSubMode,
} from '@/components/analyze/AnalyzePanel';
import { TimeSeriesPlot } from '@/components/plots/TimeSeriesPlot';
import { ScrubControl } from '@/components/plots/ScrubControl';
import { VariableTreePicker } from '@/components/plots/VariableTreePicker';
import { TdsConfigPanel } from '@/components/tds/TdsConfigPanel';
import { RunStatusBadge } from '@/components/tds/RunStatusBadge';

const SUB_TAB_LABELS: Record<AnalysisSubTab, string> = {
  plot: 'Plot',
  eig: 'EIG',
  cpf: 'CPF',
  se: 'SE',
  tds: 'TDS',
};

export interface AnalysisTabProps {
  activeSubTab: AnalysisSubTab;
  onSubTabChange: (next: AnalysisSubTab) => void;
  className?: string;
}

export function AnalysisTab({ activeSubTab, onSubTabChange, className }: AnalysisTabProps) {
  return (
    <TabsPrimitive.Root
      value={activeSubTab}
      onValueChange={(next) => onSubTabChange(next as AnalysisSubTab)}
      data-testid="analysis-tab"
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      <TabsPrimitive.List
        aria-label="Analysis sub-tabs"
        className={cn(
          // Deeper recess (bg-muted instead of bg-muted/30) + left
          // padding so the inner strip visually nests under the outer
          // Analysis tab pill rather than reading as a peer strip.
          'border-border bg-muted/70 flex h-7 shrink-0 items-stretch border-b pl-2',
          'overflow-x-auto',
        )}
      >
        {ANALYSIS_SUB_TABS.map((sub) => (
          <TabsPrimitive.Trigger
            key={sub}
            value={sub}
            data-testid={`analysis-sub-tab-${sub}`}
            className={cn(
              // Sub-tabs are pill-shaped (rounded-t) without right
              // borders — visually softer than the outer tab strip so
              // the nesting reads on a single glance.
              'relative inline-flex items-center px-3 text-xs font-medium whitespace-nowrap',
              'text-muted-foreground hover:text-foreground',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              'data-[state=active]:bg-background data-[state=active]:text-foreground',
              'data-[state=active]:shadow-[inset_0_2px_0_0_var(--color-primary)]',
              'rounded-t-[var(--radius-sm)]',
              'transition-colors duration-[var(--duration-fast)]',
            )}
          >
            {SUB_TAB_LABELS[sub]}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <TabsPrimitive.Content
          value="plot"
          data-testid="analysis-sub-tab-content-plot"
          className="flex min-h-0 flex-1 flex-col"
        >
          <PlotPanelContent />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content
          value="eig"
          data-testid="analysis-sub-tab-content-eig"
          className="flex min-h-0 flex-1 flex-col"
        >
          <AnalyzeEigSubMode />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content
          value="cpf"
          data-testid="analysis-sub-tab-content-cpf"
          className="flex min-h-0 flex-1 flex-col"
        >
          <AnalyzeCpfSubMode />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content
          value="se"
          data-testid="analysis-sub-tab-content-se"
          className="flex min-h-0 flex-1 flex-col"
        >
          <AnalyzeSeSubMode />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content
          value="tds"
          data-testid="analysis-sub-tab-content-tds"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <RunStatusBadge />
            <TdsConfigPanel />
          </div>
        </TabsPrimitive.Content>
      </div>
    </TabsPrimitive.Root>
  );
}

/**
 * PlotPanelContent — composition extracted from App.tsx (pre-v3 Unit 1).
 * Stacks the uPlot canvas + scrub control + variable picker.
 *
 * The variable tree is COLLAPSIBLE and collapsed by default. In a short
 * container (the bottom drawer is ~35% of the window) an always-open
 * picker ate the height and squeezed the chart down to a sliver; since
 * bus voltages auto-select, the plot is useful immediately and the
 * picker only needs opening to change the selection. Collapsed, the
 * chart gets the full height; expanded, it scrolls within a capped box.
 */
function PlotPanelContent() {
  const [showVars, setShowVars] = useState(false);
  return (
    <div data-testid="plot-panel-content" className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="min-h-[140px] flex-1">
        <TimeSeriesPlot />
      </div>
      <ScrubControl />
      <div className="border-border shrink-0 rounded border">
        <button
          type="button"
          onClick={() => setShowVars((v) => !v)}
          data-testid="plot-variables-toggle"
          aria-expanded={showVars}
          className={cn(
            'text-muted-foreground hover:text-foreground flex w-full items-center justify-between',
            'px-2.5 py-1.5 text-xs font-medium',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          <span>Variables</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn('transition-transform', showVars ? 'rotate-180' : '')}
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
        {/* Keep the picker MOUNTED even while collapsed (just hidden) so its
            auto-select-bus-voltages effect still runs and the chart isn't
            empty on first view. */}
        <div
          className={cn('border-border max-h-44 overflow-auto border-t', showVars ? '' : 'hidden')}
        >
          <VariableTreePicker />
        </div>
      </div>
    </div>
  );
}
