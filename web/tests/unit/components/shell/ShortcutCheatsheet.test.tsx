/**
 * Tests for `<ShortcutCheatsheet />` (Unit 10 of the v2.0 polish plan).
 *
 * Scenarios:
 *  - Mount-on-open: rendering without flipping the slice does NOT
 *    portal anything into the DOM.
 *  - Open: rendering with the slice flag flipped surfaces the modal,
 *    grouped rows, and `<kbd>` chips.
 *  - Sync with registry: every shortcut row in the cheatsheet
 *    corresponds to exactly one entry in `useCommandRegistry()` —
 *    the cheatsheet has no hard-coded duplication.
 *  - Close: Escape closes the modal; backdrop click closes it.
 *  - At least 10 entries (per the plan's verification gate).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { ShortcutCheatsheet } from '@/components/shell/ShortcutCheatsheet';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';
import { useCommandRegistry } from '@/lib/commands';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSnapshotStore } from '@/store/snapshot';
import { usePflowStore } from '@/store/pflow';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function emptyTopology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  MOCK_TOPOLOGY = emptyTopology();
  useShortcutCheatsheetStore.setState({ open: false });
  useSessionStore.setState({
    sessionId: parseSessionId('test-session'),
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
    recoveryStuckSince: null,
  });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('cases/ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
  useSnapshotStore.getState().reset();
  // Promote PF converged so EIG (and any future PF-gated commands)
  // also surface in the cheatsheet — keeps the row count stable
  // across runs.
  usePflowStore.setState({
    lastRun: {
      converged: true,
      iterations: 4,
      max_mismatch: 1e-9,
      buses: [],
    } as unknown as PflowResult,
    isRunning: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  useShortcutCheatsheetStore.setState({ open: false });
});

describe('<ShortcutCheatsheet /> — mount lifecycle', () => {
  it('does NOT mount the modal when the slice flag is false', () => {
    render(withProviders(<ShortcutCheatsheet />));
    expect(screen.queryByTestId('shortcut-cheatsheet')).not.toBeInTheDocument();
  });

  it('mounts the modal when openCheatsheet is called', async () => {
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    await screen.findByTestId('shortcut-cheatsheet');
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
  });
});

describe('<ShortcutCheatsheet /> — content', () => {
  it('renders at least 10 shortcut rows (plan verification gate)', async () => {
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    await screen.findByTestId('shortcut-cheatsheet');
    // Every row uses the `shortcut-cheatsheet-row-${id}` testid.
    const rows = document.querySelectorAll('[data-testid^="shortcut-cheatsheet-row-"]');
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it('groups rows by command group with the documented headings', async () => {
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    await screen.findByTestId('shortcut-cheatsheet');
    // The "help" group must be present (palette + cheatsheet bindings
    // both live in `help`).
    expect(screen.getByTestId('shortcut-cheatsheet-group-help')).toBeInTheDocument();
    expect(screen.getByText('Help')).toBeInTheDocument();
  });

  it('renders kbd chips for the cheatsheet binding itself', async () => {
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    await screen.findByTestId('shortcut-cheatsheet-row-help.shortcuts');
    const row = screen.getByTestId('shortcut-cheatsheet-row-help.shortcuts');
    // The row contains at least one `<kbd>` element rendering the
    // `?` glyph.
    const kbds = row.querySelectorAll('kbd');
    expect(kbds.length).toBeGreaterThan(0);
    expect(row.textContent).toContain('?');
  });

  it('renders a chip per token for sequence bindings (g s)', async () => {
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    await screen.findByTestId('shortcut-cheatsheet-row-workspace.save-snapshot');
    const row = screen.getByTestId('shortcut-cheatsheet-row-workspace.save-snapshot');
    const kbds = row.querySelectorAll('kbd');
    // Two kbd chips ("G" and "S") + one literal "then".
    expect(kbds.length).toBe(2);
    expect(row.textContent).toContain('then');
  });
});

describe('<ShortcutCheatsheet /> — registry sync', () => {
  it('row set matches the registry exactly (no drift)', async () => {
    // Render the cheatsheet AND grab the registry snapshot it would
    // see. The two should agree on which commands have shortcuts.
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    await screen.findByTestId('shortcut-cheatsheet');

    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const expectedIds = result.current
      .filter((c) => typeof c.shortcut === 'string' && c.shortcut.length > 0)
      .map((c) => c.id)
      .sort();

    const renderedIds = Array.from(
      document.querySelectorAll('[data-testid^="shortcut-cheatsheet-row-"]'),
    )
      .map((el) => el.getAttribute('data-testid')?.replace('shortcut-cheatsheet-row-', '') ?? '')
      .sort();

    expect(renderedIds).toEqual(expectedIds);
  });
});

describe('<ShortcutCheatsheet /> — close behaviour', () => {
  it('Escape closes the cheatsheet', async () => {
    const user = userEvent.setup();
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    await screen.findByTestId('shortcut-cheatsheet');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(useShortcutCheatsheetStore.getState().open).toBe(false);
    });
  });

  it('clicking the backdrop closes the cheatsheet', async () => {
    const user = userEvent.setup();
    render(withProviders(<ShortcutCheatsheet />));
    act(() => {
      useShortcutCheatsheetStore.getState().openCheatsheet();
    });
    const overlay = await screen.findByTestId('shortcut-cheatsheet-overlay');
    await user.click(overlay);
    await waitFor(() => {
      expect(useShortcutCheatsheetStore.getState().open).toBe(false);
    });
  });
});
