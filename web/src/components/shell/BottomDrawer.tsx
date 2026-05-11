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
import { useEffect } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';
import {
  BOTTOM_DRAWER_TABS,
  useLayoutStore,
  type BottomDrawerTab,
} from '@/store/layout';
import { useAnalyzeStore } from '@/store/analyze';
import { BusesGrid } from '@/components/data-grid/BusesGrid';
import { LinesGrid } from '@/components/data-grid/LinesGrid';
import { GeneratorsGrid } from '@/components/data-grid/GeneratorsGrid';
import { LoadsGrid } from '@/components/data-grid/LoadsGrid';
import { ShuntsGrid } from '@/components/data-grid/ShuntsGrid';
import { AnalysisTab } from '@/components/data-grid/AnalysisTab';

const TAB_LABELS: Record<BottomDrawerTab, string> = {
  buses: 'Buses',
  lines: 'Lines',
  generators: 'Generators',
  loads: 'Loads',
  shunts: 'Shunts',
  analysis: 'Analysis',
};

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
    // Map layout sub-tab → analyze sub-mode. The 'plot' tab has no
    // analyze sub-mode equivalent (plotting reads from useRunsStore,
    // not the analyze slice) so we leave subMode alone in that case;
    // mounting <PlotPanelContent /> doesn't read subMode anyway.
    if (activeAnalysisSubTab === 'plot') return;
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
          <TabsPrimitive.Trigger
            key={tab}
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
          </TabsPrimitive.Trigger>
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
            <BusesGrid />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="lines"
            data-testid="bottom-drawer-tab-content-lines"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LinesGrid />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="generators"
            data-testid="bottom-drawer-tab-content-generators"
            className="flex min-h-0 flex-1 flex-col"
          >
            <GeneratorsGrid />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="loads"
            data-testid="bottom-drawer-tab-content-loads"
            className="flex min-h-0 flex-1 flex-col"
          >
            <LoadsGrid />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="shunts"
            data-testid="bottom-drawer-tab-content-shunts"
            className="flex min-h-0 flex-1 flex-col"
          >
            <ShuntsGrid />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="analysis"
            data-testid="bottom-drawer-tab-content-analysis"
            className="flex min-h-0 flex-1 flex-col"
          >
            <AnalysisTab
              activeSubTab={activeAnalysisSubTab}
              onSubTabChange={(next) => {
                setActiveAnalysisSubTab(next);
                if (next !== 'plot') {
                  setAnalyzeSubMode(next);
                }
              }}
            />
          </TabsPrimitive.Content>
        </div>
      )}
    </TabsPrimitive.Root>
  );
}
