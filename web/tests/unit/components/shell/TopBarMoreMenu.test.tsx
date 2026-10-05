/**
 * Tests for `<TopBarMoreMenu />`: the "..." menu that holds what the top bar cannot fit
 * on a narrow window. jsdom applies no CSS, so what is checked here is what the menu
 * lists, that each item does what its inline control does, and the classes that make
 * the CSS show it in the right place. `tests/e2e/top-bar-fit.spec.ts` checks the
 * layout in a real browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { TopBarMoreMenu } from '@/components/shell/TopBarMoreMenu';
import {
  MORE_BELOW_MEDIUM,
  MORE_BELOW_NARROW,
  MORE_BELOW_WIDE,
} from '@/components/shell/topBarLayout';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useCaseStore } from '@/store/case';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useHistoryStore } from '@/store/history';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useThemeStore } from '@/store/theme';
import { useUiStore } from '@/store/ui';
import { useUnitsStore } from '@/store/units';

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  const topology: TopologySummary = {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  return { ...actual, useCurrentTopology: () => topology };
});

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

async function openMenu() {
  const user = userEvent.setup();
  render(withProviders(<TopBarMoreMenu />));
  await user.click(screen.getByTestId('topbar-menu-more-trigger'));
  await screen.findByTestId('topbar-menu-more-content');
  return user;
}

beforeEach(() => {
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14_full.xlsx'), addfiles: [] },
  });
  useUiStore.setState({ hideLabels: false });
  useUnitsStore.setState({ mode: 'pu' });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useHistoryStore.getState().closeDrawer();
  useCommandPaletteStore.setState({ open: false, page: 'commands' });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useHistoryStore.getState().closeDrawer();
  useUnitsStore.setState({ mode: 'pu' });
  useUiStore.setState({ hideLabels: false });
});

describe('<TopBarMoreMenu />', () => {
  it('is an icon button named More, and is the one the wide window hides', () => {
    render(withProviders(<TopBarMoreMenu />));
    const trigger = screen.getByTestId('topbar-menu-more-trigger');
    expect(trigger).toHaveAccessibleName('More');
    expect(trigger.className).toContain(MORE_BELOW_WIDE);
  });

  it('lists what the bar hands over, with the keys of the commands', async () => {
    await openMenu();
    const content = screen.getByTestId('topbar-menu-more-content');
    const items = [...content.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
    expect(items).toEqual([
      'Open command palette' + 'Ctrl+K',
      'Open History' + 'G then H',
      'Toggle dark mode' + 'Ctrl+Shift+L',
      'Toggle left sidebar' + 'Ctrl+B',
      'Toggle inspector' + 'Ctrl+\\',
      'Toggle bottom drawer' + 'Ctrl+J',
      'Toggle results view' + 'Ctrl+Shift+M',
      'Hide labels',
      'Actual units',
    ]);
  });

  it('shows the stand-ins for the pane toggles and for Labels and Units only where those are not inline', async () => {
    await openMenu();
    const classOf = (id: string) => screen.getByTestId(`topbar-menu-more-${id}`).className;
    for (const id of [
      'view.toggleLeftSidebar',
      'view.toggleRightInspector',
      'view.toggleBottomDrawer',
      'view.toggle-results-view',
    ]) {
      expect(classOf(id)).toContain(MORE_BELOW_MEDIUM);
    }
    expect(classOf('hide-labels')).toContain(MORE_BELOW_NARROW);
    expect(classOf('actual-units')).toContain(MORE_BELOW_NARROW);
    // Search, History and Theme are in More whenever More is, so no class of their own.
    for (const id of ['help.command-palette', 'navigation.history', 'help.dark-mode']) {
      expect(classOf(id)).not.toMatch(/min-\[/);
    }
  });

  it('Open command palette opens the palette', async () => {
    const user = await openMenu();
    await user.click(screen.getByTestId('topbar-menu-more-help.command-palette'));
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('Open History opens the drawer, as the History button does, and is off with no case', async () => {
    const user = await openMenu();
    await user.click(screen.getByTestId('topbar-menu-more-navigation.history'));
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
    cleanup();
    useHistoryStore.getState().closeDrawer();

    useCaseStore.setState({ selection: null });
    await openMenu();
    expect(screen.getByTestId('topbar-menu-more-navigation.history')).toBeDisabled();
  });

  it('Open History is on with no case when there are runs to list, as after a reload', async () => {
    useCaseStore.setState({ selection: null });
    useRunsStore.getState().startRun({ runId: 'kept', tf: 1, columnNames: ['Bus_1_v'] });
    useRunsStore.getState().markRunDone('kept', 1, true);
    useRunsStore.getState().clearActiveRun();
    try {
      await openMenu();
      expect(screen.getByTestId('topbar-menu-more-navigation.history')).toBeEnabled();
    } finally {
      useRunsStore.getState().clearRuns();
    }
  });

  it('Toggle dark mode cycles the theme', async () => {
    useThemeStore.setState({ themePreference: 'light' });
    const user = await openMenu();
    await user.click(screen.getByTestId('topbar-menu-more-help.dark-mode'));
    expect(useThemeStore.getState().themePreference).not.toBe('light');
  });

  it('the pane items flip the same layout flags as the pane toggles', async () => {
    const user = await openMenu();
    const before = useLayoutStore.getState().leftSidebarCollapsed;
    await user.click(screen.getByTestId('topbar-menu-more-view.toggleLeftSidebar'));
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(!before);
  });

  it('Hide labels shows the diagram labels flag and toggles it', async () => {
    const user = await openMenu();
    const item = screen.getByTestId('topbar-menu-more-hide-labels');
    expect(item.querySelector('svg')).toBeNull();
    await user.click(item);
    expect(useUiStore.getState().hideLabels).toBe(true);

    await user.click(screen.getByTestId('topbar-menu-more-trigger'));
    const checked = await screen.findByTestId('topbar-menu-more-hide-labels');
    await waitFor(() => expect(checked.querySelector('svg')).not.toBeNull());
  });

  it('Actual units switches between per unit and actual, and shows which is on', async () => {
    const user = await openMenu();
    await user.click(screen.getByTestId('topbar-menu-more-actual-units'));
    expect(useUnitsStore.getState().mode).toBe('actual');

    await user.click(screen.getByTestId('topbar-menu-more-trigger'));
    const item = await screen.findByTestId('topbar-menu-more-actual-units');
    await waitFor(() => expect(item.querySelector('svg')).not.toBeNull());
    await user.click(item);
    expect(useUnitsStore.getState().mode).toBe('pu');
  });

  it('closes after an item is chosen, like the other top bar menus', async () => {
    const user = await openMenu();
    await user.click(screen.getByTestId('topbar-menu-more-help.dark-mode'));
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-more-content')).not.toBeInTheDocument();
    });
  });
});
