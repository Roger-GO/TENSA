/**
 * Tests for ``<ActivityPanel />`` (v3.1 Phase 3, Unit 11).
 *
 * Coverage:
 *  - Renders the Active + Finished sub-tabs and switches between them.
 *  - A JobRecord row renders its kind + status correctly.
 *  - A cancellable in-flight row shows Cancel; clicking fires useCancelJob
 *    (DELETE) with the right vars.
 *  - A failed history row shows Retry + View error; Retry re-fires the
 *    original mutation; View error opens the modal.
 *  - Empty states for both sub-tabs.
 *  - The Finished sub-tab says that it is this page load's jobs and leads to
 *    the run history, where the runs kept across a reload are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useHistoryStore } from '@/store/history';
import { useJobsStore } from '@/store/jobs';
import { useRunsStore } from '@/store/runs';
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
  useRunsStore.getState().clearRuns();
  useHistoryStore.getState().reset();
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
  useRunsStore.getState().clearRuns();
  useHistoryStore.getState().reset();
});

/** A finished run that is no longer the active one, as a reload brings it back. */
function seedKeptRun(runId: string): void {
  useRunsStore.getState().startRun({ runId, tf: 1, columnNames: ['Bus_1_v'] });
  useRunsStore.getState().markRunDone(runId, 1, true);
  useRunsStore.getState().clearActiveRun();
}

function seedJob(rec: {
  id: string;
  kind?: string;
  status?: string;
  can_cancel?: boolean;
  started_at?: number;
  ended_at?: number;
  progress?: number;
  problem?: Record<string, unknown> | null;
  request_summary?: Record<string, unknown>;
}): void {
  const now = Date.now() / 1000;
  const full = {
    id: rec.id,
    kind: (rec.kind ?? 'pflow') as never,
    status: (rec.status ?? 'running') as never,
    started_at: rec.started_at ?? now,
    updated_at: now,
    can_cancel: rec.can_cancel ?? false,
    request_summary: rec.request_summary ?? {},
    repeated_count: 1,
    ...(rec.ended_at !== undefined ? { ended_at: rec.ended_at } : {}),
    ...(rec.progress !== undefined ? { progress: rec.progress } : {}),
    ...(rec.problem !== undefined ? { problem: rec.problem } : {}),
  };
  useJobsStore.setState((s) => ({ jobs: { ...s.jobs, [rec.id]: full as never } }));
}

describe('<ActivityPanel />', () => {
  it('renders Active + Finished sub-tabs', () => {
    render(<ActivityPanel />);
    expect(screen.getByTestId('activity-panel-subtab-active')).toHaveTextContent('Active');
    // Not "History": that is what the list of runs is called, and this is not it.
    expect(screen.getByTestId('activity-panel-subtab-history')).toHaveTextContent('Finished');
    expect(screen.getByRole('tab', { name: 'Finished' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /history/i })).not.toBeInTheDocument();
  });

  it('renders an in-flight JobRecord row with kind + status', () => {
    seedJob({ id: 'j1', kind: 'eig', status: 'running' });
    render(<ActivityPanel />);
    const row = screen.getByTestId('activity-row-j1');
    expect(within(row).getByText('Eigenvalue analysis')).toBeInTheDocument();
    expect(screen.getByTestId('activity-row-status-j1')).toHaveTextContent('Running');
  });

  it('says what an edit changed under its name, where the caller said', () => {
    // A load moved to another bus takes its Vn along: the notice that said so
    // is gone in seconds, and the list keeps it.
    seedJob({
      id: 'e1',
      kind: 'element-edit',
      status: 'running',
      request_summary: { model: 'PQ', idx: 'PQ_3', detail: 'Changed bus, Vn of PQ PQ_3' },
    });
    seedJob({ id: 'j1', kind: 'pflow', status: 'running' });
    render(<ActivityPanel />);
    expect(within(screen.getByTestId('activity-row-e1')).getByText('Edit element')).toBeVisible();
    expect(screen.getByTestId('activity-row-detail-e1')).toHaveTextContent(
      'Changed bus, Vn of PQ PQ_3',
    );
    // A job with nothing to add has no such line.
    expect(screen.queryByTestId('activity-row-detail-j1')).not.toBeInTheDocument();
  });

  it('shows Cancel on a cancellable in-flight row and fires DELETE', async () => {
    const user = userEvent.setup();
    seedJob({ id: 'j2', kind: 'sweep', status: 'running', can_cancel: true });
    render(<ActivityPanel />);

    const cancelBtn = screen.getByTestId('activity-row-cancel-j2');
    await user.click(cancelBtn);

    expect(cancelMutate).toHaveBeenCalledTimes(1);
    expect(cancelMutate).toHaveBeenCalledWith({ sessionId: SID, jobId: 'j2' }, expect.anything());
  });

  it('does not show Cancel when can_cancel is false', () => {
    seedJob({ id: 'j3', kind: 'pflow', status: 'running', can_cancel: false });
    render(<ActivityPanel />);
    expect(screen.queryByTestId('activity-row-cancel-j3')).not.toBeInTheDocument();
  });

  it('hides Cancel while the id is still a local: placeholder (DELETE would 404)', () => {
    // A cancellable sweep whose canonical id has not yet reconciled — Cancel
    // must NOT render (DELETE /jobs/local:... cannot match a server job).
    seedJob({ id: 'local:abc', kind: 'sweep', status: 'running', can_cancel: true });
    render(<ActivityPanel />);
    expect(screen.queryByTestId('activity-row-cancel-local:abc')).not.toBeInTheDocument();
  });

  it('exposes the progress bar as a progressbar with aria-valuenow/min/max', () => {
    seedJob({ id: 'jp', kind: 'sweep', status: 'running', progress: 0.42 });
    render(<ActivityPanel />);
    const bar = screen.getByTestId('activity-row-progress-jp');
    expect(bar).toHaveAttribute('role', 'progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
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

  it('switching to the Finished sub-tab updates the layout store', async () => {
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

  it('renders the Finished empty state when there are no terminal jobs', () => {
    useLayoutStore.setState({ activityPanelTab: 'history' });
    render(<ActivityPanel />);
    const empty = screen.getByTestId('activity-panel-history-empty');
    expect(empty).toHaveTextContent('No finished jobs yet');
    expect(empty).not.toHaveTextContent(/history/i);
  });

  it('an empty Finished list says a reload emptied it, not the runs, and opens the run history', async () => {
    // After a reload: no job of this page load, and two runs the browser kept.
    const user = userEvent.setup();
    seedKeptRun('kept-1');
    seedKeptRun('kept-2');
    useLayoutStore.setState({ activityPanelTab: 'history', historyKindFilter: 'all' });
    render(<ActivityPanel />);
    expect(screen.getByTestId('activity-panel-history-empty')).toBeInTheDocument();
    const note = screen.getByTestId('activity-panel-history-note');
    expect(note).toHaveTextContent(
      'A reload empties this list but not your results: time-domain runs are kept, with their plots, in',
    );
    await user.click(within(note).getByRole('button', { name: 'Run history (2)' }));
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
    // On the runs, not on the job list the drawer was last set to.
    expect(useLayoutStore.getState().historyKindFilter).toBe('runs');
  });

  it('a Finished list with jobs has the same line and button above its rows', async () => {
    const user = userEvent.setup();
    seedKeptRun('run-1');
    seedJob({ id: 'run-1', kind: 'tds-stream', status: 'done', ended_at: Date.now() / 1000 });
    useLayoutStore.setState({ activityPanelTab: 'history' });
    render(<ActivityPanel />);
    const note = screen.getByTestId('activity-panel-history-note');
    const row = screen.getByTestId('activity-row-run-1');
    expect(note.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(note).getByRole('button', { name: 'Run history (1)' }));
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
  });

  it('keeps the line off the Active sub-tab', () => {
    seedJob({ id: 'run1', status: 'running' });
    seedJob({ id: 'done1', status: 'done', ended_at: Date.now() / 1000 });
    render(<ActivityPanel />);
    expect(screen.queryByTestId('activity-panel-history-note')).not.toBeInTheDocument();
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
