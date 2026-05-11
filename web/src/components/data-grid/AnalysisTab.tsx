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
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';
import {
  ANALYSIS_SUB_TABS,
  type AnalysisSubTab,
} from '@/store/layout';
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

export function AnalysisTab({
  activeSubTab,
  onSubTabChange,
  className,
}: AnalysisTabProps) {
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
          'border-border bg-muted/30 flex h-7 shrink-0 items-stretch border-b',
          'overflow-x-auto',
        )}
      >
        {ANALYSIS_SUB_TABS.map((sub) => (
          <TabsPrimitive.Trigger
            key={sub}
            value={sub}
            data-testid={`analysis-sub-tab-${sub}`}
            className={cn(
              'inline-flex items-center px-3 text-xs font-medium whitespace-nowrap',
              'text-muted-foreground hover:text-foreground',
              'border-r-border border-r last:border-r-0',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              'data-[state=active]:bg-background data-[state=active]:text-foreground',
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
 * Stacks the uPlot canvas + scrub control + variable picker so the
 * Plot sub-tab mirrors the v0.2 right-dock plot panel layout.
 */
function PlotPanelContent() {
  return (
    <div
      data-testid="plot-panel-content"
      className="flex h-full min-h-0 flex-col gap-2 p-2"
    >
      <div className="min-h-0 flex-1">
        <TimeSeriesPlot />
      </div>
      <ScrubControl />
      <div className="border-border max-h-48 overflow-auto rounded border">
        <VariableTreePicker />
      </div>
    </div>
  );
}
