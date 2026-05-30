/**
 * Tests for ``<ActivityPanel />`` (v3.1 Phase 3, Unit 11).
 *
 * Coverage:
 *  - Renders the Active + History sub-tabs and switches between them.
 *  - A JobRecord row renders its kind + status correctly.
 *  - A cancellable in-flight row shows Cancel; clicking fires useCancelJob
 *    (DELETE) with the right vars.
 *  - A failed history row shows Retry + View error; Retry re-fires the
 *    original mutation; View error opens the modal.
 *  - Empty states for both sub-tabs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useJobsStore } from '@/store/jobs';
import { useSessionStore } from '@/store/session';
import type { SessionId } from '@/api/types';

// ---- query-mutation spies -------------------------------------------------
// The panel calls useCancelJob / useRunPflow / useEigRun / useSeRun /
// useReloadCase. Stub each to a mutate-spy so we can assert the retry /
// cancel wiring without touching the network.
const cancelMutate = vi.fn();
const pflowMutate = vi.fn();
const eigMutate = vi.fn();
const seMutate = vi.fn();
const reloadMutate = vi.fn();

vi.mock('@/api/queries', () => ({
  useCancelJob: () => ({ mutate: cancelMutate }),
  useRunPflow: () => ({ mutate: pflowMutate }),
  useEigRun: () => ({ mutate: eigMutate }),
  useSeRun: () => ({ mutate: seMutate }),
  useReloadCase: () => ({ mutate: reloadMutate }),
}));

import { ActivityPanel } from '@/components/shell/ActivityPanel';

const SID = 'sess-123' as SessionId;

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT, activityPanelTab: 'active' });
  useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  useSessionStore.setState({ sessionId: SID });
  cancelMutate.mockClear();
  pflowMutate.mockClear();
  eigMutate.mockClear();
  seMutate.mockClear();
  reloadMutate.mockClear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
});

function seedJob(rec: {
  id: string;
  kind?: string;
  status?: string;
  can_cancel?: boolean;
  started_at?: number;
  ended_at?: number;
  progress?: number;
  problem?: Record<string, unknown> | null;
}): void {
  const now = Date.now() / 1000;
  const full = {
    id: rec.id,
    kind: (rec.kind ?? 'pflow') as never,
    status: (rec.status ?? 'running') as never,
    started_at: rec.started_at ?? now,
    updated_at: now,
    can_cancel: rec.can_cancel ?? false,
    request_summary: {},
    repeated_count: 1,
    ...(rec.ended_at !== undefined ? { ended_at: rec.ended_at } : {}),
    ...(rec.progress !== undefined ? { progress: rec.progress } : {}),
    ...(rec.problem !== undefined ? { problem: rec.problem } : {}),
  };
  useJobsStore.setState((s) => ({ jobs: { ...s.jobs, [rec.id]: full as never } }));
}

describe('<ActivityPanel />', () => {
  it('renders Active + History sub-tabs', () => {
    render(<ActivityPanel />);
    expect(screen.getByTestId('activity-panel-subtab-active')).toBeInTheDocument();
    expect(screen.getByTestId('activity-panel-subtab-history')).toBeInTheDocument();
  });

  it('renders an in-flight JobRecord row with kind + status', () => {
    seedJob({ id: 'j1', kind: 'eig', status: 'running' });
    render(<ActivityPanel />);
    const row = screen.getByTestId('activity-row-j1');
    expect(within(row).getByText('Eigenvalue analysis')).toBeInTheDocument();
    expect(screen.getByTestId('activity-row-status-j1')).toHaveTextContent('Running');
  });

  it('shows Cancel on a cancellable in-flight row and fires DELETE', async () => {
    const user = userEvent.setup();
    seedJob({ id: 'j2', kind: 'sweep', status: 'running', can_cancel: true });
    render(<ActivityPanel />);

    const cancelBtn = screen.getByTestId('activity-row-cancel-j2');
    await user.click(cancelBtn);

    expect(cancelMutate).toHaveBeenCalledTimes(1);
    expect(cancelMutate).toHaveBeenCalledWith(
      { sessionId: SID, jobId: 'j2' },
      expect.anything(),
    );
  });

  it('does not show Cancel when can_cancel is false', () => {
    seedJob({ id: 'j3', kind: 'pflow', status: 'running', can_cancel: false });
    render(<ActivityPanel />);
    expect(screen.queryByTestId('activity-row-cancel-j3')).not.toBeInTheDocument();
  });

  it('failed history row shows Retry + View error; Retry re-fires the mutation', async () => {
    const user = userEvent.setup();
    seedJob({
      id: 'jf',
      kind: 'pflow',
      status: 'failed',
      ended_at: Date.now() / 1000,
      problem: { title: 'Power flow failed', detail: 'Did not converge' },
    });
    useLayoutStore.setState({ activityPanelTab: 'history' });
    render(<ActivityPanel />);

    expect(screen.getByTestId('activity-row-error-icon-jf')).toBeInTheDocument();
    await user.click(screen.getByTestId('activity-row-retry-jf'));
    expect(pflowMutate).toHaveBeenCalledTimes(1);
    expect(pflowMutate).toHaveBeenCalledWith(SID);
  });

  it('View error opens the modal with the captured problem', async () => {
    const user = userEvent.setup();
    seedJob({
      id: 'jf2',
      kind: 'eig',
      status: 'failed',
      ended_at: Date.now() / 1000,
      problem: { title: 'Eig boom', detail: 'kaput' },
    });
    useLayoutStore.setState({ activityPanelTab: 'history' });
    render(<ActivityPanel />);

    expect(screen.queryByTestId('activity-error-modal')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('activity-row-view-error-jf2'));
    expect(screen.getByTestId('activity-error-modal')).toBeInTheDocument();
    expect(screen.getByText('Eig boom')).toBeInTheDocument();
  });

  it('switching to the History sub-tab updates the layout store', async () => {
    const user = userEvent.setup();
    render(<ActivityPanel />);
    expect(useLayoutStore.getState().activityPanelTab).toBe('active');
    await user.click(screen.getByTestId('activity-panel-subtab-history'));
    expect(useLayoutStore.getState().activityPanelTab).toBe('history');
  });

  it('renders the Active empty state when there are no in-flight jobs', () => {
    render(<ActivityPanel />);
    expect(screen.getByTestId('activity-panel-active-empty')).toBeInTheDocument();
  });

  it('renders the History empty state when there are no terminal jobs', () => {
    useLayoutStore.setState({ activityPanelTab: 'history' });
    render(<ActivityPanel />);
    expect(screen.getByTestId('activity-panel-history-empty')).toBeInTheDocument();
  });

  it('separates active vs terminal jobs across the two sub-tabs', () => {
    seedJob({ id: 'run1', status: 'running' });
    seedJob({ id: 'done1', status: 'done', ended_at: Date.now() / 1000 });
    render(<ActivityPanel />);
    // Active tab is shown by default — running job present, terminal absent.
    expect(screen.getByTestId('activity-row-run1')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-row-done1')).not.toBeInTheDocument();
  });
});
