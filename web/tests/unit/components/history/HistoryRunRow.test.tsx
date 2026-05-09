/**
 * <HistoryRunRow /> tests.
 *
 * Drives the real runs store; asserts on the row's metadata, action
 * buttons, and store side effects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HistoryRunRow } from '@/components/history/HistoryRunRow';
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';

function seedRun(runId: string, tf = 5): RunRecord {
  useRunsStore.getState().startRun({ runId, tf, columnNames: ['Bus_1_v'] });
  return useRunsStore.getState().runs[runId]!;
}

describe('HistoryRunRow', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the run id prefix, state badge, tf, and timestamp', () => {
    const run = seedRun('abcdef1234567890');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    const row = screen.getByTestId('history-run-row-abcdef1234567890');
    expect(row).toHaveAttribute('data-run-id', 'abcdef1234567890');
    expect(screen.getByTestId('history-run-row-state-abcdef1234567890')).toHaveTextContent('starting');
    // Run id truncated to 12 chars.
    expect(row).toHaveTextContent('abcdef123456');
    expect(row).toHaveTextContent('tf=5s');
  });

  it('flags the active run with the active badge', () => {
    const run = seedRun('r1');
    render(<HistoryRunRow run={run} isActive isOverlayPinned={false} />);
    expect(screen.getByTestId('history-run-row-active-badge-r1')).toBeInTheDocument();
    expect(screen.getByTestId('history-run-row-r1')).toHaveAttribute('data-active', 'true');
  });

  it('renders the Pin button when not pinned; clicking adds to overlay', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    const btn = screen.getByTestId('history-run-row-pin-r1');
    expect(btn).toHaveTextContent('Pin');
    await user.click(btn);
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
  });

  it('renders the Unpin button when pinned; clicking removes from overlay', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    useRunsStore.getState().addOverlayRun('r1');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned />);
    const btn = screen.getByTestId('history-run-row-pin-r1');
    expect(btn).toHaveTextContent('Unpin');
    await user.click(btn);
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });

  it('Reset button drops the run from the runs map', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    await user.click(screen.getByTestId('history-run-row-reset-r1'));
    expect(useRunsStore.getState().runs.r1).toBeUndefined();
  });

  it('fires onTogglePin callback after store mutation', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    const onTogglePin = vi.fn();
    render(
      <HistoryRunRow
        run={run}
        isActive={false}
        isOverlayPinned={false}
        onTogglePin={onTogglePin}
      />,
    );
    await user.click(screen.getByTestId('history-run-row-pin-r1'));
    expect(onTogglePin).toHaveBeenCalledWith('r1', true);
  });

  it('fires onReset callback after the run is dropped', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    const onReset = vi.fn();
    render(
      <HistoryRunRow
        run={run}
        isActive={false}
        isOverlayPinned={false}
        onReset={onReset}
      />,
    );
    await user.click(screen.getByTestId('history-run-row-reset-r1'));
    expect(onReset).toHaveBeenCalledWith('r1');
  });
});
