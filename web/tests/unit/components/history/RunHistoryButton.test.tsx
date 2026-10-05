/**
 * `<RunHistoryButton />`: the button beside the plot and in the Activity tab
 * that opens the run history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RunHistoryButton } from '@/components/history/RunHistoryButton';
import { useHistoryStore } from '@/store/history';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useRunsStore } from '@/store/runs';

function reset(): void {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useHistoryStore.getState().reset();
  useRunsStore.getState().clearRuns();
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

function seedKeptRun(runId: string): void {
  useRunsStore.getState().startRun({ runId, tf: 1, columnNames: ['Bus_1_v'] });
  useRunsStore.getState().markRunDone(runId, 1, true);
  useRunsStore.getState().clearActiveRun();
}

describe('<RunHistoryButton />', () => {
  it('reads "Run history" and says on hover that the runs are kept across a reload', () => {
    render(<RunHistoryButton testId="here" />);
    const button = screen.getByTestId('here');
    expect(button).toHaveAccessibleName('Run history');
    expect(button).toHaveAttribute('title', expect.stringContaining('after the page is reloaded'));
    expect(button).toHaveAttribute('title', expect.stringContaining('Pin a run there to plot it'));
  });

  it('counts the runs, and follows them as they come and go', () => {
    seedKeptRun('kept-1');
    render(<RunHistoryButton testId="here" />);
    expect(screen.getByTestId('here')).toHaveAccessibleName('Run history (1)');

    act(() => seedKeptRun('kept-2'));
    expect(screen.getByTestId('here')).toHaveAccessibleName('Run history (2)');

    act(() => useRunsStore.getState().clearRuns());
    expect(screen.getByTestId('here')).toHaveAccessibleName('Run history');
  });

  it('opens the drawer on its runs', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ historyKindFilter: 'all' });
    render(<RunHistoryButton testId="here" />);
    await user.click(screen.getByTestId('here'));
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
    expect(useLayoutStore.getState().historyKindFilter).toBe('runs');
  });
});
