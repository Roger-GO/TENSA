/**
 * Tests for `<SnapshotMenu />` (Unit 7 of the v2.0 plan).
 *
 * Covers:
 * - Trigger button enable/disable gating on session + case selection.
 * - Menu items dispatch to the right snapshot-store actions.
 * - The dialogs themselves are rendered alongside (deferred-mount
 *   guard) so the menu can sit inside a TopBar without a
 *   QueryClientProvider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SnapshotMenu } from '@/components/snapshot/SnapshotMenu';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSnapshotStore } from '@/store/snapshot';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
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
});

afterEach(() => {
  cleanup();
});

describe('<SnapshotMenu /> — trigger gating', () => {
  it('is enabled when a session + case selection are present', () => {
    render(withQueryClient(<SnapshotMenu />));
    expect(screen.getByTestId('snapshot-menu-trigger')).toBeEnabled();
  });

  it('is disabled when no session is present', () => {
    useSessionStore.setState({ sessionId: null });
    render(withQueryClient(<SnapshotMenu />));
    expect(screen.getByTestId('snapshot-menu-trigger')).toBeDisabled();
  });

  it('is disabled when no case selection is present', () => {
    useCaseStore.setState({ selection: null });
    render(withQueryClient(<SnapshotMenu />));
    expect(screen.getByTestId('snapshot-menu-trigger')).toBeDisabled();
  });
});

describe('<SnapshotMenu /> — actions', () => {
  it('Save snapshot opens the save dialog via the store', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SnapshotMenu />));
    await user.click(screen.getByTestId('snapshot-menu-trigger'));
    const item = await screen.findByTestId('snapshot-menu-save');
    await user.click(item);
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
    expect(useSnapshotStore.getState().loadDialogOpen).toBe(false);
  });

  it('Load snapshot opens the load dialog via the store', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SnapshotMenu />));
    await user.click(screen.getByTestId('snapshot-menu-trigger'));
    const item = await screen.findByTestId('snapshot-menu-load');
    await user.click(item);
    expect(useSnapshotStore.getState().loadDialogOpen).toBe(true);
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
  });
});
