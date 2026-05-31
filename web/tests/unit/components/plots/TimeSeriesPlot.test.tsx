/**
 * <TimeSeriesPlot /> tests.
 *
 * Approach: mock the ``uplot`` module (same lightweight stand-in as
 * ``UPlot.test.tsx``) so we can spy on construction calls per group
 * + assert on the data prop shape. The runs + plot stores are
 * exercised against their real implementations to validate the
 * memoization + selection pathways end-to-end.
 *
 * Unit 9 (v2.0) extends with multi-run overlay scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const { constructSpy, setDataSpy, setCursorSpy, valToPosSpy, FakeUPlot } = vi.hoisted(() => {
  const constructSpy = vi.fn();
  const setDataSpy = vi.fn();
  const setCursorSpy = vi.fn();
  const valToPosSpy = vi.fn();
  class FakeUPlot {
    root: HTMLElement;
    constructor(opts: unknown, data: unknown, target: HTMLElement) {
      constructSpy(opts, data, target);
      this.root = document.createElement('div');
      target.appendChild(this.root);
    }
    setData(data: unknown) {
      setDataSpy(data);
    }
    setCursor(opts: unknown, fireHook?: boolean) {
      setCursorSpy(opts, fireHook);
    }
    valToPos(val: number, scaleKey: string): number {
      valToPosSpy(val, scaleKey);
      // Stub a deterministic mapping: 1 px per simulation second.
      // (The wrapper only consumes the value as a left coordinate; the
      // exact mapping doesn't matter for the assertion that setCursor
      // was called with the right idx-derived t.)
      return val * 100;
    }
    setSize() {}
    destroy() {
      this.root.remove();
    }
  }
  return { constructSpy, setDataSpy, setCursorSpy, valToPosSpy, FakeUPlot };
});

vi.mock('uplot', () => ({
  default: FakeUPlot,
}));

vi.mock('uplot/dist/uPlot.min.css', () => ({}));

import { TimeSeriesPlot } from '@/components/plots/TimeSeriesPlot';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';

function seedRun(runId: string, columnNames: string[], tf = 10) {
  useRunsStore.getState().startRun({ runId, tf, columnNames });
}

function appendRows(runId: string, t: number[], cols: Record<string, number[]>) {
  const tArr = new Float64Array(t);
  const colArrs: Record<string, Float64Array> = {};
  for (const k of Object.keys(cols)) colArrs[k] = new Float64Array(cols[k]!);
  useRunsStore.getState().appendFrame(runId, { t: tArr, columns: colArrs });
}

describe('TimeSeriesPlot', () => {
  beforeEach(() => {
    constructSpy.mockClear();
    setDataSpy.mockClear();
    setCursorSpy.mockClear();
    valToPosSpy.mockClear();
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
    usePlotStore.setState({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the empty state when no run is active', () => {
    const { getByTestId } = render(<TimeSeriesPlot />);
    expect(getByTestId('time-series-plot-empty')).toHaveTextContent('Run a TDS to see results');
    expect(constructSpy).not.toHaveBeenCalled();
  });

  it('renders the "select variables" empty state when a run is active but no series picked', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_2_v']);
    const { getByTestId } = render(<TimeSeriesPlot />);
    expect(getByTestId('time-series-plot-empty')).toHaveTextContent('Select variables to plot');
    expect(constructSpy).not.toHaveBeenCalled();
  });

  it('renders one stacked uPlot per variable group with at least one selected series', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega', 'Line_1_p']);
    appendRows('r1', [0, 0.1, 0.2], {
      Bus_1_v: [1.0, 1.0, 1.0],
      Bus_5_v: [0.99, 0.98, 0.97],
      Gen_1_omega: [1.0, 1.001, 1.0005],
      Line_1_p: [50, 51, 52],
    });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_5_v', 'Gen_1_omega']));
    const { getByTestId, queryByTestId } = render(<TimeSeriesPlot />);
    // 2 groups selected → 2 stacked plots.
    expect(getByTestId('time-series-plot-group-bus_v')).toBeInTheDocument();
    expect(getByTestId('time-series-plot-group-gen_state')).toBeInTheDocument();
    // line_flow group not selected → not rendered.
    expect(queryByTestId('time-series-plot-group-line_flow')).toBeNull();
    expect(constructSpy).toHaveBeenCalledTimes(2);
  });

  it('passes a sync key derived from the run id so all stacked plots cursor-sync together', () => {
    seedRun('r1', ['Bus_1_v', 'Gen_1_omega']);
    appendRows('r1', [0, 0.1], { Bus_1_v: [1.0, 1.0], Gen_1_omega: [1.0, 1.001] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);
    const calls = constructSpy.mock.calls;
    expect(calls.length).toBe(2);
    const syncKeys = calls.map(
      (c) => (c[0] as { cursor?: { sync?: { key?: string } } }).cursor?.sync?.key,
    );
    expect(syncKeys[0]).toBe('tds-run-r1');
    expect(syncKeys[1]).toBe('tds-run-r1');
  });

  it('passes typed-array slices (zero-copy) into uPlot data', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 0.1, 0.2], { Bus_1_v: [1.0, 1.001, 1.002] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    const data = constructSpy.mock.calls[0]?.[1] as Float64Array[];
    expect(data[0]).toBeInstanceOf(Float64Array);
    expect(data[1]).toBeInstanceOf(Float64Array);
    expect(Array.from(data[0]!)).toEqual([0, 0.1, 0.2]);
    expect(Array.from(data[1]!)).toEqual([1.0, 1.001, 1.002]);
  });

  it('mounts without crash when an active run has zero frames', () => {
    seedRun('r1', ['Bus_1_v']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    expect(() => render(<TimeSeriesPlot />)).not.toThrow();
    // We do construct a plot — it just has empty arrays.
    expect(constructSpy).toHaveBeenCalledTimes(1);
    const data = constructSpy.mock.calls[0]?.[1] as Float64Array[];
    expect(data[0]?.length).toBe(0);
    expect(data[1]?.length).toBe(0);
  });

  it('honours an explicit runId prop over the active run from the store', () => {
    seedRun('active-run', ['Bus_1_v']);
    useRunsStore.getState().startRun({ runId: 'other-run', tf: 5, columnNames: ['Bus_2_v'] });
    appendRows('other-run', [0, 0.1], { Bus_2_v: [1.0, 0.99] });
    usePlotStore.getState().setSelection('other-run', new Set(['Bus_2_v']));
    const { getByTestId } = render(<TimeSeriesPlot runId="other-run" />);
    expect(getByTestId('time-series-plot')).toHaveAttribute('data-run-id', 'other-run');
  });

  it('drives uPlot.setCursor when scrubT is set, with the closest-frame index', () => {
    // Plan example: frames at t=[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    // scrubT = 0.5 → idx 5 (the closest-prior frame). The wrapper
    // calls valToPos(t[idx], 'x') and forwards as the cursor's left.
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], {
      Bus_1_v: [1, 1, 1, 1, 1, 1, 1],
    });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    usePlotStore.getState().setScrubT('r1', 0.5);
    render(<TimeSeriesPlot />);
    expect(setCursorSpy).toHaveBeenCalled();
    expect(valToPosSpy).toHaveBeenCalledWith(0.5, 'x');
    const lastCursor = setCursorSpy.mock.calls.at(-1)?.[0] as { left?: number; top?: number };
    // valToPos stub returned 0.5 * 100 = 50.
    expect(lastCursor?.left).toBe(50);
  });

  it('does not call setCursor while in live mode (scrubT === null)', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 0.1, 0.2], { Bus_1_v: [1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    // scrubT remains null (default) → live mode.
    render(<TimeSeriesPlot />);
    expect(setCursorSpy).not.toHaveBeenCalled();
  });

  it('exposes scrubT as a data attribute on the plot wrapper for SLD overlay subscription', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1, 2], { Bus_1_v: [1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    usePlotStore.getState().setScrubT('r1', 1.5);
    const { getByTestId } = render(<TimeSeriesPlot />);
    expect(getByTestId('time-series-plot')).toHaveAttribute('data-scrub-t', '1.5');
  });
});

describe('TimeSeriesPlot — multi-run overlay (Unit 9 v2.0)', () => {
  beforeEach(() => {
    constructSpy.mockClear();
    setDataSpy.mockClear();
    setCursorSpy.mockClear();
    valToPosSpy.mockClear();
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
    usePlotStore.setState({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders one combined chart per group with N series families when 3 runs are pinned', () => {
    // Three runs with the same column set + identical timeline.
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1, 2], { Bus_1_v: [1.0, 1.0, 1.0] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1, 2], { Bus_1_v: [0.99, 0.98, 0.97] });
    seedRun('r3', ['Bus_1_v']);
    appendRows('r3', [0, 1, 2], { Bus_1_v: [0.9, 0.85, 0.8] });
    // Pin all 3 to overlay; pick Bus_1_v (selection is keyed by active runId).
    useRunsStore.getState().setOverlayRuns(['r1', 'r2', 'r3']);
    // The picker writes selection per active run id; mirror that here.
    usePlotStore.getState().setSelection('r3', new Set(['Bus_1_v']));
    const { getByTestId } = render(<TimeSeriesPlot />);
    // One chart for the bus_v group; the chart's series array has
    // 1 (time) + 3 (one per overlay run) = 4 entries.
    expect(getByTestId('time-series-plot-group-bus_v')).toBeInTheDocument();
    expect(constructSpy).toHaveBeenCalledTimes(1);
    const opts = constructSpy.mock.calls[0]?.[0] as { series: unknown[] };
    expect(opts.series).toHaveLength(4);
  });

  it('renders the legend chip strip when overlay > 1', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1], { Bus_1_v: [0.99, 0.98] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    expect(screen.getByTestId('time-series-plot-legend')).toBeInTheDocument();
    expect(screen.getByTestId('run-legend-chip-r1')).toBeInTheDocument();
    expect(screen.getByTestId('run-legend-chip-r2')).toBeInTheDocument();
  });

  it('does NOT render the legend chip strip in single-run mode', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    expect(screen.queryByTestId('time-series-plot-legend')).toBeNull();
  });

  it('mismatched timelines: 5s run + 10s run produce a shared axis with NaN gaps', () => {
    seedRun('r1', ['Bus_1_v'], 5);
    appendRows('r1', [0, 2.5, 5], { Bus_1_v: [1.0, 0.95, 0.9] });
    seedRun('r2', ['Bus_1_v'], 10);
    appendRows('r2', [0, 5, 10], { Bus_1_v: [1.0, 0.99, 0.98] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    const data = constructSpy.mock.calls[0]?.[1] as Float64Array[];
    // Union of timelines: {0, 2.5, 5, 10} = 4 timestamps.
    expect(Array.from(data[0]!)).toEqual([0, 2.5, 5, 10]);
    // r1 series (data[1]): values at 0, 2.5, 5; NaN at 10.
    const r1Vals = Array.from(data[1]!);
    expect(r1Vals[0]).toBe(1.0);
    expect(r1Vals[1]).toBe(0.95);
    expect(r1Vals[2]).toBe(0.9);
    expect(Number.isNaN(r1Vals[3]!)).toBe(true);
    // r2 series (data[2]): values at 0, 5, 10; NaN at 2.5.
    const r2Vals = Array.from(data[2]!);
    expect(r2Vals[0]).toBe(1.0);
    expect(Number.isNaN(r2Vals[1]!)).toBe(true);
    expect(r2Vals[2]).toBe(0.99);
    expect(r2Vals[3]).toBe(0.98);
  });

  it('mismatched columns: per-run column availability surfaced via series count', () => {
    // Run A has Bus_1_v only; run B has Bus_1_v + Gen_1_omega.
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
    seedRun('r2', ['Bus_1_v', 'Gen_1_omega']);
    appendRows('r2', [0, 1], { Bus_1_v: [0.99, 0.98], Gen_1_omega: [1.0, 1.001] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    // Select both vars on the active run (r2).
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);
    // 2 charts: bus_v + gen_state.
    expect(constructSpy).toHaveBeenCalledTimes(2);
    // Inspect the gen_state chart's series — only r2 has Gen_1_omega so
    // there should be 1 (time) + 1 (only r2's gen_state) = 2 entries.
    // r1 is silently skipped because it has no Gen_1_omega column.
    const calls = constructSpy.mock.calls;
    const genStateCall = calls.find((c) => {
      const opts = c[0] as { axes?: { label?: string }[] };
      // gen_state's axis label is now "ω freq (pu) / δ (rad)" (the omega
      // series is the frequency proxy; Pe/Qe split off into gen_power).
      return opts.axes?.[1]?.label === 'ω freq (pu) / δ (rad)';
    });
    expect(genStateCall).toBeDefined();
    const genOpts = genStateCall![0] as { series: unknown[] };
    expect(genOpts.series).toHaveLength(2);
  });

  it('overlay-count data attribute reflects how many runs are rendered', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1, 1] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1], { Bus_1_v: [0.99, 0.98] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    const { getByTestId } = render(<TimeSeriesPlot />);
    expect(getByTestId('time-series-plot')).toHaveAttribute('data-overlay-count', '2');
  });

  it('explicit runId prop overrides the overlay set (legacy single-run rendering)', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1, 1] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1], { Bus_1_v: [0.5, 0.4] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot runId="r1" />);
    // Only r1 → series count = 1 (t) + 1 (Bus_1_v on r1) = 2.
    const opts = constructSpy.mock.calls[0]?.[0] as { series: unknown[] };
    expect(opts.series).toHaveLength(2);
  });
});
