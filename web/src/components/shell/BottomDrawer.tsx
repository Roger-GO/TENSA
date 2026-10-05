/**
 * BottomDrawer (v3 Unit 11).
 *
 * Outer chassis for the bottom-of-screen tab strip + per-bucket data
 * grids (Units 12 + 13) and the Analysis sub-tab strip (Unit 14).
 *
 * Tab strip uses ``@radix-ui/react-tabs`` directly (NOT the
 * ``@/components/ui/tabs`` wrappers — those default to a recessed
 * pill-shaped TabsList that's wrong for a full-bleed drawer top).
 * The strip is full-bleed at the top of the drawer (per F-DESIGN-4
 * resolution: outer strip uses ``text-sm`` medium-weight, full-bleed;
 * inner Analysis sub-tab strip uses ``text-xs`` with a ``bg-muted/30``
 * background recess so it visually reads as nested).
 *
 * Collapsed-state rendering: per the v3 plan + the AppShell spike (b)
 * finding, when ``bottomDrawerCollapsed === true`` the panel is at
 * size=0..4 and we render only the 32px tab strip. Clicking any tab in
 * the collapsed state both expands the drawer AND switches to that
 * tab; the ``setActiveBottomDrawerTab`` setter handles the tab switch
 * and ``setBottomDrawerCollapsed(false)`` handles the expand.
 *
 * Unread-results bit: per F-DESIGN-5, opening the drawer or switching
 * tabs clears ``drawerHasUnreadResults`` (mirrors the click path on the
 * BottomDrawerToggle button + the ⌘J command).
 */
import { Fragment, useEffect } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';
import {
  BOTTOM_DRAWER_TABS,
  isAnalyzeBackedSubTab,
  useLayoutStore,
  type BottomDrawerTab,
} from '@/store/layout';
import { useAnalyzeStore } from '@/store/analyze';
import { LazyGrid } from '@/components/data-grid/LazyGrid';
import { usePflowStore } from '@/store/pflow';
import { useViolationReport } from '@/lib/useViolationReport';
import { LazyAnalysisTab } from '@/components/data-grid/LazyAnalysisTab';
import { ActivityPanel } from '@/components/shell/ActivityPanel';

const TAB_LABELS: Record<BottomDrawerTab, string> = {
  buses: 'Buses',
  lines: 'Lines',
  generators: 'Generators',
  loads: 'Loads',
  shunts: 'Shunts',
  machines: 'Machines',
  exciters: 'Exciters',
  governors: 'Governors',
  violations: 'Violations',
  analysis: 'Analysis',
  activity: 'Activity',
};

/**
 * The count of limit violations beside the Violations tab's name, red when a
 * limit is broken and amber when there are only warnings, so a result that
 * needs attention shows without opening the tab. Draws nothing until a power
 * flow has converged, and when every limit holds. The count is its own
 * component so the tab strip reads the topology only once there is a result.
 */
function ViolationsCount() {
  const converged = usePflowStore((s) => s.lastRun?.converged === true);
  return converged ? <ViolationsCountBadge /> : null;
}

function ViolationsCountBadge() {
  const report = useViolationReport();
  if (report === null || report.items.length === 0) return null;
  const violations = report.violationCount > 0;
  const count = violations ? report.violationCount : report.warningCount;
  const word = violations ? 'violation' : 'warning';
  return (
    <span
      data-testid="violations-tab-count"
      data-severity={violations ? 'violation' : 'warning'}
      title={`${count} ${word}${count === 1 ? '' : 's'}`}
      className={cn(
        'ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full px-1',
        'text-[10px] leading-4 font-semibold',
        violations ? 'bg-danger text-danger-foreground' : 'bg-warning text-warning-foreground',
      )}
    >
      {count}
    </span>
  );
}

export interface BottomDrawerProps {
  className?: string;
}

export function BottomDrawer({ className }: BottomDrawerProps) {
  const collapsed = useLayoutStore((s) => s.bottomDrawerCollapsed);
  const activeTab = useLayoutStore((s) => s.activeBottomDrawerTab);
  const setActiveTab = useLayoutStore((s) => s.setActiveBottomDrawerTab);
  const setCollapsed = useLayoutStore((s) => s.setBottomDrawerCollapsed);
  const clearDrawerUnread = useLayoutStore((s) => s.clearDrawerUnread);
  const activeAnalysisSubTab = useLayoutStore((s) => s.activeAnalysisSubTab);
  const setActiveAnalysisSubTab = useLayoutStore((s) => s.setActiveAnalysisSubTab);

  // Per F-FEAS-2 resolution: useAnalyzeStore.subMode is the source of
  // truth for sub-mode rendering. activeAnalysisSubTab is a parallel
  // layout-only field. We sync layout → analyze (one direction) so
  // that when an auto-route writes activeAnalysisSubTab the existing
  // AnalyzeEigSubMode et al. (which read subMode) follow. The reverse
  // direction (sub-tab click) is handled in AnalysisTab itself which
  // writes BOTH stores atomically. That avoids the infinite-loop trap
  // of bidirectional effects.
  const subMode = useAnalyzeStore((s) => s.subMode);
  const setAnalyzeSubMode = useAnalyzeStore((s) => s.setSubMode);
  useEffect(() => {
    // Map layout sub-tab → analyze sub-mode. The 'plot' and 'pf' tabs have
    // no analyze sub-mode equivalent (plotting reads from useRunsStore and
    // the PF tab from the pflow slice, not the analyze slice) so we leave
    // subMode alone in those cases; mounting them doesn't read subMode.
    if (!isAnalyzeBackedSubTab(activeAnalysisSubTab)) return;
    if (activeAnalysisSubTab !== subMode) {
      setAnalyzeSubMode(activeAnalysisSubTab);
    }
  }, [activeAnalysisSubTab, subMode, setAnalyzeSubMode]);

  const onTabChange = (next: string) => {
    const tab = next as BottomDrawerTab;
    setActiveTab(tab);
    // Switching tabs counts as "user looked at the drawer", so clear
    // the unread badge — matches the click path on BottomDrawerToggle.
    clearDrawerUnread();
    // Collapsed → tab click also expands. Per the F-DESIGN-5
    // resolution, manual tab clicks (vs. auto-route on Run) are
    // user-initiated and should expand the drawer.
    if (collapsed) {
      setCollapsed(false);
    }
  };

  return (
    <TabsPrimitive.Root
      value={activeTab}
      onValueChange={onTabChange}
      data-testid="bottom-drawer"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      <TabsPrimitive.List
        aria-label="Bottom drawer tabs"
        className={cn(
          'border-border bg-muted/30 flex h-8 shrink-0 items-stretch border-b',
          'overflow-x-auto',
        )}
      >
        {BOTTOM_DRAWER_TABS.map((tab) => (
          <Fragment key={tab}>
            {/* Group separator: the tabs before it are the per-bucket
                element grids, the dynamic-model tables and the violations
                list; ``analysis`` + ``activity`` are the tools group. A thin spacer + hairline before ``analysis`` makes
                that split read at a glance without a heavier divider. */}
            {tab === 'analysis' ? (
              <span
                aria-hidden="true"
                data-testid="bottom-drawer-tab-group-divider"
                className="bg-border my-1.5 mr-1 ml-1 w-px shrink-0 self-stretch"
              />
            ) : null}
            <TabsPrimitive.Trigger
              value={tab}
              data-testid={`bottom-drawer-tab-${tab}`}
              className={cn(
                'relative inline-flex items-center px-3 text-sm font-medium whitespace-nowrap',
                'text-muted-foreground hover:text-foreground',
                'border-r-border border-r last:border-r-0',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                'data-[state=active]:bg-background data-[state=active]:text-foreground',
                // 2px primary top-rail on the active tab — the IDE pattern
                // that makes the active tab read instantly even from a
                // wide-aspect viewport.
                'data-[state=active]:shadow-[inset_0_2px_0_0_var(--color-primary)]',
                'transition-colors duration-[var(--duration-fast)]',
              )}
            >
              {TAB_LABELS[tab]}
              {tab === 'violations' ? <ViolationsCount /> : null}
            </TabsPrimitive.Trigger>
          </Fragment>
        ))}
      </TabsPrimitive.List>

      {/* When collapsed, render ONLY the strip — the panel is at
          ~4% height (collapsedSize=4 in AppShell). When expanded,
          mount the active tab's content below. */}
      {collapsed ? null : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TabsPrimitive.Content
            value="buses"
            data-testid="bottom-drawer-tab-content-buses"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="buses" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="lines"
            data-testid="bottom-drawer-tab-content-lines"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="lines" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="generators"
            data-testid="bottom-drawer-tab-content-generators"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="generators" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="loads"
            data-testid="bottom-drawer-tab-content-loads"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="loads" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="shunts"
            data-testid="bottom-drawer-tab-content-shunts"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="shunts" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="machines"
            data-testid="bottom-drawer-tab-content-machines"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="machines" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="exciters"
            data-testid="bottom-drawer-tab-content-exciters"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="exciters" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="governors"
            data-testid="bottom-drawer-tab-content-governors"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="governors" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="violations"
            data-testid="bottom-drawer-tab-content-violations"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyGrid tab="violations" />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="analysis"
            data-testid="bottom-drawer-tab-content-analysis"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LazyAnalysisTab
              activeSubTab={activeAnalysisSubTab}
              onSubTabChange={(next) => {
                setActiveAnalysisSubTab(next);
                if (isAnalyzeBackedSubTab(next)) {
                  setAnalyzeSubMode(next);
                }
              }}
            />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="activity"
            data-testid="bottom-drawer-tab-content-activity"
            className="flex min-h-0 flex-1 flex-col"
          >
            <ActivityPanel />
          </TabsPrimitive.Content>
        </div>
      )}
    </TabsPrimitive.Root>
  );
}
