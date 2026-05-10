/**
 * Tests for `<EditMenu />`.
 *
 * Unit 9 of the v2.0 polish plan refactored this menu to derive items
 * from the shared command registry instead of embedding
 * `<WorkflowToolbar />`. The menu now renders one
 * `<TopBarMenuItem />` per command in the `edit` group; the
 * underlying mutation logic is still exercised by
 * `tests/unit/components/case/WorkflowToolbar.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { TopologySummary } from '@/api/types';
import { EditMenu } from '@/components/shell/EditMenu';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
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
});

afterEach(() => {
  cleanup();
});

describe('<EditMenu />', () => {
  it('mounts the trigger button', () => {
    render(withProviders(<EditMenu />));
    expect(screen.getByTestId('topbar-menu-edit-trigger')).toBeInTheDocument();
  });

  it('opens on click and surfaces the Undo + Reload registry commands', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const content = await screen.findByTestId('topbar-menu-edit-content');
    expect(content).toBeInTheDocument();
    // Items come from the registry (`edit.undo`, `edit.reload`).
    expect(screen.getByTestId('topbar-menu-edit-undo')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-edit-reload')).toBeInTheDocument();
  });

  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    await screen.findByTestId('topbar-menu-edit-content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-edit-content')).not.toBeInTheDocument();
    });
  });
});
