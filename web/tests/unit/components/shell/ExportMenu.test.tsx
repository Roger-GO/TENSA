/**
 * Tests for `<ExportMenu />` (Unit 8 of the v2.0 polish plan) — the
 * TopBar-mounted dropdown grouping workspace-wide export actions.
 *
 * NB: there is also a `<ExportMenu />` at
 * `components/export/ExportMenu.tsx` (per-panel CSV/PNG/MAT trigger).
 * This file covers the TopBar variant at `components/shell/ExportMenu.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ExportMenu } from '@/components/shell/ExportMenu';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useBundleStore } from '@/store/bundle';
import { useSnapshotStore } from '@/store/snapshot';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: parseSessionId('test-session-id'),
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
  useBundleStore.getState().closeDialog();
  useSnapshotStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('<ExportMenu />', () => {
  it('mounts the trigger button with the kebab-case testid', () => {
    render(withProviders(<ExportMenu />));
    expect(screen.getByTestId('topbar-menu-export-trigger')).toBeInTheDocument();
  });

  it('opens on click and lists the bundle + snapshot items', async () => {
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    await screen.findByTestId('topbar-menu-export-content');
    expect(screen.getByTestId('topbar-menu-export-bundle')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-export-snapshot')).toBeInTheDocument();
  });

  it('"Export bundle…" opens the bundle dialog via the bundle store', async () => {
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-export-bundle'));
    expect(useBundleStore.getState().dialogOpen).toBe(true);
  });

  it('"Save snapshot…" opens the snapshot save dialog via the snapshot store', async () => {
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-export-snapshot'));
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });

  it('hides every item when no session/case is loaded', async () => {
    // Unit 9: commands whose `when()` returns false are HIDDEN, not
    // rendered as disabled items.
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    await screen.findByTestId('topbar-menu-export-content');
    expect(screen.queryByTestId('topbar-menu-export-bundle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-export-snapshot')).not.toBeInTheDocument();
  });

  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    await screen.findByTestId('topbar-menu-export-content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-export-content')).not.toBeInTheDocument();
    });
  });
});
