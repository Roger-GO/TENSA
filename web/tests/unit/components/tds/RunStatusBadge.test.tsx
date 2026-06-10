/**
 * Tests for `<RunStatusBadge />`.
 *
 * The badge is purely a function of the runs slice — no fetch, no router,
 * no provider. Each test seeds ``useRunsStore`` directly and asserts on
 * the rendered label / dataset attributes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunStatusBadge } from '@/components/tds/RunStatusBadge';
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
    state: 'starting',
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

describe('<RunStatusBadge />', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
  });

  afterEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
  });

  it('renders nothing when no active run', () => {
    render(<RunStatusBadge />);
    expect(screen.queryByTestId('tds-run-status-badge')).not.toBeInTheDocument();
  });

  it('shows "Starting…" while the run is in the starting state', () => {
    seedRun({ state: 'starting' });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/starting/i);
  });

  it('shows "Streaming… t=…" while streaming', () => {
    seedRun({ state: 'streaming', tCurrent: 1.234 });
    render(<RunStatusBadge />);
    const badge = screen.getByTestId('tds-run-status-badge');
    expect(badge).toHaveTextContent(/streaming/i);
    expect(badge).toHaveTextContent(/1\.23/);
  });

  it('shows "Done at t=…" when done', () => {
    seedRun({ state: 'done', tCurrent: 5 });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/done/i);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/5\.00/);
  });

  it('keeps the success "Done" treatment for converged runs', () => {
    seedRun({ state: 'done', tCurrent: 10, converged: true });
    render(<RunStatusBadge />);
    const badge = screen.getByTestId('tds-run-status-badge');
    expect(badge).toHaveTextContent(/done at t=10\.00/i);
    expect(badge.className).toContain('success');
  });

  it('shows "Halted at t=…" with warning tone when done but not converged', () => {
    seedRun({ state: 'done', tCurrent: 6.34, tf: 10, converged: false });
    render(<RunStatusBadge />);
    const badge = screen.getByTestId('tds-run-status-badge');
    expect(badge).toHaveTextContent(/halted at t=6\.34/i);
    expect(badge).not.toHaveTextContent(/done/i);
    expect(badge.className).toContain('warning');
    // Default tooltip explains the early stop relative to the requested tf.
    expect(badge.getAttribute('title')).toContain('tf=10');
  });

  it('halted badge tooltip prefers the recorded error reason when present', () => {
    seedRun({
      state: 'done',
      tCurrent: 6.34,
      tf: 10,
      converged: false,
      errorReason: 'numerical instability',
    });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveAttribute(
      'title',
      'numerical instability',
    );
  });

  it('shows "Aborted at t=…" when aborted', () => {
    seedRun({ state: 'aborted', tCurrent: 2.5 });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/aborted/i);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/2\.50/);
  });

  it('shows "Error" on error state', () => {
    seedRun({ state: 'error', errorReason: 'numerical instability' });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/error/i);
  });

  it('connection "reconnecting" wins over the run state', () => {
    seedRun({ state: 'streaming', connection: 'reconnecting' });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/reconnecting/i);
  });

  it('connection "lagged" wins over the run state', () => {
    seedRun({ state: 'streaming', connection: 'lagged' });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/lagged/i);
  });

  it('connection "disconnected" surfaces destructive tone', () => {
    seedRun({ state: 'streaming', connection: 'disconnected' });
    render(<RunStatusBadge />);
    expect(screen.getByTestId('tds-run-status-badge')).toHaveTextContent(/disconnected/i);
  });

  it('exposes data-state and data-connection for assertion-friendly hooks', () => {
    seedRun({ state: 'streaming', connection: 'reconnecting' });
    render(<RunStatusBadge />);
    const badge = screen.getByTestId('tds-run-status-badge');
    expect(badge).toHaveAttribute('data-state', 'streaming');
    expect(badge).toHaveAttribute('data-connection', 'reconnecting');
  });
});
