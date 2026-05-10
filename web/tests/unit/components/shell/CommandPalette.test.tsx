/**
 * Tests for `<CommandPalette />` (Unit 9 of the v2.0 polish plan).
 *
 * Scenarios from the plan:
 *
 * - Happy: typing "snapshot" surfaces Save / Load snapshot commands.
 * - Edge: when() returns false → command hidden (Run EIG until PF
 *   converged).
 * - Edge: keyboard navigation (arrows + Enter).
 * - Edge: Escape closes.
 * - Edge: backdrop click closes.
 * - Integration: action from palette = action from menu (mock the
 *   underlying handler and confirm both paths invoke it once).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CommandPalette } from '@/components/shell/CommandPalette';
import { WorkspaceMenu } from '@/components/shell/WorkspaceMenu';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSnapshotStore } from '@/store/snapshot';
import { usePflowStore } from '@/store/pflow';
import type { TopologySummary, PflowResult } from '@/api/types';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

// Same topology mock pattern the menu tests use.
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

beforeEach(() => {
  MOCK_TOPOLOGY = emptyTopology();
  useCommandPaletteStore.setState({ open: false });
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
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
});

afterEach(() => {
  cleanup();
  useCommandPaletteStore.setState({ open: false });
});

describe('<CommandPalette /> — open / close', () => {
  it('mounts only when the store flag is true', () => {
    render(withProviders(<CommandPalette />));
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('renders the input + grouped headings when opened', async () => {
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    await screen.findByTestId('command-palette');
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('Escape closes the palette', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    await screen.findByTestId('command-palette');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(false);
    });
  });

  it('clicking the backdrop closes the palette', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    const overlay = await screen.findByTestId('command-palette-overlay');
    await user.click(overlay);
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(false);
    });
  });
});

describe('<CommandPalette /> — search', () => {
  it('typing "snapshot" surfaces both snapshot commands', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    const input = await screen.findByTestId('command-palette-input');
    await user.type(input, 'snapshot');
    // Save snapshot appears under both Workspace and Export groups.
    expect(
      await screen.findByTestId('command-palette-item-workspace.save-snapshot'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('command-palette-item-workspace.load-snapshot'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('command-palette-item-export.snapshot'),
    ).toBeInTheDocument();
    // Unrelated commands should not be visible.
    expect(screen.queryByTestId('command-palette-item-run.pflow')).not.toBeInTheDocument();
  });

  it('typing a synonym ("PF") matches Run PFlow via keywords', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    const input = await screen.findByTestId('command-palette-input');
    await user.type(input, 'PF');
    expect(
      await screen.findByTestId('command-palette-item-run.pflow'),
    ).toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    const input = await screen.findByTestId('command-palette-input');
    await user.type(input, 'qzqzqzqz-not-a-command');
    expect(await screen.findByTestId('command-palette-empty')).toBeInTheDocument();
  });
});

describe('<CommandPalette /> — when() gating', () => {
  it('hides "Run EIG" until PF has converged', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    const input = await screen.findByTestId('command-palette-input');
    await user.type(input, 'eig');
    expect(screen.queryByTestId('command-palette-item-run.eig')).not.toBeInTheDocument();
  });

  it('surfaces "Run EIG" once PF has converged', async () => {
    const convergedRun = {
      converged: true,
      iterations: 4,
      max_mismatch: 1e-9,
      buses: [],
    } as unknown as PflowResult;
    usePflowStore.setState({ lastRun: convergedRun, isRunning: false, error: null });
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    const input = await screen.findByTestId('command-palette-input');
    await user.type(input, 'eig');
    expect(await screen.findByTestId('command-palette-item-run.eig')).toBeInTheDocument();
  });
});

describe('<CommandPalette /> — keyboard navigation', () => {
  it('arrow + Enter activates the highlighted command', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    const input = await screen.findByTestId('command-palette-input');
    // Narrow to a single deterministic match so Enter has only one
    // selectable target.
    await user.type(input, 'save snapshot');
    await screen.findByTestId('command-palette-item-workspace.save-snapshot');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('ArrowDown moves selection between items', async () => {
    const user = userEvent.setup();
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    await screen.findByTestId('command-palette-input');
    // The first item is selected by default. ArrowDown moves to the
    // next; cmdk marks the active item with `aria-selected="true"`.
    const before = document.querySelectorAll('[aria-selected="true"]');
    expect(before.length).toBe(1);
    await user.keyboard('{ArrowDown}');
    const after = document.querySelectorAll('[aria-selected="true"]');
    expect(after.length).toBe(1);
    expect(after[0]).not.toBe(before[0]);
  });
});

describe('<CommandPalette /> — integration with menus', () => {
  it('palette and Workspace menu both open the snapshot save dialog', async () => {
    const user = userEvent.setup();

    // Path 1: via the Workspace menu.
    const view1 = render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-save-snapshot'));
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
    // Reset for the next path.
    useSnapshotStore.getState().reset();
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
    view1.unmount();

    // Path 2: via the palette.
    render(withProviders(<CommandPalette />));
    act(() => { useCommandPaletteStore.getState().openPalette(); });
    await user.click(await screen.findByTestId('command-palette-item-workspace.save-snapshot'));
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });
});
