/**
 * Layout slice (v3 Unit 1).
 *
 * Persists the v3 IDE-style 4-pane chassis layout state to ``localStorage``
 * under the ``tensa:layout-v1`` key. New slice (NOT extended onto
 * ``useUiStore``) per the v3 plan's F-FEAS-1 resolution: ``useUiStore``
 * already binds ``zustand/middleware/persist`` against ``sessionStorage``
 * with a ``partialize`` whitelist scoped to the TDS integrator + tolerance
 * overrides, and ``zustand/middleware/persist`` does not natively support
 * mounting a second backend on the same store.
 *
 * The ``-v1`` suffix on the storage key matches the existing
 * ``tensa:theme-preference`` / ``tensa:first-run-coach-v1``
 * convention from the v2.0 polish work and lets us bump for breaking
 * layout changes without surprising users with bad state. Hydration via
 * ``zustand/middleware/persist`` is forgiving — unknown keys in the
 * persisted payload are ignored, malformed JSON falls back to defaults.
 *
 * Lifecycle:
 *
 * - Persisted across reloads (localStorage, not sessionStorage — v3
 *   layout choices are per-user, not per-tab).
 * - All non-action fields are persisted (collapse states, sizes, active
 *   tabs, unread badge bit).
 * - Actions are intentionally not in the persisted payload (zustand
 *   strips functions on serialize anyway, but the partialize whitelist
 *   below makes the intent explicit).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { JobKind } from '@/store/jobs';

/**
 * Outer tab strip identifier for the BottomDrawer (Unit 11). The first
 * five tabs are per-bucket data grids (Units 12 + 13), ``machines``,
 * ``exciters`` and ``governors`` are the tables of the dynamic models, and
 * ``violations`` lists the limits a power flow breaks; ``analysis`` opens the
 * nested sub-tab strip (Unit 14); ``messages`` lists what ANDES said while a
 * command ran.
 */
export type BottomDrawerTab =
  | 'buses'
  | 'lines'
  | 'generators'
  | 'loads'
  | 'shunts'
  | 'machines'
  | 'exciters'
  | 'governors'
  | 'violations'
  | 'analysis'
  | 'activity'
  | 'messages';

export const BOTTOM_DRAWER_TABS: readonly BottomDrawerTab[] = [
  'buses',
  'lines',
  'generators',
  'loads',
  'shunts',
  'machines',
  'exciters',
  'governors',
  'violations',
  'analysis',
  'activity',
  'messages',
] as const;

/**
 * Inner sub-tab identifier for the Analysis tab inside the BottomDrawer.
 * ``pf`` holds the power-flow options and the system summary of the last run,
 * and ``compare`` the difference between two of the power flows kept.
 * The ``pflow`` sub-mode that exists on ``useAnalyzeStore.subMode`` stays
 * retired: ``pf`` is a layout tab only, and PF results are still read off the
 * always-available Buses grid + Inspector accordion as well.
 */
export type AnalysisSubTab = 'plot' | 'pf' | 'compare' | 'eig' | 'cpf' | 'se' | 'tds';

export const ANALYSIS_SUB_TABS: readonly AnalysisSubTab[] = [
  'plot',
  'pf',
  'compare',
  'eig',
  'cpf',
  'se',
  'tds',
] as const;

/**
 * The sub-tabs that have an Analyze sub-mode of the same name, which the
 * layout sub-tab and `useAnalyzeStore.subMode` are written in step for.
 * `plot`, `pf` and `compare` read from the runs, pflow and pflow-history
 * slices instead.
 */
export function isAnalyzeBackedSubTab(sub: AnalysisSubTab): sub is 'eig' | 'cpf' | 'se' | 'tds' {
  return sub !== 'plot' && sub !== 'pf' && sub !== 'compare';
}

/**
 * Tab of the left sidebar. ``project`` holds the open case, its disturbances,
 * the saved cases (the recent ones first) and the snapshots; ``components``
 * holds the palette of what can be added to a system.
 */
export type LeftSidebarTab = 'project' | 'components';

export const LEFT_SIDEBAR_TABS: readonly LeftSidebarTab[] = ['project', 'components'] as const;

/** Whether `value` names a tab of the left sidebar: what the browser kept may not. */
export function isLeftSidebarTab(value: unknown): value is LeftSidebarTab {
  return (LEFT_SIDEBAR_TABS as readonly unknown[]).includes(value);
}

/**
 * Active tab in the Activity panel (Unit 11). ``active`` shows in-flight +
 * pending jobs; ``history`` shows the terminal (done/failed/cancelled)
 * rolling log, in a tab that reads "Finished" (the id is kept for the stored
 * layout). Display-state — safe to persist (the actual JobRecord data
 * lives in the in-memory ``useJobsStore``, never persisted).
 */
export type ActivityPanelTab = 'active' | 'history';

export const ACTIVITY_PANEL_TABS: readonly ActivityPanelTab[] = ['active', 'history'] as const;

/**
 * HistoryDrawer kind-filter selection (Unit 12). ``runs`` is the default —
 * the historical TDS-runs-only view, sourced from ``useRunsStore`` so the
 * scrub/overlay affordances stay intact. ``all`` surfaces every job kind in
 * one chronological list (sourced from ``useJobsStore``; deliberately
 * overlaps the Activity panel). Any other value is a concrete ``JobKind``
 * (e.g. ``pflow``) that filters the All-style job list down to that kind.
 *
 * Display-state only — safe to persist (the JobRecord data it filters lives
 * in the in-memory ``useJobsStore`` and is NEVER persisted; security F2).
 */
export type HistoryKindFilter = 'runs' | 'all' | JobKind;

export interface LayoutState {
  /** Left sidebar collapse state (driven by Unit 2 toggle + ⌘B). */
  leftSidebarCollapsed: boolean;
  setLeftSidebarCollapsed: (collapsed: boolean) => void;
  toggleLeftSidebar: () => void;

  /**
   * The tab the left sidebar shows. A preference of the user, kept across
   * reloads: someone building a system leaves it on Components, someone
   * running studies on Project.
   */
  leftSidebarTab: LeftSidebarTab;
  setLeftSidebarTab: (tab: LeftSidebarTab) => void;
  /** Show `tab`, opening the sidebar when it is collapsed: for what sends the user there. */
  showLeftSidebarTab: (tab: LeftSidebarTab) => void;

  /** Bottom drawer collapse state (driven by Unit 2 toggle + ⌘J). */
  bottomDrawerCollapsed: boolean;
  setBottomDrawerCollapsed: (collapsed: boolean) => void;
  toggleBottomDrawer: () => void;

  /**
   * Bottom drawer expanded height as % of the right-side vertical
   * PanelGroup. Persisted so a user who drags it to 50% sees 50% on
   * reload. Updated on PanelGroup ``onLayout`` (debounce handled by the
   * persist middleware's natural batching).
   */
  bottomDrawerHeightPct: number;
  setBottomDrawerHeightPct: (pct: number) => void;

  /**
   * Right inspector collapse state (driven by Unit 2 toggle + ⌘\).
   * Per the F-DESIGN-2 resolution: collapsed by default; the user can
   * manually open the panel via the toggle even with no element
   * selected (in which case the panel renders an EmptyState).
   */
  rightInspectorCollapsed: boolean;
  setRightInspectorCollapsed: (collapsed: boolean) => void;
  toggleRightInspector: () => void;

  /** Right inspector expanded width in CSS pixels. Default 320. */
  rightInspectorWidthPx: number;
  setRightInspectorWidthPx: (px: number) => void;

  /** Active outer tab in the BottomDrawer tab strip. */
  activeBottomDrawerTab: BottomDrawerTab;
  setActiveBottomDrawerTab: (tab: BottomDrawerTab) => void;

  /** Active inner sub-tab in the Analysis section. */
  activeAnalysisSubTab: AnalysisSubTab;
  setActiveAnalysisSubTab: (sub: AnalysisSubTab) => void;

  /**
   * Unread-results badge bit. Per the F-DESIGN-5 resolution: when a Run
   * fires while the drawer is collapsed, the auto-route writes the
   * routine into ``activeAnalysisSubTab`` but does NOT auto-expand the
   * drawer; instead this bit flips to true so the TopBar drawer toggle
   * (Unit 2) can badge an unread dot. Cleared when the user opens the
   * drawer or starts a new run on the already-active sub-tab.
   */
  drawerHasUnreadResults: boolean;
  setDrawerHasUnreadResults: (has: boolean) => void;
  clearDrawerUnread: () => void;

  /**
   * Active tab in the Activity panel (Unit 11). Display-state only — the
   * underlying JobRecord data is in-memory (security F2); this is just which
   * tab the user last looked at, safe to persist.
   */
  activityPanelTab: ActivityPanelTab;
  setActivityPanelTab: (tab: ActivityPanelTab) => void;

  /** Activity panel collapse state. Persisted (display-state). */
  activityPanelCollapsed: boolean;
  setActivityPanelCollapsed: (collapsed: boolean) => void;
  toggleActivityPanel: () => void;

  /**
   * The job id the user has selected in the Activity panel (drives the
   * per-job detail surface). Persisted as a display preference; the
   * referenced JobRecord itself is NOT persisted (security F2) — on reload
   * a stale id simply resolves to "no job" until a matching record exists.
   */
  selectedJobId: string | null;
  setSelectedJobId: (id: string | null) => void;

  /**
   * HistoryDrawer kind-filter selection (Unit 12). Defaults to ``runs``
   * (the historical TDS-runs-only view). Persisted as a display preference;
   * the JobRecord data it filters is in-memory only (security F2).
   */
  historyKindFilter: HistoryKindFilter;
  setHistoryKindFilter: (filter: HistoryKindFilter) => void;

  /**
   * Full-space results view (v3.1). When ``true`` the AppShell
   * short-circuits the SLD diagram + inspector + drawer chassis and
   * renders the dedicated ResultsView instead, so plots/tables get the
   * full content area ("results should be presented in a new page, hide
   * the system and its parameters"). Independent of
   * ``bottomDrawerCollapsed`` — entering results view does not touch the
   * drawer's own collapse bit, so exiting restores whatever drawer state
   * the user left behind. Display-state — safe to persist.
   */
  resultsViewActive: boolean;
  setResultsViewActive: (active: boolean) => void;
  toggleResultsView: () => void;

  /**
   * Snap to grid on the diagram. When ``true`` a bus or device that is
   * dragged, or moved by the arrow keys, lands on the grid the background
   * dots mark, and so does one moved by Align or Distribute. A preference of
   * the user, not of a case, so it is kept here and not in a case's layout.
   */
  sldSnapToGrid: boolean;
  setSldSnapToGrid: (snap: boolean) => void;
  toggleSldSnapToGrid: () => void;

  /**
   * Whether the app has lowered the bottom drawer to its tabs for a diagram
   * that opened too small to read. It does that once in a browser, and says
   * so: after that the drawer is as the user leaves it, so someone who wants
   * the tables open over a small diagram is not overruled at every reload.
   */
  drawerLoweredForDiagram: boolean;
  setDrawerLoweredForDiagram: (lowered: boolean) => void;
}

/**
 * Default values applied on first mount AND when localStorage holds a
 * malformed payload. ``rightInspectorCollapsed`` defaults to ``false``
 * (the inspector renders an EmptyState until a selection lands) per the
 * v3 plan's "Hidden + TopBar toggle" resolution; we surface the panel by
 * default so a first-time user who hasn't read the cheatsheet sees that
 * an inspector exists.
 */
export const DEFAULT_LAYOUT: Pick<
  LayoutState,
  | 'leftSidebarCollapsed'
  | 'leftSidebarTab'
  | 'bottomDrawerCollapsed'
  | 'bottomDrawerHeightPct'
  | 'rightInspectorCollapsed'
  | 'rightInspectorWidthPx'
  | 'activeBottomDrawerTab'
  | 'activeAnalysisSubTab'
  | 'drawerHasUnreadResults'
  | 'activityPanelTab'
  | 'activityPanelCollapsed'
  | 'selectedJobId'
  | 'historyKindFilter'
  | 'resultsViewActive'
  | 'sldSnapToGrid'
  | 'drawerLoweredForDiagram'
> = {
  leftSidebarCollapsed: false,
  // Project first: a first-time user opens a case before adding to one.
  leftSidebarTab: 'project',
  bottomDrawerCollapsed: false,
  bottomDrawerHeightPct: 35,
  rightInspectorCollapsed: false,
  rightInspectorWidthPx: 320,
  activeBottomDrawerTab: 'buses',
  // Default to the Plot sub-tab: after a TDS run (the most common reason a
  // user opens Results), the time-series plots are what they came for —
  // landing on an empty EIG pane reads as "no results".
  activeAnalysisSubTab: 'plot',
  drawerHasUnreadResults: false,
  activityPanelTab: 'active',
  activityPanelCollapsed: true,
  selectedJobId: null,
  historyKindFilter: 'runs',
  resultsViewActive: false,
  sldSnapToGrid: false,
  drawerLoweredForDiagram: false,
};

export const LAYOUT_STORAGE_KEY = 'tensa:layout-v1';

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      ...DEFAULT_LAYOUT,

      setLeftSidebarCollapsed: (collapsed) => set({ leftSidebarCollapsed: collapsed }),
      toggleLeftSidebar: () =>
        set((state) => ({ leftSidebarCollapsed: !state.leftSidebarCollapsed })),

      setLeftSidebarTab: (tab) => set({ leftSidebarTab: tab }),
      showLeftSidebarTab: (tab) => set({ leftSidebarTab: tab, leftSidebarCollapsed: false }),

      setBottomDrawerCollapsed: (collapsed) => set({ bottomDrawerCollapsed: collapsed }),
      toggleBottomDrawer: () =>
        set((state) => ({ bottomDrawerCollapsed: !state.bottomDrawerCollapsed })),

      setBottomDrawerHeightPct: (pct) => set({ bottomDrawerHeightPct: pct }),

      setRightInspectorCollapsed: (collapsed) => set({ rightInspectorCollapsed: collapsed }),
      toggleRightInspector: () =>
        set((state) => ({ rightInspectorCollapsed: !state.rightInspectorCollapsed })),

      setRightInspectorWidthPx: (px) => set({ rightInspectorWidthPx: px }),

      setActiveBottomDrawerTab: (tab) => set({ activeBottomDrawerTab: tab }),
      setActiveAnalysisSubTab: (sub) => set({ activeAnalysisSubTab: sub }),

      setDrawerHasUnreadResults: (has) => set({ drawerHasUnreadResults: has }),
      clearDrawerUnread: () => set({ drawerHasUnreadResults: false }),

      setActivityPanelTab: (tab) => set({ activityPanelTab: tab }),
      setActivityPanelCollapsed: (collapsed) => set({ activityPanelCollapsed: collapsed }),
      toggleActivityPanel: () =>
        set((state) => ({ activityPanelCollapsed: !state.activityPanelCollapsed })),

      setSelectedJobId: (id) => set({ selectedJobId: id }),

      setHistoryKindFilter: (filter) => set({ historyKindFilter: filter }),

      setResultsViewActive: (active) => set({ resultsViewActive: active }),
      toggleResultsView: () => set((state) => ({ resultsViewActive: !state.resultsViewActive })),

      setSldSnapToGrid: (snap) => set({ sldSnapToGrid: snap }),
      toggleSldSnapToGrid: () => set((state) => ({ sldSnapToGrid: !state.sldSnapToGrid })),

      setDrawerLoweredForDiagram: (lowered) => set({ drawerLoweredForDiagram: lowered }),
    }),
    {
      name: LAYOUT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Whitelist every persisted field. Functions are stripped by JSON
      // serialization anyway; the explicit list documents the contract
      // and protects against accidental persistence of fields added in
      // later units (e.g., a transient "drawer-is-currently-resizing"
      // bit that should not survive a reload).
      partialize: (state) => ({
        leftSidebarCollapsed: state.leftSidebarCollapsed,
        leftSidebarTab: state.leftSidebarTab,
        bottomDrawerCollapsed: state.bottomDrawerCollapsed,
        bottomDrawerHeightPct: state.bottomDrawerHeightPct,
        rightInspectorCollapsed: state.rightInspectorCollapsed,
        rightInspectorWidthPx: state.rightInspectorWidthPx,
        activeBottomDrawerTab: state.activeBottomDrawerTab,
        activeAnalysisSubTab: state.activeAnalysisSubTab,
        drawerHasUnreadResults: state.drawerHasUnreadResults,
        // Activity-panel display-state (Unit 6). These ARE display state —
        // safe to persist. The JobRecord data they reference lives in the
        // in-memory ``useJobsStore`` and is NEVER persisted (security F2).
        activityPanelTab: state.activityPanelTab,
        activityPanelCollapsed: state.activityPanelCollapsed,
        selectedJobId: state.selectedJobId,
        // HistoryDrawer kind-filter (Unit 12). Display-state — the filtered
        // JobRecord data lives in the in-memory ``useJobsStore`` and is
        // NEVER persisted (security F2).
        historyKindFilter: state.historyKindFilter,
        // Full-space results view (v3.1). Pure display-state — which
        // surface the user last looked at. The results data it shows lives
        // in the in-memory run/analyze slices and is never persisted.
        resultsViewActive: state.resultsViewActive,
        // Snap to grid on the diagram: how the user likes to place things.
        sldSnapToGrid: state.sldSnapToGrid,
        // That the drawer was lowered once for a small diagram: not again.
        drawerLoweredForDiagram: state.drawerLoweredForDiagram,
      }),
    },
  ),
);
