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

  it('renders the new plottable groups (gen_power, load_pq) + bus angle when present', () => {
    seedRun('r1', [
      'Bus_1_v',
      'Bus_1_a',
      'Gen_1_omega',
      'Gen_1_Pe',
      'Gen_1_Qe',
      'Line_2_p',
      'Line_2_q',
      'Load_3_p',
      'Load_3_q',
    ]);
    render(<VariableTreePicker />);
    expect(screen.getByTestId('variable-tree-picker-group-bus_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-group-gen_state')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-group-gen_power')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-group-line_flow')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-group-load_pq')).toBeInTheDocument();
  });

  it('groups render in the canonical order bus_v → gen_state → gen_power → line_flow → load_pq', () => {
    seedRun('r1', ['Load_3_p', 'Line_2_p', 'Gen_1_Pe', 'Gen_1_omega', 'Bus_1_v']);
    render(<VariableTreePicker />);
    const order = [
      'variable-tree-picker-group-bus_v',
      'variable-tree-picker-group-gen_state',
      'variable-tree-picker-group-gen_power',
      'variable-tree-picker-group-line_flow',
      'variable-tree-picker-group-load_pq',
    ];
    const rendered = order.map((id) => screen.getByTestId(id));
    // Each subsequent group's checkbox should follow the previous one in
    // document order.
    for (let i = 1; i < rendered.length; i += 1) {
      const prev = rendered[i - 1]!;
      const cur = rendered[i]!;
      expect(prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('separates Gen_<n>_Pe/Qe (gen_power) from Gen_<n>_omega/delta (gen_state)', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Gen_1_omega', 'Gen_1_delta', 'Gen_1_Pe', 'Gen_1_Qe']);
    usePlotStore.getState().toggleExpanded('r1', 'gen_state');
    usePlotStore.getState().toggleExpanded('r1', 'gen_power');
    render(<VariableTreePicker />);
    // gen_state leaves are the rotor speed/angle.
    expect(screen.getByTestId('variable-tree-picker-leaf-Gen_1_omega')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Gen_1_delta')).toBeInTheDocument();
    // gen_power leaves are the electrical power columns.
    expect(screen.getByTestId('variable-tree-picker-leaf-Gen_1_Pe')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Gen_1_Qe')).toBeInTheDocument();
    // Selecting the whole gen_power group must not pull in gen_state leaves.
    await user.click(screen.getByTestId('variable-tree-picker-group-gen_power'));
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel.has('Gen_1_Pe')).toBe(true);
    expect(sel.has('Gen_1_Qe')).toBe(true);
    expect(sel.has('Gen_1_omega')).toBe(false);
    expect(sel.has('Gen_1_delta')).toBe(false);
  });

  it('groups bus voltage + angle under the same bus element', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_1_a']);
    usePlotStore.getState().toggleExpanded('r1', 'bus_v');
    render(<VariableTreePicker />);
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_1_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_1_a')).toBeInTheDocument();
    // The element checkbox toggles both v + a for bus 1.
    await user.click(screen.getByTestId('variable-tree-picker-element-bus_v-1'));
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel.has('Bus_1_v')).toBe(true);
    expect(sel.has('Bus_1_a')).toBe(true);
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
    // The bus_v group label is now "Bus voltage / angle" (the group carries
    // both Bus_<idx>_v and Bus_<idx>_a). The numeric-sort intent is unchanged.
    const elementCheckboxes = screen.getAllByLabelText(/Toggle Bus voltage \/ angle element/);
    const labels = elementCheckboxes.map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Toggle Bus voltage / angle element 1',
      'Toggle Bus voltage / angle element 2',
      'Toggle Bus voltage / angle element 5',
      'Toggle Bus voltage / angle element 15',
    ]);
  });
});
