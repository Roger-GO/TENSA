/**
 * Tests for ``<PanelPickerTabs />`` (v0.2 Unit 8).
 *
 * The picker is a thin tablist driven by ``useUiStore`` with one cross-
 * cutting rule: while a TDS run is ``starting`` or ``streaming``, the
 * Disturbances tab is disabled (mid-run edits aren't possible per the
 * ANDES contract). All other tabs swap freely.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelPickerTabs } from '@/components/shell/PanelPickerTabs';
import { DEFAULT_TDS_CONFIG, useUiStore } from '@/store/ui';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore, DEFAULT_MEMORY_BUDGET_BYTES } from '@/store/runs';
import type { RunRecord, RunState } from '@/store/runs';

function resetStores() {
  useUiStore.setState({
    hideLabels: false,
    activeRightDockTopPanel: 'inspector',
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
  });
  useDisturbanceStore.setState({ disturbances: [] });
  useRunsStore.setState({
    runs: {},
    activeRunId: null,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  });
}

function seedRun(state: RunState): RunRecord {
  const run: RunRecord = {
    runId: 'run-1',
    startedAt: 0,
    tf: 10,
    tCurrent: 0,
    seqCount: 0,
    t: new Float64Array(0),
    columns: {},
    columnNames: [],
    state,
    connection: 'connected',
    abortedLocally: false,
    errorReason: null,
  };
  useRunsStore.setState({
    runs: { [run.runId]: run },
    activeRunId: run.runId,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  });
  return run;
}

describe('<PanelPickerTabs />', () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  it('renders four tabs in canonical order', () => {
    render(<PanelPickerTabs />);
    const tablist = screen.getByTestId('panel-picker-tabs');
    expect(tablist).toHaveAttribute('role', 'tablist');
    expect(screen.getByTestId('panel-picker-tab-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('panel-picker-tab-disturbance')).toBeInTheDocument();
    expect(screen.getByTestId('panel-picker-tab-plot')).toBeInTheDocument();
    expect(screen.getByTestId('panel-picker-tab-tds-config')).toBeInTheDocument();
  });

  it('Inspector is selected by default (matches v0.1)', () => {
    render(<PanelPickerTabs />);
    expect(screen.getByTestId('panel-picker-tab-inspector')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('panel-picker-tab-plot')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('clicking a tab updates the store and the selection state', async () => {
    const user = userEvent.setup();
    render(<PanelPickerTabs />);
    await user.click(screen.getByTestId('panel-picker-tab-plot'));
    expect(useUiStore.getState().activeRightDockTopPanel).toBe('plot');
    expect(screen.getByTestId('panel-picker-tab-plot')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('cycles through all four panels', async () => {
    const user = userEvent.setup();
    render(<PanelPickerTabs />);
    for (const id of ['disturbance', 'plot', 'tds-config', 'inspector'] as const) {
      await user.click(screen.getByTestId(`panel-picker-tab-${id}`));
      expect(useUiStore.getState().activeRightDockTopPanel).toBe(id);
    }
  });

  it('Disturbances tab is disabled while a TDS run is streaming', async () => {
    seedRun('streaming');
    const user = userEvent.setup();
    render(<PanelPickerTabs />);
    const dist = screen.getByTestId('panel-picker-tab-disturbance');
    expect(dist).toBeDisabled();
    expect(dist).toHaveAttribute('data-disabled', 'true');
    // Click is a no-op.
    await user.click(dist);
    expect(useUiStore.getState().activeRightDockTopPanel).toBe('inspector');
  });

  it('Disturbances tab is disabled during the starting phase as well', () => {
    seedRun('starting');
    render(<PanelPickerTabs />);
    expect(screen.getByTestId('panel-picker-tab-disturbance')).toBeDisabled();
  });

  it('Disturbances tab re-enables once the run terminates', () => {
    seedRun('done');
    render(<PanelPickerTabs />);
    expect(screen.getByTestId('panel-picker-tab-disturbance')).not.toBeDisabled();
  });

  it('Plot tab remains active even mid-run', async () => {
    seedRun('streaming');
    const user = userEvent.setup();
    render(<PanelPickerTabs />);
    await user.click(screen.getByTestId('panel-picker-tab-plot'));
    expect(useUiStore.getState().activeRightDockTopPanel).toBe('plot');
  });

  it('roving-tabindex pattern: inactive tabs have tabIndex=-1', () => {
    render(<PanelPickerTabs />);
    expect(screen.getByTestId('panel-picker-tab-inspector')).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByTestId('panel-picker-tab-plot')).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });
});
