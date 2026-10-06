/**
 * <VariableTreePicker /> tests.
 *
 * Drives the real plot + runs stores; asserts on the rendered tree
 * structure, the tri-state checkbox math (parent toggles all children;
 * partial-checked when only some children are selected), and the
 * filter behaviour.
 */
import { Profiler } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VariableTreePicker } from '@/components/plots/VariableTreePicker';
import { useRunsStore } from '@/store/runs';
import * as plotModule from '@/store/plot';
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

  it('auto-selects bus voltages when nothing has been selected yet', () => {
    // First time a run's columns appear, the picker pre-selects bus voltages
    // so the plot shows the headline result immediately instead of being empty.
    seedRun('r1', ['Bus_1_v', 'Bus_1_a', 'Bus_5_v', 'Gen_1_omega']);
    render(<VariableTreePicker />);
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel.has('Bus_1_v')).toBe(true);
    expect(sel.has('Bus_5_v')).toBe(true);
    // angle + non-voltage columns are NOT auto-selected
    expect(sel.has('Bus_1_a')).toBe(false);
    expect(sel.has('Gen_1_omega')).toBe(false);
  });

  it('offers the variables of a pinned run when no run is active, and picks its bus voltages', () => {
    // After Reset run, a case change or a reload of the page: runs to read, none active.
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega']);
    useRunsStore.getState().markRunDone('r1', 1);
    useRunsStore.getState().clearActiveRun();
    render(<VariableTreePicker />);
    expect(screen.getByTestId('variable-tree-picker-empty')).toBeInTheDocument();
    cleanup();

    useRunsStore.getState().addOverlayRun('r1');
    render(<VariableTreePicker />);

    expect(screen.queryByTestId('variable-tree-picker-empty')).toBeNull();
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect([...sel].sort()).toEqual(['Bus_1_v', 'Bus_5_v']);
  });

  it('clicking a leaf checkbox toggles only that series in the plot store', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_5_v']);
    // Opt out of the auto-select default by seeding an explicit empty selection.
    usePlotStore.getState().setSelection('r1', new Set());
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
    usePlotStore.getState().setSelection('r1', new Set());
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

  it('opens the groups that match a filter, so a search shows its findings', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_1_v', 'Bus_1_a', 'Bus_5_v', 'Gen_1_omega']);
    render(<VariableTreePicker />);
    // Groups start collapsed: no series to tick before searching.
    expect(screen.queryByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeNull();

    await user.type(screen.getByTestId('variable-tree-picker-filter'), 'Bus_5');

    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeInTheDocument();
    // The group cannot be collapsed under the search: its button says so and does nothing.
    const expand = screen.getByTestId('variable-tree-picker-expand-bus_v');
    expect(expand).toBeDisabled();
    expect(expand).toHaveAttribute('title', expect.stringMatching(/stay open while a filter/));

    // Back to what the user left: collapsed, and the button works again.
    await user.clear(screen.getByTestId('variable-tree-picker-filter'));
    expect(screen.queryByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeNull();
    expect(screen.getByTestId('variable-tree-picker-expand-bus_v')).toBeEnabled();
  });

  it('hints at a filter that finds something: the series are named Bus_5_v, not BUS5', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['Bus_5_v', 'Gen_1_omega']);
    render(<VariableTreePicker />);
    const filter = screen.getByTestId('variable-tree-picker-filter');
    expect(filter).toHaveAttribute('placeholder', 'Filter, e.g. Bus_5 or Gen_1');

    await user.type(filter, 'Gen_1');
    expect(screen.getByTestId('variable-tree-picker-leaf-Gen_1_omega')).toBeInTheDocument();
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

  it('is headed Plotted series, so its name is not the one of the toggle that opens it', () => {
    seedRun('r1', ['Bus_1_v']);
    render(<VariableTreePicker />);
    const picker = screen.getByTestId('variable-tree-picker');
    expect(within(picker).getByText('Plotted series')).toBeInTheDocument();
    expect(within(picker).queryByText('Variables')).toBeNull();
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

describe('VariableTreePicker: ANDES variables', () => {
  beforeEach(() => {
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set() });
    usePlotStore.setState({ selectedByRun: {}, filterByRun: {}, expandedByRun: {} });
  });

  afterEach(() => {
    cleanup();
  });

  const ANDES = ['Bus_1_v', 'omega GENROU 10', 'omega GENROU 2', 'omega GENROU 1', 'vf GENROU 1'];

  it('lists the ANDES variables of a run as a group of their own, last', () => {
    seedRun('r1', ['omega GENROU 1', 'Bus_1_v', 'Load_3_p']);
    render(<VariableTreePicker />);

    const group = screen.getByTestId('variable-tree-picker-group-dae');
    expect(group).toBeInTheDocument();
    expect(screen.getByText('ANDES variables')).toBeInTheDocument();
    const load = screen.getByTestId('variable-tree-picker-group-load_pq');
    expect(load.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the variables of a device under the device, named for it', async () => {
    const user = userEvent.setup();
    seedRun('r1', ['omega GENROU 1', 'vf GENROU 1', 'omega GENROU 2']);
    render(<VariableTreePicker />);

    await user.click(screen.getByTestId('variable-tree-picker-expand-dae'));

    expect(screen.getByTestId('variable-tree-picker-element-dae-GENROU 1')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-element-dae-GENROU 2')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-omega GENROU 1')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-vf GENROU 1')).toBeInTheDocument();
  });

  it('sorts the devices numerically, so GENROU 10 follows GENROU 2', () => {
    seedRun('r1', ANDES);
    usePlotStore.getState().toggleExpanded('r1', 'dae');
    render(<VariableTreePicker />);

    const labels = screen
      .getAllByLabelText(/Toggle ANDES variables element/)
      .map((el) => el.getAttribute('aria-label'));

    expect(labels).toEqual([
      'Toggle ANDES variables element GENROU 1',
      'Toggle ANDES variables element GENROU 2',
      'Toggle ANDES variables element GENROU 10',
    ]);
  });

  it('selects the variables the run was asked for beside the bus voltages, for its first plot', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_1_a', 'Gen_1_omega', 'omega GENROU 1', 'vf GENROU 1']);
    render(<VariableTreePicker />);

    const selected = usePlotStore.getState().selectedByRun['r1']!;

    expect([...selected].sort()).toEqual(['Bus_1_v', 'omega GENROU 1', 'vf GENROU 1']);
  });

  it('does not flood the first plot: at most twelve of each kind', () => {
    const columns = [
      ...Array.from({ length: 20 }, (_, i) => `Bus_${i + 1}_v`),
      ...Array.from({ length: 20 }, (_, i) => `omega GENROU ${i + 1}`),
    ];
    seedRun('r1', columns);
    render(<VariableTreePicker />);

    const selected = [...usePlotStore.getState().selectedByRun['r1']!];

    expect(selected.filter((n) => n.startsWith('Bus_'))).toHaveLength(12);
    expect(selected.filter((n) => n.startsWith('omega'))).toHaveLength(12);
  });

  it('leaves a selection the user already made alone', () => {
    seedRun('r1', ['Bus_1_v', 'omega GENROU 1']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<VariableTreePicker />);

    expect([...usePlotStore.getState().selectedByRun['r1']!]).toEqual(['Bus_1_v']);
  });

  it('finds an ANDES variable by the words of its name', async () => {
    const user = userEvent.setup();
    seedRun('r1', ANDES);
    render(<VariableTreePicker />);

    await user.type(screen.getByTestId('variable-tree-picker-filter'), 'vf GENROU');

    expect(screen.getByTestId('variable-tree-picker-leaf-vf GENROU 1')).toBeInTheDocument();
    expect(screen.queryByTestId('variable-tree-picker-leaf-omega GENROU 1')).toBeNull();
  });
});

describe('VariableTreePicker — streaming frames', () => {
  beforeEach(() => {
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set() });
    usePlotStore.setState({ selectedByRun: {}, filterByRun: {}, expandedByRun: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** Append ``count`` single-row frames the way the stream does, one store update each. */
  function streamFrames(runId: string, count: number, columns: string[]) {
    const startRows = useRunsStore.getState().runs[runId]!.seqCount;
    for (let i = startRows; i < startRows + count; i += 1) {
      const cols: Record<string, Float64Array> = {};
      for (const name of columns) cols[name] = Float64Array.of(1 + i / 1000);
      act(() =>
        useRunsStore
          .getState()
          .appendFrame(runId, { t: Float64Array.of(i * 0.033), columns: cols }),
      );
    }
  }

  /** Render the picker and return a reader for how many times React committed it. */
  function renderCounted(): () => number {
    let commits = 0;
    render(
      <Profiler id="picker" onRender={() => (commits += 1)}>
        <VariableTreePicker />
      </Profiler>,
    );
    return () => commits;
  }

  it('does not re-render while frames stream into the run', () => {
    const columns = ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega'];
    seedRun('r1', columns);
    const commits = renderCounted();
    const before = commits();

    streamFrames('r1', 25, columns);

    expect(commits()).toBe(before);
    // The run really did receive the frames.
    expect(useRunsStore.getState().runs['r1']!.seqCount).toBe(25);
  });

  it('does not classify the column names again as frames stream in', () => {
    const columns = ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega', 'Line_2_p'];
    seedRun('r1', columns);
    const parse = vi.spyOn(plotModule, 'parseColumnName');
    renderCounted();
    parse.mockClear();

    streamFrames('r1', 10, columns);

    expect(parse).not.toHaveBeenCalled();
  });

  it('does not rebuild the tree while frames stream into a pinned run in overlay mode', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v']);
    useRunsStore.getState().startRun({ runId: 'r2', tf: 10, columnNames: ['Bus_1_v', 'Bus_9_v'] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    const parse = vi.spyOn(plotModule, 'parseColumnName');
    renderCounted();
    expect(screen.getByTestId('variable-tree-picker')).toHaveAttribute('data-multi-run', 'true');
    parse.mockClear();

    streamFrames('r2', 15, ['Bus_1_v', 'Bus_9_v']);

    expect(parse).not.toHaveBeenCalled();
  });

  it('shows the columns of a run that starts after the picker mounted', () => {
    seedRun('r1', ['Bus_1_v']);
    usePlotStore.getState().toggleExpanded('r1', 'bus_v');
    usePlotStore.getState().toggleExpanded('r2', 'bus_v');
    render(<VariableTreePicker />);
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_1_v')).toBeInTheDocument();

    act(() =>
      useRunsStore
        .getState()
        .startRun({ runId: 'r2', tf: 10, columnNames: ['Bus_3_v', 'Bus_4_v'] }),
    );

    expect(screen.queryByTestId('variable-tree-picker-leaf-Bus_1_v')).toBeNull();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_3_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_4_v')).toBeInTheDocument();
  });

  it('lists the union of the pinned runs and follows the overlay set', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v']);
    useRunsStore.getState().startRun({ runId: 'r2', tf: 10, columnNames: ['Bus_1_v', 'Bus_9_v'] });
    usePlotStore.getState().toggleExpanded('r2', 'bus_v');
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    render(<VariableTreePicker />);

    expect(screen.getByTestId('variable-tree-picker-runs-row')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_9_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-availability-Bus_1_v')).toHaveTextContent(
      '2/2',
    );
    expect(screen.getByTestId('variable-tree-picker-leaf-availability-Bus_5_v')).toHaveTextContent(
      '1/2',
    );

    // Unpinning r1 leaves r2 alone: the tree drops r1's column and the runs row goes.
    act(() => useRunsStore.getState().setOverlayRuns(['r2']));

    expect(screen.queryByTestId('variable-tree-picker-runs-row')).toBeNull();
    expect(screen.queryByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeNull();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_9_v')).toBeInTheDocument();
  });

  it('lists the active run with a pinned one, though it is not pinned itself', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v']);
    useRunsStore.getState().setOverlayRuns(['r1']);
    useRunsStore.getState().startRun({ runId: 'r2', tf: 10, columnNames: ['Bus_1_v', 'Bus_9_v'] });
    usePlotStore.getState().toggleExpanded('r2', 'bus_v');
    render(<VariableTreePicker />);

    // Both runs' columns, and a chip for each that says which is pinned.
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_5_v')).toBeInTheDocument();
    expect(screen.getByTestId('variable-tree-picker-leaf-Bus_9_v')).toBeInTheDocument();
    const row = screen.getByTestId('variable-tree-picker-runs-row');
    expect(within(row).getByTestId('run-legend-chip-r1')).toHaveAttribute('data-pinned', 'true');
    expect(within(row).getByTestId('run-legend-chip-r2')).toHaveAttribute('data-pinned', 'false');
    expect(within(row).getByTestId('run-legend-active-r2')).toBeInTheDocument();
  });
});
