/**
 * ResultsView (v3.1).
 *
 * The dedicated full-space results page mounted by ``<AppShell />`` when
 * ``useLayoutStore.resultsViewActive`` is true. Per the user request —
 * "results should be presented in a new page, hide the system and its
 * parameters" — this surface hides the SLD diagram + inspector entirely
 * (the AppShell short-circuits the chassis) so plots/tables get the whole
 * content area.
 *
 * It reuses the existing ``<AnalysisTab />`` (the Plot | EIG | CPF | SE |
 * TDS sub-tab strip + charts) verbatim, driven by ``activeAnalysisSubTab``
 * from the layout store and the same dual-write ``onSubTabChange`` callback
 * the BottomDrawer passes — so a Run that auto-routes to a sub-tab lands on
 * the same content whether the user views it in the drawer or here.
 *
 * A header bar shows the context label + an "Exit results view" button that
 * calls ``setResultsViewActive(false)`` to return to the diagram. When no
 * run/analysis result exists yet, the body renders an EmptyState instead of
 * an empty chart so the page doesn't read as broken.
 */
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ChartLineIcon, EmptyState } from '@/components/ui/EmptyState';
import { AnalysisTab } from '@/components/data-grid/AnalysisTab';
import { useLayoutStore } from '@/store/layout';
import { useAnalyzeStore } from '@/store/analyze';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';

export interface ResultsViewProps {
  className?: string;
}

export function ResultsView({ className }: ResultsViewProps) {
  const activeAnalysisSubTab = useLayoutStore((s) => s.activeAnalysisSubTab);
  const setActiveAnalysisSubTab = useLayoutStore((s) => s.setActiveAnalysisSubTab);
  const setResultsViewActive = useLayoutStore((s) => s.setResultsViewActive);
  const setAnalyzeSubMode = useAnalyzeStore((s) => s.setSubMode);

  // "Has any results to show" gate. We surface the AnalysisTab whenever
  // ANY routine has produced output: a PF result, a TDS run, or an
  // EIG/CPF/SE analyze result. Otherwise the page shows an EmptyState
  // pointing the user at the Run controls. The subscriptions are narrow
  // booleans/counts so unrelated store churn doesn't re-render the view.
  const hasPfResult = usePflowStore((s) => s.lastRun !== null);
  const hasRuns = useRunsStore((s) => Object.keys(s.runs).length > 0);
  const hasEig = useAnalyzeStore((s) => s.eigResult !== null);
  const hasCpf = useAnalyzeStore((s) => s.cpfResult !== null);
  const hasSe = useAnalyzeStore((s) => s.seResult !== null);
  const hasResults = hasPfResult || hasRuns || hasEig || hasCpf || hasSe;

  return (
    <div data-testid="results-view" className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* Header bar — context label + exit affordance. Mirrors the thin
          TopBar visual family (hairline border, muted background). */}
      <div
        data-testid="results-view-header"
        className={cn(
          'border-border bg-muted/30 flex h-9 shrink-0 items-center gap-3 border-b px-3',
        )}
      >
        <span className="text-foreground text-sm font-medium">Results</span>
        <span className="text-muted-foreground text-xs">
          Diagram and parameters are hidden — exit to edit the system.
        </span>
        <span aria-hidden="true" className="min-w-0 flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setResultsViewActive(false)}
          data-testid="results-view-exit"
          aria-label="Exit results view"
          className="gap-1.5 px-2 text-xs"
        >
          <BackArrowGlyph className="h-3.5 w-3.5" />
          <span>Show diagram</span>
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasResults ? (
          <AnalysisTab
            activeSubTab={activeAnalysisSubTab}
            onSubTabChange={(next) => {
              // Dual write — same contract BottomDrawer uses: keep the
              // layout sub-tab + the analyze sub-mode in lockstep so the
              // existing AnalyzeEigSubMode et al. (which read subMode)
              // follow the sub-tab click.
              setActiveAnalysisSubTab(next);
              if (next !== 'plot') {
                setAnalyzeSubMode(next);
              }
            }}
          />
        ) : (
          <EmptyState
            icon={<ChartLineIcon />}
            title="No results yet"
            description="Run an analysis (PF, TDS, EIG, CPF or SE) to see results here."
            emptyStateKey="results-view"
          />
        )}
      </div>
    </div>
  );
}

interface GlyphProps {
  className?: string;
}

/**
 * Inline left-arrow glyph for the exit button — reads as "back to the
 * diagram". Follows the inline-SVG ``aria-hidden`` house style.
 */
function BackArrowGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}
