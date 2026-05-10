/**
 * Tests for `<EditMenu />` (Unit 8 of the v2.0 polish plan).
 *
 * EditMenu is intentionally thin: it embeds the existing
 * ``WorkflowToolbar`` (Undo + Reload) inside a TopBarMenu popover.
 * The Undo / Reload behaviour is already covered by
 * ``tests/unit/components/case/WorkflowToolbar.test.tsx``; we only
 * verify that opening the menu surfaces those buttons and that
 * Escape closes the menu cleanly.
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

  it('opens on click and surfaces the Undo + Reload buttons', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const content = await screen.findByTestId('topbar-menu-edit-content');
    expect(content).toBeInTheDocument();
    // Undo + Reload come from the embedded WorkflowToolbar.
    expect(screen.getByTestId('undo-last-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('reload-case-button')).toBeInTheDocument();
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
