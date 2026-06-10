/**
 * Tests for the layout slice (`web/src/store/layout.ts`) — v3 Unit 1.
 *
 * Coverage:
 *
 *  - Default values match the v3 spec.
 *  - Each action reads/writes through cleanly.
 *  - localStorage round-trip via the persist middleware preserves user
 *    preferences across re-imports.
 *  - Malformed localStorage payload falls back to defaults (the persist
 *    middleware swallows JSON.parse errors and re-initialises).
 *  - Old `useUiStore.activeRightDockTopPanel` keys lingering in storage
 *    do not crash the layout-store hydration (different key namespace).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANALYSIS_SUB_TABS,
  BOTTOM_DRAWER_TABS,
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  useLayoutStore,
} from '@/store/layout';

/**
 * The vitest+jsdom environment in this repo ships a `localStorage` whose
 * methods throw on call (see ``tests/setup.ts`` for the in-memory shim
 * that replaces it at setup time). Each test clears the shim so the
 * persist middleware starts with empty storage.
 */
function clearStorage(): void {
  window.localStorage.clear();
}

/** Reset the in-memory store to defaults between tests. */
function resetLayoutStore(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
}

describe('useLayoutStore — defaults', () => {
  beforeEach(() => {
    clearStorage();
    resetLayoutStore();
  });

  it('exposes the v3 defaults out of the box', () => {
    const state = useLayoutStore.getState();
    expect(state.leftSidebarCollapsed).toBe(false);
    expect(state.bottomDrawerCollapsed).toBe(false);
    expect(state.bottomDrawerHeightPct).toBe(35);
    expect(state.rightInspectorCollapsed).toBe(false);
    expect(state.rightInspectorWidthPx).toBe(320);
    expect(state.activeBottomDrawerTab).toBe('buses');
    expect(state.activeAnalysisSubTab).toBe('plot');
    expect(state.drawerHasUnreadResults).toBe(false);
    expect(state.resultsViewActive).toBe(false);
  });

  it('exposes BOTTOM_DRAWER_TABS as the canonical ordered list', () => {
    expect(BOTTOM_DRAWER_TABS).toEqual([
      'buses',
      'lines',
      'generators',
      'loads',
      'shunts',
      'analysis',
      'activity',
    ]);
  });

  it('exposes ANALYSIS_SUB_TABS as the canonical ordered list', () => {
    expect(ANALYSIS_SUB_TABS).toEqual(['plot', 'eig', 'cpf', 'se', 'tds']);
  });
});

describe('useLayoutStore — actions', () => {
  beforeEach(() => {
    clearStorage();
    resetLayoutStore();
  });

  it('setLeftSidebarCollapsed writes through', () => {
    useLayoutStore.getState().setLeftSidebarCollapsed(true);
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true);
  });

  it('toggleLeftSidebar alternates the flag', () => {
    useLayoutStore.getState().toggleLeftSidebar();
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true);
    useLayoutStore.getState().toggleLeftSidebar();
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);
  });

  it('setBottomDrawerCollapsed writes through', () => {
    useLayoutStore.getState().setBottomDrawerCollapsed(true);
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);
  });

  it('toggleBottomDrawer alternates the flag', () => {
    useLayoutStore.getState().toggleBottomDrawer();
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);
    useLayoutStore.getState().toggleBottomDrawer();
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
  });

  it('setBottomDrawerHeightPct writes through', () => {
    useLayoutStore.getState().setBottomDrawerHeightPct(48);
    expect(useLayoutStore.getState().bottomDrawerHeightPct).toBe(48);
  });

  it('setRightInspectorCollapsed writes through', () => {
    useLayoutStore.getState().setRightInspectorCollapsed(true);
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(true);
  });

  it('toggleRightInspector alternates the flag', () => {
    useLayoutStore.getState().toggleRightInspector();
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(true);
    useLayoutStore.getState().toggleRightInspector();
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(false);
  });

  it('setRightInspectorWidthPx writes through', () => {
    useLayoutStore.getState().setRightInspectorWidthPx(420);
    expect(useLayoutStore.getState().rightInspectorWidthPx).toBe(420);
  });

  it('setActiveBottomDrawerTab swaps the active tab', () => {
    useLayoutStore.getState().setActiveBottomDrawerTab('analysis');
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('analysis');
    useLayoutStore.getState().setActiveBottomDrawerTab('lines');
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('lines');
  });

  it('setActiveAnalysisSubTab swaps the active sub-tab', () => {
    useLayoutStore.getState().setActiveAnalysisSubTab('cpf');
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('cpf');
    useLayoutStore.getState().setActiveAnalysisSubTab('plot');
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('plot');
  });

  it('setDrawerHasUnreadResults writes through', () => {
    useLayoutStore.getState().setDrawerHasUnreadResults(true);
    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(true);
  });

  it('clearDrawerUnread resets the badge bit', () => {
    useLayoutStore.getState().setDrawerHasUnreadResults(true);
    useLayoutStore.getState().clearDrawerUnread();
    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(false);
  });

  it('setResultsViewActive writes through', () => {
    useLayoutStore.getState().setResultsViewActive(true);
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);
    useLayoutStore.getState().setResultsViewActive(false);
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);
  });

  it('toggleResultsView alternates the flag', () => {
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);
    useLayoutStore.getState().toggleResultsView();
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);
    useLayoutStore.getState().toggleResultsView();
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);
  });

  it('toggleResultsView is independent of bottomDrawerCollapsed', () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    useLayoutStore.getState().toggleResultsView();
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);
    // Entering results view must NOT touch the drawer's own collapse bit.
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);
  });
});

describe('useLayoutStore — persistence', () => {
  beforeEach(() => {
    clearStorage();
    resetLayoutStore();
  });

  afterEach(() => {
    clearStorage();
  });

  it('writes through to localStorage on every action', async () => {
    useLayoutStore.getState().setLeftSidebarCollapsed(true);
    useLayoutStore.getState().setBottomDrawerHeightPct(50);
    useLayoutStore.getState().setActiveBottomDrawerTab('analysis');
    // The persist middleware writes synchronously after each set; drain
    // the microtask queue so jsdom's fake `localStorage` shim observes
    // the write before we read.
    await Promise.resolve();
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(parsed.state.leftSidebarCollapsed).toBe(true);
    expect(parsed.state.bottomDrawerHeightPct).toBe(50);
    expect(parsed.state.activeBottomDrawerTab).toBe('analysis');
  });

  it('persists resultsViewActive to localStorage', async () => {
    useLayoutStore.getState().setResultsViewActive(true);
    await Promise.resolve();
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(parsed.state.resultsViewActive).toBe(true);
  });

  it('round-trips resultsViewActive via rehydrate()', async () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        state: { ...DEFAULT_LAYOUT, resultsViewActive: true },
        version: 0,
      }),
    );
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);
  });

  it('round-trips persisted state via rehydrate()', async () => {
    // Seed localStorage with a payload as if from a previous session.
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        state: {
          ...DEFAULT_LAYOUT,
          bottomDrawerCollapsed: true,
          bottomDrawerHeightPct: 50,
          activeBottomDrawerTab: 'generators',
        },
        version: 0,
      }),
    );
    // Persist middleware exposes a rehydrate() that re-reads from the
    // configured storage. This avoids the test having to re-import the
    // module with a fresh module graph.
    await useLayoutStore.persist.rehydrate();
    const state = useLayoutStore.getState();
    expect(state.bottomDrawerCollapsed).toBe(true);
    expect(state.bottomDrawerHeightPct).toBe(50);
    expect(state.activeBottomDrawerTab).toBe('generators');
  });

  it('falls back to defaults when localStorage holds malformed JSON', async () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, '{not valid json');
    // The persist middleware logs but does not throw on bad payloads; it
    // simply leaves the in-memory state at its current values. We reset
    // the store first so the post-rehydrate state IS the defaults.
    resetLayoutStore();
    await useLayoutStore.persist.rehydrate();
    const state = useLayoutStore.getState();
    expect(state.leftSidebarCollapsed).toBe(DEFAULT_LAYOUT.leftSidebarCollapsed);
    expect(state.bottomDrawerHeightPct).toBe(DEFAULT_LAYOUT.bottomDrawerHeightPct);
    expect(state.activeBottomDrawerTab).toBe(DEFAULT_LAYOUT.activeBottomDrawerTab);
  });

  it('ignores stale `useUiStore.activeRightDockTopPanel` payloads (different key)', async () => {
    // The legacy ui slice persists under `andes-ui-tds-integrator` in
    // sessionStorage. A defensive check: if some other code wrote to a
    // wrong key in localStorage, the layout store should not crash on
    // hydrate.
    window.localStorage.setItem(
      'andes-ui-tds-integrator',
      JSON.stringify({ state: { activeRightDockTopPanel: 'analyze' }, version: 0 }),
    );
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('buses');
  });

  it('preserves expand-target height when drawer is persisted as collapsed', async () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        state: {
          ...DEFAULT_LAYOUT,
          bottomDrawerCollapsed: true,
          bottomDrawerHeightPct: 50,
        },
        version: 0,
      }),
    );
    await useLayoutStore.persist.rehydrate();
    const state = useLayoutStore.getState();
    expect(state.bottomDrawerCollapsed).toBe(true);
    // The drawer remembers a 50% expand target even though it boots
    // collapsed — Unit 2's toggle reads this on expand.
    expect(state.bottomDrawerHeightPct).toBe(50);
  });
});
