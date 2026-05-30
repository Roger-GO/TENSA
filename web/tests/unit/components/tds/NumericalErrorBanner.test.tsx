/**
 * Tests for `<NumericalErrorBanner />`.
 *
 * Verifies the visibility-state machine driven by the active run:
 *
 * - hidden when no run, when state === 'done' + tCurrent >= tf, or when
 *   the run was aborted locally;
 * - shown when state === 'error' OR (state === 'done' + tCurrent < tf +
 *   abortedLocally === false);
 * - dismiss is per-run (a fresh runId re-shows the banner).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumericalErrorBanner } from '@/components/tds/NumericalErrorBanner';
import { useRunsStore, DEFAULT_MEMORY_BUDGET_BYTES } from '@/store/runs';
import type { RunRecord } from '@/store/runs';

function seedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
    runId: 'run-1',
    startedAt: 1000,
    tf: 5,
    tCurrent: 0,
    seqCount: 0,
    t: new Float64Array(0),
    columns: {},
    columnNames: [],
    state: 'streaming',
    connection: 'connected',
    abortedLocally: false,
    errorReason: null,
    ...overrides,
  };
  useRunsStore.setState({
    runs: { [base.runId]: base },
    activeRunId: base.runId,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  });
  return base;
}

function clearRuns() {
  useRunsStore.setState({
    runs: {},
    activeRunId: null,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  });
}

describe('<NumericalErrorBanner />', () => {
  beforeEach(clearRuns);
  afterEach(clearRuns);

  it('renders nothing when no active run', () => {
    render(<NumericalErrorBanner />);
    expect(screen.queryByTestId('numerical-error-banner')).not.toBeInTheDocument();
  });

  it('renders nothing when the run is still streaming', () => {
    seedRun({ state: 'streaming', tCurrent: 1 });
    render(<NumericalErrorBanner />);
    expect(screen.queryByTestId('numerical-error-banner')).not.toBeInTheDocument();
  });

  it('renders nothing when the run completed cleanly (tCurrent >= tf)', () => {
    seedRun({ state: 'done', tCurrent: 5, tf: 5 });
    render(<NumericalErrorBanner />);
    expect(screen.queryByTestId('numerical-error-banner')).not.toBeInTheDocument();
  });

  it('renders nothing when the run was aborted locally (badge handles it)', () => {
    seedRun({ state: 'done', tCurrent: 2, tf: 5, abortedLocally: true });
    render(<NumericalErrorBanner />);
    expect(screen.queryByTestId('numerical-error-banner')).not.toBeInTheDocument();
  });

  it('renders the banner when state === "error"', () => {
    seedRun({ state: 'error', errorReason: 'numerical instability' });
    render(<NumericalErrorBanner />);
    expect(screen.getByTestId('numerical-error-banner')).toBeInTheDocument();
  });

  it('renders the banner when state === "done" with final_t < tf and !abortedLocally', () => {
    seedRun({ state: 'done', tCurrent: 1.2, tf: 5, abortedLocally: false });
    render(<NumericalErrorBanner />);
    const banner = screen.getByTestId('numerical-error-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/halted at t=1\.20s/);
  });

  it('toggles the details slide-out on "View details" click', async () => {
    seedRun({ state: 'error', errorReason: 'newton diverged' });
    render(<NumericalErrorBanner />);
    expect(screen.queryByTestId('numerical-error-details')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('numerical-error-toggle'));
    expect(screen.getByTestId('numerical-error-details')).toBeInTheDocument();
    expect(screen.getByTestId('numerical-error-details')).toHaveTextContent(/newton diverged/);
    await userEvent.click(screen.getByTestId('numerical-error-toggle'));
    expect(screen.queryByTestId('numerical-error-details')).not.toBeInTheDocument();
  });

  it('renders via the primitive; the t_current detail flows through the formatter into the grid', async () => {
    seedRun({ state: 'error', tCurrent: 2.345, tf: 5, seqCount: 47 });
    render(<NumericalErrorBanner />);
    // The migrated wrapper renders the primitive's banner surface.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('numerical-error-toggle'));
    const details = screen.getByTestId('numerical-error-details');
    // The EXACT pre-migration formatting (toFixed(4)) survives the formatter.
    expect(details).toHaveTextContent(/2\.3450 s/);
    expect(details).toHaveTextContent(/5\.0000 s/);
    expect(details).toHaveTextContent(/47/);
  });

  it('hides the banner after Dismiss; per-run, so a new run re-shows it', async () => {
    seedRun({ runId: 'run-A', state: 'error' });
    const { rerender } = render(<NumericalErrorBanner />);
    await userEvent.click(screen.getByTestId('numerical-error-dismiss'));
    expect(screen.queryByTestId('numerical-error-banner')).not.toBeInTheDocument();

    // Same run — still hidden.
    rerender(<NumericalErrorBanner />);
    expect(screen.queryByTestId('numerical-error-banner')).not.toBeInTheDocument();

    // New run id → re-shows.
    seedRun({ runId: 'run-B', state: 'error' });
    rerender(<NumericalErrorBanner />);
    expect(screen.getByTestId('numerical-error-banner')).toBeInTheDocument();
  });
});
