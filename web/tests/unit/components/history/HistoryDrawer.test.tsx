/**
 * <HistoryDrawer /> tests (Unit 9, basic version).
 *
 * Covers:
 * - Toggle button enables / opens / closes the drawer.
 * - Empty state when no runs are retained.
 * - Lists runs in most-recent-first order.
 * - Pin/Unpin row actions update the overlay set.
 * - "Clear overlay" button reset overlayRunIds wholesale.
 *
 * Drives the real history + runs stores; uses Radix's Dialog (which
 * portals into document.body — Testing Library's screen.* finds the
 * portaled content fine).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toastInfoMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();

vi.mock('@/lib/toast', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    dismiss: vi.fn(),
  },
}));

import { HistoryDrawer } from '@/components/history/HistoryDrawer';
import { HistoryDrawerToggle } from '@/components/history/HistoryDrawerToggle';
import { DEFAULT_RETENTION_LIMIT, useRunsStore } from '@/store/runs';
import { useHistoryStore } from '@/store/history';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useJobsStore } from '@/store/jobs';
import { useLayoutStore } from '@/store/layout';
import type { JobKind, JobStatus } from '@/store/jobs';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

function seedRun(runId: string, tf = 5) {
  useRunsStore.getState().startRun({ runId, tf, columnNames: ['Bus_1_v'] });
  useRunsStore.getState().markRunDone(runId, tf);
}

/** Seed a JobRecord directly into ``useJobsStore`` for the All / per-kind views. */
function seedJob(id: string, kind: JobKind, status: JobStatus = 'done') {
  const now = Date.now() / 1000;
  useJobsStore.setState((s) => ({
    jobs: {
      ...s.jobs,
      [id]: {
        id,
        kind,
        status,
        started_at: now,
        updated_at: now,
        ended_at: now,
        can_cancel: false,
        request_summary: {},
        repeated_count: 0,
      },
    },
  }));
}

function seedSessionAndCase() {
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
}

describe('HistoryDrawerToggle', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
    useJobsStore.setState({ jobs: {} });
    useLayoutStore.getState().setHistoryKindFilter('runs');
    useHistoryStore.getState().reset();
    seedSessionAndCase();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the History button and the run-count badge when runs exist', () => {
    seedRun('r1');
    seedRun('r2');
    render(<HistoryDrawerToggle />);
    const btn = screen.getByTestId('history-drawer-toggle');
    expect(btn).toHaveTextContent('History');
    expect(btn).toHaveTextContent('(2)');
  });

  it('clicking the toggle opens the drawer', async () => {
    const user = userEvent.setup();
    render(<HistoryDrawerToggle />);
    expect(useHistoryStore.getState().drawerOpen).toBe(false);
    await user.click(screen.getByTestId('history-drawer-toggle'));
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
  });

  it('says what the button is for, and why it is off before a case is loaded', () => {
    const { unmount } = render(<HistoryDrawerToggle />);
    expect(screen.getByTestId('history-drawer-toggle')).toHaveAttribute(
      'title',
      'Run history: rename, pin or drop your runs',
    );
    unmount();
    useSessionStore.setState({ sessionId: null });
    render(<HistoryDrawerToggle />);
    const btn = screen.getByTestId('history-drawer-toggle');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      'title',
      'No runs yet. Load a case and run a TDS to fill the history.',
    );
  });

  it('is on before a case is loaded when there are runs to list, as after a reload', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ selection: null });
    useRunsStore.getState().restoreRuns({
      runs: [
        {
          runId: 'kept',
          startedAt: 1,
          tf: 1,
          tCurrent: 1,
          seqCount: 1,
          t: new Float64Array([0]),
          columns: { Bus_1_v: new Float64Array([1]) },
          columnNames: ['Bus_1_v'],
          ordinal: 1,
          state: 'done',
          connection: 'connected',
          abortedLocally: false,
          errorReason: null,
          converged: true,
        },
      ],
    });
    render(<HistoryDrawerToggle />);
    const btn = screen.getByTestId('history-drawer-toggle');
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('(1)');
    await user.click(btn);
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
  });

  it('clicking again closes the drawer', async () => {
    const user = userEvent.setup();
    useHistoryStore.setState({ drawerOpen: true });
    render(<HistoryDrawerToggle />);
    await user.click(screen.getByTestId('history-drawer-toggle'));
    expect(useHistoryStore.getState().drawerOpen).toBe(false);
  });
});

describe('HistoryDrawer', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
      runCount: 0,
    });
    useJobsStore.setState({ jobs: {} });
    useLayoutStore.getState().setHistoryKindFilter('runs');
    useHistoryStore.getState().reset();
    seedSessionAndCase();
    toastInfoMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('does NOT mount the drawer body while closed (deferred mount)', () => {
    render(<HistoryDrawer />);
    expect(screen.queryByTestId('history-drawer')).toBeNull();
  });

  it('renders an empty state when no runs are retained', () => {
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    expect(screen.getByTestId('history-drawer-empty')).toBeInTheDocument();
  });

  it('lists every retained run in most-recent-first order', () => {
    seedRun('r1');
    seedRun('r2');
    seedRun('r3');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    const list = screen.getByTestId('history-drawer-list');
    // Direct children only — nested test ids on swatches/buttons would
    // otherwise leak in via the [data-run-id] attribute filter.
    const rows = list.querySelectorAll(
      '[data-testid="history-run-row-r1"], [data-testid="history-run-row-r2"], [data-testid="history-run-row-r3"]',
    );
    // r3 first (most recent), r1 last.
    const ids = Array.from(rows).map((el) => el.getAttribute('data-run-id'));
    expect(ids).toEqual(['r3', 'r2', 'r1']);
  });

  it('pinning a row from the drawer updates the overlay set + fires toast.info', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-run-row-pin-r1'));
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
    // Per Unit 3 of the v2.0 polish plan: pin/unpin toasts route
    // through the global surface (sonner) rather than the in-drawer
    // alert div.
    expect(toastInfoMock).toHaveBeenCalledWith('Pinned to overlay');
    expect(screen.queryByTestId('history-drawer-toast')).toBeNull();
  });

  it('overlay count summary reflects how many runs are pinned', async () => {
    seedRun('r1');
    seedRun('r2');
    useRunsStore.getState().addOverlayRun('r1');
    useRunsStore.getState().addOverlayRun('r2');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    expect(screen.getByTestId('history-drawer-overlay-count')).toHaveTextContent(
      '2 pinned to overlay',
    );
  });

  it('Clear overlay button empties overlayRunIds + fires toast.info', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useRunsStore.getState().addOverlayRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-drawer-clear-overlay'));
    expect(useRunsStore.getState().overlayRunIds.size).toBe(0);
    expect(toastInfoMock).toHaveBeenCalledWith('Overlay cleared');
    expect(screen.queryByTestId('history-drawer-toast')).toBeNull();
  });

  it('delete row fires toast.info "Run deleted from history"', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-run-row-delete-r1'));
    expect(toastInfoMock).toHaveBeenCalledWith('Run deleted from history');
    expect(useRunsStore.getState().runs.r1).toBeUndefined();
  });

  it('says that a run can be renamed, and that Reset run keeps its run in the list', () => {
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    const text = screen.getByText(/Rename a run with its pencil/).textContent ?? '';
    expect(text).toContain('plot legend');
    expect(text).toContain('Reset run in the top bar reloads the case but keeps its run here');
    expect(text).not.toContain('drops the active run');
    // The cap is stated with its real value, and where to change it.
    expect(text).toContain(`up to ${DEFAULT_RETENTION_LIMIT} runs`);
    expect(text).toContain('Retention, in the TDS tab');
    // A run you pinned or named is not what the cap pushes out.
    expect(text).toContain('neither pinned nor named');
    expect(text).toContain('Clear runs deletes every finished run but the active one');
  });

  it('explains in the empty list that a run stays after Reset run', () => {
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    expect(screen.getByTestId('history-drawer-empty')).toHaveTextContent(
      'A run stays here after Reset run in the top bar until you delete it.',
    );
  });

  describe('a run Reset run has released', () => {
    it('stays in the list, marked earlier, and a new run is the active one', () => {
      seedRun('r1');
      useRunsStore.getState().setRunDisplayName('r1', 'No fault');
      // What Reset run does to the runs once the case is reloaded.
      useRunsStore.getState().clearActiveRun();
      useHistoryStore.getState().openDrawer();
      render(<HistoryDrawer />);

      expect(screen.queryByTestId('history-drawer-empty')).toBeNull();
      expect(screen.getByTestId('history-run-row-label-r1')).toHaveTextContent('No fault');
      expect(screen.getByTestId('history-run-row-earlier-badge-r1')).toBeInTheDocument();
      expect(screen.queryByTestId('history-run-row-active-badge-r1')).toBeNull();

      act(() => {
        useRunsStore.getState().startRun({ runId: 'r2', tf: 5, columnNames: ['Bus_1_v'] });
      });
      expect(screen.getByTestId('history-run-row-label-r2')).toHaveTextContent('TDS #2');
      expect(screen.getByTestId('history-run-row-active-badge-r2')).toBeInTheDocument();
      expect(screen.getByTestId('history-run-row-earlier-badge-r1')).toBeInTheDocument();
    });
  });

  describe('Clear runs', () => {
    function openWithRuns(...ids: string[]) {
      for (const id of ids) seedRun(id);
      useHistoryStore.getState().openDrawer();
      render(<HistoryDrawer />);
    }

    it('asks first, and deletes every finished run but the active one once confirmed', async () => {
      const user = userEvent.setup();
      openWithRuns('r1', 'r2', 'r3');
      useRunsStore.getState().addOverlayRun('r2');

      await user.click(screen.getByTestId('history-drawer-clear-runs'));
      // Nothing is deleted by the first click.
      expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(3);
      // r3 is the active run, the one the top bar's Reset run is for.
      expect(screen.getByTestId('history-drawer-clear-runs-prompt')).toHaveTextContent(
        'Delete 2 finished runs?',
      );

      await user.click(screen.getByTestId('history-drawer-clear-runs-confirm'));
      expect(Object.keys(useRunsStore.getState().runs)).toEqual(['r3']);
      expect(useRunsStore.getState().activeRunId).toBe('r3');
      expect(useRunsStore.getState().overlayRunIds.size).toBe(0);
      expect(toastInfoMock).toHaveBeenCalledWith('2 runs deleted from history');
      expect(screen.getByTestId('history-run-row-active-badge-r3')).toBeInTheDocument();
    });

    it('deletes the run Reset run released along with the rest', async () => {
      const user = userEvent.setup();
      openWithRuns('r1', 'r2');
      expect(screen.getByTestId('history-drawer-clear-runs')).toBeEnabled();

      // What Reset run does once the case is reloaded: r2 is no longer the active run.
      act(() => {
        useRunsStore.getState().clearActiveRun();
      });
      await user.click(screen.getByTestId('history-drawer-clear-runs'));
      expect(screen.getByTestId('history-drawer-clear-runs-prompt')).toHaveTextContent(
        'Delete 2 finished runs?',
      );
      await user.click(screen.getByTestId('history-drawer-clear-runs-confirm'));

      expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(0);
      expect(screen.getByTestId('history-drawer-empty')).toBeInTheDocument();
    });

    it('is off when the only finished run is the active one, and says why', () => {
      openWithRuns('r1');
      const button = screen.getByTestId('history-drawer-clear-runs');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', expect.stringContaining('The active run stays'));
      expect(button).toHaveAttribute('title', expect.stringContaining('Reset run'));
    });

    it('Keep leaves the runs alone and puts the button back', async () => {
      const user = userEvent.setup();
      openWithRuns('r1', 'r2', 'r3');

      await user.click(screen.getByTestId('history-drawer-clear-runs'));
      await user.click(screen.getByTestId('history-drawer-clear-runs-cancel'));

      expect(Object.keys(useRunsStore.getState().runs)).toHaveLength(3);
      expect(screen.queryByTestId('history-drawer-clear-runs-prompt')).toBeNull();
      expect(screen.getByTestId('history-drawer-clear-runs')).toBeEnabled();
    });

    it('is off when there is no finished run, and spares a run that is still streaming', async () => {
      const user = userEvent.setup();
      useRunsStore.getState().startRun({ runId: 'live', tf: 5, columnNames: ['Bus_1_v'] });
      useHistoryStore.getState().openDrawer();
      render(<HistoryDrawer />);
      expect(screen.getByTestId('history-drawer-clear-runs')).toBeDisabled();

      // One run finishes while another starts: only the finished one is offered.
      act(() => {
        useRunsStore.getState().markRunDone('live', 5);
        useRunsStore.getState().startRun({ runId: 'next', tf: 5, columnNames: ['Bus_1_v'] });
      });
      await user.click(screen.getByTestId('history-drawer-clear-runs'));
      expect(screen.getByTestId('history-drawer-clear-runs-prompt')).toHaveTextContent(
        'Delete 1 finished run?',
      );
      await user.click(screen.getByTestId('history-drawer-clear-runs-confirm'));

      expect(Object.keys(useRunsStore.getState().runs)).toEqual(['next']);
      expect(toastInfoMock).toHaveBeenCalledWith('1 run deleted from history');
    });

    it('is not shown on the job views, which have no runs to clear', async () => {
      const user = userEvent.setup();
      openWithRuns('r1');
      await user.selectOptions(screen.getByTestId('history-drawer-kind-filter'), 'all');
      expect(screen.queryByTestId('history-drawer-clear-runs')).toBeNull();
    });
  });

  it('renaming a run from its row names it and confirms with a toast', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-run-row-rename-r1'));
    await user.type(
      screen.getByTestId('history-run-row-name-input-r1'),
      'Baseline no fault{Enter}',
    );
    expect(useRunsStore.getState().runs.r1!.displayName).toBe('Baseline no fault');
    expect(screen.getByTestId('history-run-row-label-r1')).toHaveTextContent('Baseline no fault');
    expect(toastInfoMock).toHaveBeenCalledWith('Run renamed to "Baseline no fault"');
  });

  it('clearing a name confirms with a toast and brings back the default label', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useRunsStore.getState().setRunDisplayName('r1', 'Old name');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-run-row-rename-r1'));
    await user.clear(screen.getByTestId('history-run-row-name-input-r1'));
    await user.keyboard('{Enter}');
    expect(toastInfoMock).toHaveBeenCalledWith('Run name cleared');
    expect(screen.getByTestId('history-run-row-label-r1')).toHaveTextContent('TDS #1');
  });

  it("opens with the run's name ready to type when the Rename run command asks", () => {
    seedRun('r1');
    seedRun('r2');
    useHistoryStore.getState().startRenaming('r1');
    render(<HistoryDrawer />);
    const input = screen.getByTestId('history-run-row-name-input-r1');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByTestId('history-run-row-name-input-r2')).toBeNull();
  });

  it('Escape in the name field cancels the rename and leaves the drawer open', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useHistoryStore.getState().startRenaming('r1');
    render(<HistoryDrawer />);
    await user.type(screen.getByTestId('history-run-row-name-input-r1'), 'Dropped');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('history-run-row-name-input-r1')).toBeNull();
    expect(useRunsStore.getState().runs.r1!.displayName).toBeUndefined();
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
    expect(screen.getByTestId('history-drawer')).toBeInTheDocument();
    // With no field open, Escape closes the drawer as it always did.
    await user.keyboard('{Escape}');
    expect(useHistoryStore.getState().drawerOpen).toBe(false);
  });

  it('Clear overlay button is disabled when nothing is pinned', () => {
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    const btn = screen.getByTestId('history-drawer-clear-overlay') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ---- Unit 12: kind-filter + generalised job history ---------------------

  it('default "Runs" filter still renders TDS runs with scrub/overlay controls', () => {
    // Regression guard: the default filter must keep the existing TDS-only
    // behaviour — run rows with the pin (overlay) + delete (scrub-adjacent)
    // affordances, sourced from useRunsStore unchanged.
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    expect(useLayoutStore.getState().historyKindFilter).toBe('runs');
    expect(screen.getByTestId('history-run-row-r1')).toBeInTheDocument();
    expect(screen.getByTestId('history-run-row-pin-r1')).toBeInTheDocument();
    expect(screen.getByTestId('history-run-row-delete-r1')).toBeInTheDocument();
  });

  it('"All jobs" view renders PF/EIG/CPF/SE jobs as simple rows', async () => {
    const user = userEvent.setup();
    seedJob('j-pf', 'pflow');
    seedJob('j-eig', 'eig');
    seedJob('j-cpf', 'cpf');
    seedJob('j-se', 'se');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);

    await user.selectOptions(screen.getByTestId('history-drawer-kind-filter'), 'all');

    expect(screen.getByTestId('history-job-row-j-pf')).toBeInTheDocument();
    expect(screen.getByTestId('history-job-row-j-eig')).toBeInTheDocument();
    expect(screen.getByTestId('history-job-row-j-cpf')).toBeInTheDocument();
    expect(screen.getByTestId('history-job-row-j-se')).toBeInTheDocument();
    // Simple rows have no pin/reset (overlay) affordances.
    expect(screen.queryByTestId('history-run-row-pin-j-pf')).toBeNull();
  });

  it('a concrete kind filter narrows the job list to that kind', async () => {
    const user = userEvent.setup();
    seedJob('j-pf', 'pflow');
    seedJob('j-eig', 'eig');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);

    await user.selectOptions(screen.getByTestId('history-drawer-kind-filter'), 'eig');

    expect(screen.getByTestId('history-job-row-j-eig')).toBeInTheDocument();
    expect(screen.queryByTestId('history-job-row-j-pf')).toBeNull();
  });

  it('a TDS-stream job with a live RunRecord keeps the rich run row in the All view', async () => {
    const user = userEvent.setup();
    // run_id aliases job_id (Unit 5c): the join is runId === job.id.
    seedRun('tds-run-1');
    seedJob('tds-run-1', 'tds-stream');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);

    await user.selectOptions(screen.getByTestId('history-drawer-kind-filter'), 'all');

    // Joined to the RunRecord → renders the rich HistoryRunRow (with pin),
    // NOT the simple HistoryJobRow.
    expect(screen.getByTestId('history-run-row-tds-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('history-run-row-pin-tds-run-1')).toBeInTheDocument();
    expect(screen.queryByTestId('history-job-row-tds-run-1')).toBeNull();
  });

  it('a failed non-run job shows a "View error" button that opens the error modal', async () => {
    const user = userEvent.setup();
    seedJob('j-fail', 'pflow', 'failed');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);

    await user.selectOptions(screen.getByTestId('history-drawer-kind-filter'), 'all');
    await user.click(screen.getByTestId('history-job-row-view-error-j-fail'));

    expect(screen.getByTestId('history-drawer-error-modal')).toBeInTheDocument();
  });

  it('the kind filter persists to localStorage', async () => {
    const user = userEvent.setup();
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);

    await user.selectOptions(screen.getByTestId('history-drawer-kind-filter'), 'all');

    expect(useLayoutStore.getState().historyKindFilter).toBe('all');
    const persisted = localStorage.getItem('tensa:layout-v1');
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!).state.historyKindFilter).toBe('all');
  });
});
