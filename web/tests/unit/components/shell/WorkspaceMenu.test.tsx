/**
 * Tests for `<WorkspaceMenu />` (Unit 8 of the v2.0 polish plan).
 *
 * Covers happy-path opening, item gating on session/case state,
 * dispatching to the right store actions, and the close-on-Escape
 * contract inherited from `<TopBarMenu />`.
 *
 * Integration coverage with the per-component dialogs lives in those
 * components' own tests (SaveSystemButton, SnapshotMenu, etc.). We
 * verify here that the menu items reach the same store actions that
 * the dialogs read from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { TopologySummary } from '@/api/types';
import { WorkspaceMenu } from '@/components/shell/WorkspaceMenu';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSnapshotStore } from '@/store/snapshot';
import { useReportDialogStore } from '@/components/reports/ReportDialog';
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

beforeEach(() => {
  MOCK_TOPOLOGY = emptyTopology();
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
  useSnapshotStore.getState().reset();
  useReportDialogStore.setState({ dialogOpen: false, activeRoutine: 'pflow' });
});

afterEach(() => {
  cleanup();
});

describe('<WorkspaceMenu /> — render + open', () => {
  it('mounts the trigger button with the kebab-case testid', () => {
    render(withProviders(<WorkspaceMenu />));
    expect(screen.getByTestId('topbar-menu-workspace-trigger')).toBeInTheDocument();
  });

  it('opens on click, exposing every workspace item', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.getByTestId('topbar-menu-workspace-add-element')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-add-pmu')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-import-profile')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-save-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-load-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-report')).toBeInTheDocument();
  });
});

describe('<WorkspaceMenu /> — actions', () => {
  it('"Save snapshot" routes through the snapshot store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-save-snapshot'));
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });

  it('"Load snapshot" routes through the snapshot store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-load-snapshot'));
    expect(useSnapshotStore.getState().loadDialogOpen).toBe(true);
  });

  it('"Add element" opens the add-element panel via the case store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-add-element'));
    expect(useCaseStore.getState().addPanelOpen).toBe(true);
  });

  it('"Report" opens the report dialog via the local report store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-report'));
    expect(useReportDialogStore.getState().dialogOpen).toBe(true);
  });
});

describe('<WorkspaceMenu /> — gating', () => {
  // Unit 9 changed gating semantics: commands whose `when()` returns
  // false are HIDDEN from the menu (and the palette) entirely instead
  // of rendered as disabled items. The disabled-state UX is gone —
  // see `web/src/lib/commands.ts` and the v2.0 polish plan Unit 9.
  it('hides edit-gated items when no topology is loaded', async () => {
    MOCK_TOPOLOGY = null;
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.queryByTestId('topbar-menu-workspace-add-element')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-add-pmu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-import-profile')).not.toBeInTheDocument();
  });

  it('hides session-scoped items when no session is present', async () => {
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.queryByTestId('topbar-menu-workspace-save-snapshot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-load-snapshot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-report')).not.toBeInTheDocument();
  });
});

describe('<WorkspaceMenu /> — keyboard', () => {
  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-workspace-content')).not.toBeInTheDocument();
    });
  });
});
