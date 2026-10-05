/**
 * `<KeptResultsNote />`: what the page shown before a case is opened says of
 * the results the browser kept, so that a reload does not read as a loss.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KeptResultsNote } from '@/components/history/KeptResultsNote';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';
import { NO_ELEMENT_NAMES } from '@/lib/elementNames';
import { useHistoryStore } from '@/store/history';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { useRunsStore } from '@/store/runs';

function reset(): void {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useHistoryStore.getState().reset();
  useRunsStore.getState().clearRuns();
  usePflowHistoryStore.getState().clear();
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

function seedKeptPflow(id: string): void {
  const result: PflowResult = {
    run_id: parseRunId(id),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.0 },
    bus_angles: { '1': 0 },
    line_flows: {},
  };
  usePflowHistoryStore
    .getState()
    .record(result, { caseName: 'kundur_full', names: NO_ELEMENT_NAMES });
}

describe('<KeptResultsNote />', () => {
  it('draws nothing when the browser kept nothing', () => {
    const { container } = render(<KeptResultsNote />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the runs and the power flows kept, each with a way to them', () => {
    seedKeptRun('kept-1');
    seedKeptPflow('pf-1');
    seedKeptPflow('pf-2');
    render(<KeptResultsNote />);
    expect(screen.getByTestId('kept-results-note')).toHaveTextContent(
      'Kept in this browser: 1 time-domain run and 2 power flows. A reload does not lose them, and they open without a case.',
    );
    expect(screen.getByRole('button', { name: 'Open run history' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the Compare tab' })).toBeInTheDocument();
  });

  it('with runs only, offers the run history alone', () => {
    seedKeptRun('kept-1');
    seedKeptRun('kept-2');
    render(<KeptResultsNote />);
    expect(screen.getByTestId('kept-results-note')).toHaveTextContent(
      'Kept in this browser: 2 time-domain runs.',
    );
    expect(screen.getByTestId('kept-results-open-history')).toBeInTheDocument();
    expect(screen.queryByTestId('kept-results-open-compare')).not.toBeInTheDocument();
  });

  it('with power flows only, offers the Compare tab alone', () => {
    seedKeptPflow('pf-1');
    render(<KeptResultsNote />);
    expect(screen.getByTestId('kept-results-note')).toHaveTextContent(
      'Kept in this browser: 1 power flow.',
    );
    expect(screen.queryByTestId('kept-results-open-history')).not.toBeInTheDocument();
    expect(screen.getByTestId('kept-results-open-compare')).toBeInTheDocument();
  });

  it('Open run history opens the drawer on its runs', async () => {
    const user = userEvent.setup();
    seedKeptRun('kept-1');
    useLayoutStore.setState({ historyKindFilter: 'all' });
    render(<KeptResultsNote />);
    await user.click(screen.getByTestId('kept-results-open-history'));
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
    expect(useLayoutStore.getState().historyKindFilter).toBe('runs');
  });

  it('Open the Compare tab brings the comparison into view, with the drawer open', async () => {
    const user = userEvent.setup();
    seedKeptPflow('pf-1');
    useLayoutStore.setState({ bottomDrawerCollapsed: true, activeBottomDrawerTab: 'buses' });
    render(<KeptResultsNote />);
    await user.click(screen.getByTestId('kept-results-open-compare'));
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('compare');
    expect(layout.bottomDrawerCollapsed).toBe(false);
  });
});
