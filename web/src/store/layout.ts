/**
 * Layout slice (v3 Unit 1).
 *
 * Persists the v3 IDE-style 4-pane chassis layout state to ``localStorage``
 * under the ``andes-app:layout-v1`` key. New slice (NOT extended onto
 * ``useUiStore``) per the v3 plan's F-FEAS-1 resolution: ``useUiStore``
 * already binds ``zustand/middleware/persist`` against ``sessionStorage``
 * with a ``partialize`` whitelist scoped to the TDS integrator + tolerance
 * overrides, and ``zustand/middleware/persist`` does not natively support
 * mounting a second backend on the same store.
 *
 * The ``-v1`` suffix on the storage key matches the existing
 * ``andes-app:theme-preference`` / ``andes-app:first-run-coach-v1``
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

/**
 * Outer tab strip identifier for the BottomDrawer (Unit 11). The first
 * five tabs are per-bucket data grids (Units 12 + 13); ``analysis`` opens
 * the nested sub-tab strip (Unit 14).
 */
export type BottomDrawerTab = 'buses' | 'lines' | 'generators' | 'loads' | 'shunts' | 'analysis';

export const BOTTOM_DRAWER_TABS: readonly BottomDrawerTab[] = [
  'buses',
  'lines',
  'generators',
  'loads',
  'shunts',
  'analysis',
] as const;

/**
 * Inner sub-tab identifier for the Analysis tab inside the BottomDrawer.
 * Per the F-FEAS-3 resolution, the ``pflow`` sub-mode that exists on
 * ``useAnalyzeStore.subMode`` is retired in v3 (PF results are read off
 * the always-available Buses grid + Inspector accordion instead).
 */
export type AnalysisSubTab = 'plot' | 'eig' | 'cpf' | 'se' | 'tds';

export const ANALYSIS_SUB_TABS: readonly AnalysisSubTab[] = [
  'plot',
  'eig',
  'cpf',
  'se',
  'tds',
] as const;

export interface LayoutState {
  /** Left sidebar collapse state (driven by Unit 2 toggle + ⌘B). */
  leftSidebarCollapsed: boolean;
  setLeftSidebarCollapsed: (collapsed: boolean) => void;
  toggleLeftSidebar: () => void;

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
  | 'bottomDrawerCollapsed'
  | 'bottomDrawerHeightPct'
  | 'rightInspectorCollapsed'
  | 'rightInspectorWidthPx'
  | 'activeBottomDrawerTab'
  | 'activeAnalysisSubTab'
  | 'drawerHasUnreadResults'
> = {
  leftSidebarCollapsed: false,
  bottomDrawerCollapsed: false,
  bottomDrawerHeightPct: 35,
  rightInspectorCollapsed: false,
  rightInspectorWidthPx: 320,
  activeBottomDrawerTab: 'buses',
  activeAnalysisSubTab: 'eig',
  drawerHasUnreadResults: false,
};

export const LAYOUT_STORAGE_KEY = 'andes-app:layout-v1';

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      ...DEFAULT_LAYOUT,

      setLeftSidebarCollapsed: (collapsed) => set({ leftSidebarCollapsed: collapsed }),
      toggleLeftSidebar: () =>
        set((state) => ({ leftSidebarCollapsed: !state.leftSidebarCollapsed })),

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
        bottomDrawerCollapsed: state.bottomDrawerCollapsed,
        bottomDrawerHeightPct: state.bottomDrawerHeightPct,
        rightInspectorCollapsed: state.rightInspectorCollapsed,
        rightInspectorWidthPx: state.rightInspectorWidthPx,
        activeBottomDrawerTab: state.activeBottomDrawerTab,
        activeAnalysisSubTab: state.activeAnalysisSubTab,
        drawerHasUnreadResults: state.drawerHasUnreadResults,
      }),
    },
  ),
);
