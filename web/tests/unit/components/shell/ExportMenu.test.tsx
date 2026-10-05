/**
 * Tests for `<ExportMenu />` (Unit 8 of the v2.0 polish plan) — the
 * TopBar-mounted dropdown grouping workspace-wide export actions.
 *
 * NB: there is also a `<ExportMenu />` at
 * `components/export/ExportMenu.tsx` (per-panel CSV/PNG/MAT trigger).
 * This file covers the TopBar variant at `components/shell/ExportMenu.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const saveHtmlReport = vi.fn<() => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/saveHtmlReport', () => ({
  saveHtmlReport: () => saveHtmlReport(),
}));

import { ExportMenu } from '@/components/shell/ExportMenu';
import { usePflowStore } from '@/store/pflow';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { useRunsStore } from '@/store/runs';
import { useAnalyzeStore } from '@/store/analyze';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useBundleStore } from '@/store/bundle';
import { useSnapshotStore } from '@/store/snapshot';
import { useReportDialogStore } from '@/store/reportDialog';
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
  useReportDialogStore.getState().closeDialog();
  saveHtmlReport.mockClear();
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  usePflowHistoryStore.getState().clear();
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useAnalyzeStore.setState({ eigResult: null });
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
    expect(screen.queryByTestId('topbar-menu-export-reports')).not.toBeInTheDocument();
  });

  it('lists "Reports…" last, under the HTML report, and it opens the Reports dialog', async () => {
    // The dialog with ANDES's plain-text reports is a Workspace command; a
    // first-time user looks for a report here, so it is listed here as well.
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    const content = await screen.findByTestId('topbar-menu-export-content');
    const items = [...content.querySelectorAll('[role="menuitem"]')].map(
      (el) => el.getAttribute('data-testid') ?? '',
    );
    expect(items).toEqual([
      'topbar-menu-export-bundle',
      'topbar-menu-export-snapshot',
      'topbar-menu-export-html-report',
      'topbar-menu-export-reports',
    ]);
    const reports = screen.getByTestId('topbar-menu-export-reports');
    expect(reports).toHaveTextContent('Reports…');
    expect(reports).toHaveAttribute(
      'aria-description',
      expect.stringContaining('plain-text reports'),
    );

    await user.click(reports);
    expect(useReportDialogStore.getState().dialogOpen).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-export-content')).not.toBeInTheDocument();
    });
  });

  it('keeps "Export HTML report" in view, greyed out with what to do first, before any result', async () => {
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    const item = await screen.findByTestId('topbar-menu-export-html-report');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent(
      'Nothing to report yet. Run a power flow or a time-domain simulation first.',
    );

    await user.click(item);
    expect(saveHtmlReport).not.toHaveBeenCalled();
  });

  it('"Export HTML report" saves the report once there is a result, and closes the menu', async () => {
    usePflowStore.setState({
      lastRun: {
        run_id: 'pf-1',
        converged: true,
        iterations: 3,
        mismatch: 1e-9,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
      } as never,
    });
    const user = userEvent.setup();
    render(withProviders(<ExportMenu />));
    await user.click(screen.getByTestId('topbar-menu-export-trigger'));
    const item = await screen.findByTestId('topbar-menu-export-html-report');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(item);

    expect(saveHtmlReport).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-export-content')).not.toBeInTheDocument();
    });
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
