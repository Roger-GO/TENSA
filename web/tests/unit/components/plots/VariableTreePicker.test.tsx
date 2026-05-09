/**
 * <VariableTreePicker /> tests.
 *
 * Drives the real plot + runs stores; asserts on the rendered tree
 * structure, the tri-state checkbox math (parent toggles all children;
 * partial-checked when only some children are selected), and the
 * filter behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VariableTreePicker } from '@/components/plots/VariableTreePicker';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';

function seedRun(runId: string, columnNames: string[]) {
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useRunsStore.getState().startRun({ runId, tf: 10, columnNames });
}

describe('VariableTreePicker', () => {
  beforeEach(() => {
    useRunsStore.setState({ runs: {}, activeRunId: null });
    usePlotStore.setState({ selectedByRun: {}, filterByRun: {}, expandedByRun: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the empty state when no run is active', () => {
    render(<VariableTreePicker />);
    expect(screen.getByTestId('variable-tree-picker-empty')).toHaveTextContent('Run a TDS');
  });

  it('shows only groups that are present in the active run', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega']);
    render(<VariableTreePicker />);
    expect(screen.getByTestId('variable-tree-picker-group-bus_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-group-gen_state')).toBeInTheDocument();
    expect(screen.queryByTestId('variable-tree-picker-group-line_flow')).toBeNull();
  });

  it('expanding a group reveals element + leaf rows', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_5_v']);
    render(<VariableTreePicker />);
    expect(screen.queryByTestId('variable-tree-picker-leaf-Bus_1_v')).toBeNull();
    await user.click(screen.getByTestId('variable-tree-picker-expand-bus_v'));
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_1_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeInTheDocument();
  });

  it('clicking a leaf checkbox toggles only that series in the plot store', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_5_v']);
    usePlotStore.getState().toggleExpanded('r1', 'bus_v');
    render(<VariableTreePicker />);
    await user.click(screen.getByTestId('variable-tree-picker-leaf-Bus_5_v'));
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel.has('Bus_5_v')).toBe(true);
    expect(sel.has('Bus_1_v')).toBe(false);
  });

  it('clicking the group checkbox selects all leaves underneath', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Bus_7_v']);
    render(<VariableTreePicker />);
    await user.click(screen.getByTestId('variable-tree-picker-group-bus_v'));
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel.size).toBe(3);
    expect(sel.has('Bus_1_v')).toBe(true);
    expect(sel.has('Bus_5_v')).toBe(true);
    expect(sel.has('Bus_7_v')).toBe(true);
  });

  it('group checkbox shows partial state when only some children selected', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Bus_7_v']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<VariableTreePicker />);
    const cb = screen.getByTestId('variable-tree-picker-group-bus_v') as HTMLInputElement;
    expect(cb.indeterminate).toBe(true);
    expect(cb.checked).toBe(false);
    expect(cb.getAttribute('aria-checked')).toBe('mixed');
  });

  it('group checkbox toggles off when all children are already selected', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_5_v']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_5_v']));
    render(<VariableTreePicker />);
    await user.click(screen.getByTestId('variable-tree-picker-group-bus_v'));
    expect(usePlotStore.getState().selectedByRun['r1']!.size).toBe(0);
  });

  it('element checkbox toggles all series under that element', async () => {
    const user = userEvent.setup();
    // Two series under one element, plus one under another.
    seedRun('r1', ['Gen_1_omega', 'Gen_1_delta', 'Gen_2_omega']);
    usePlotStore.getState().toggleExpanded('r1', 'gen_state');
    render(<VariableTreePicker />);
    await user.click(screen.getByTestId('variable-tree-picker-element-gen_state-1'));
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel.has('Gen_1_omega')).toBe(true);
    expect(sel.has('Gen_1_delta')).toBe(true);
    expect(sel.has('Gen_2_omega')).toBe(false);
  });

  it('filters the tree by substring match', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Bus_15_v', 'Gen_1_omega']);
    usePlotStore.getState().toggleExpanded('r1', 'bus_v');
    render(<VariableTreePicker />);
    // Sanity: all bus leaves visible before filter.
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_1_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_15_v')).toBeInTheDocument();
    await user.type(screen.getByTestId('variable-tree-picker-filter'), 'Bus_5');
    // Only Bus_5_v matches the literal "Bus_5" substring.
    expect(screen.queryByTestId('variable-tree-picker-leaf-Bus_1_v')).toBeNull();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeInTheDocument();
    expect(screen.queryByTestId('variable-tree-picker-leaf-Bus_15_v')).toBeNull();
    // gen_state group not in the filter result either.
    expect(screen.queryByTestId('variable-tree-picker-group-gen_state')).toBeNull();
  });

  it('clearing the filter restores the full tree', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega']);
    usePlotStore.getState().setFilter('r1', 'Bus_5');
    render(<VariableTreePicker />);
    expect(screen.queryByTestId('variable-tree-picker-group-gen_state')).toBeNull();
    await user.clear(screen.getByTestId('variable-tree-picker-filter'));
    expect(screen.getByTestId('variable-tree-picker-group-gen_state')).toBeInTheDocument();
  });

  it('shows the no-matches message when the filter excludes every series', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Gen_1_omega']);
    render(<VariableTreePicker />);
    await user.type(screen.getByTestId('variable-tree-picker-filter'), 'nonexistent');
    expect(screen.getByTestId('variable-tree-picker-no-matches')).toBeInTheDocument();
  });

  it('header counter reflects the selected-series count', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_5_v']));
    render(<VariableTreePicker />);
    expect(screen.getByTestId('variable-tree-picker-count')).toHaveTextContent('2 selected');
  });

  it('sorts numeric element ids numerically (1, 2, 5, 15) instead of lexicographically', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_15_v', 'Bus_2_v', 'Bus_5_v']);
    usePlotStore.getState().toggleExpanded('r1', 'bus_v');
    render(<VariableTreePicker />);
    const elementCheckboxes = screen.getAllByLabelText(/Toggle Bus voltages element/);
    const labels = elementCheckboxes.map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Toggle Bus voltages element 1',
      'Toggle Bus voltages element 2',
      'Toggle Bus voltages element 5',
      'Toggle Bus voltages element 15',
    ]);
  });
});
