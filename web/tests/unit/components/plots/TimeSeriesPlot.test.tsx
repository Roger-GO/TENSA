/**
 * <TimeSeriesPlot /> tests.
 *
 * Approach: mock the ``uplot`` module (same lightweight stand-in as
 * ``UPlot.test.tsx``) so we can spy on construction calls per group
 * + assert on the data prop shape. The runs + plot stores are
 * exercised against their real implementations to validate the
 * memoization + selection pathways end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

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

function seedRun(runId: string, columnNames: string[]) {
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useRunsStore.getState().startRun({ runId, tf: 10, columnNames });
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
    useRunsStore.setState({ runs: {}, activeRunId: null });
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
