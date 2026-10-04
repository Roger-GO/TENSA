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
import { render, cleanup, screen, act } from '@testing-library/react';

const { constructSpy, destroySpy, setDataSpy, setCursorSpy, valToPosSpy, FakeUPlot } = vi.hoisted(
  () => {
    const constructSpy = vi.fn();
    const destroySpy = vi.fn();
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
        destroySpy();
        this.root.remove();
      }
    }
    return { constructSpy, destroySpy, setDataSpy, setCursorSpy, valToPosSpy, FakeUPlot };
  },
);

vi.mock('uplot', () => ({
  default: FakeUPlot,
}));

vi.mock('uplot/dist/uPlot.min.css', () => ({}));

import { TimeSeriesPlot } from '@/components/plots/TimeSeriesPlot';
import * as alignModule from '@/components/plots/multiRunAlign';
import { useRunsStore } from '@/store/runs';
import * as plotModule from '@/store/plot';
import { usePlotStore } from '@/store/plot';
import { useThemeStore } from '@/store/theme';
import { useUnitsStore } from '@/store/units';
import type { UnitBases } from '@/lib/units';
import userEvent from '@testing-library/user-event';
import { captureDownloads, exportAs, readBlob } from '../../helpers/downloads';

function seedRun(runId: string, columnNames: string[], tf = 10) {
  useRunsStore.getState().startRun({ runId, tf, columnNames });
}

/** Start a run that carries the unit bases of the case it was made on. */
function seedRunWithBases(runId: string, columnNames: string[], bases: UnitBases) {
  useRunsStore.getState().startRun({ runId, tf: 10, columnNames, bases });
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
    destroySpy.mockClear();
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
    useUnitsStore.setState({ mode: 'pu' });
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
    destroySpy.mockClear();
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
      // gen_state's y axis reads the speed (the omega series; Pe/Qe split
      // off into gen_power). The rotor angle would get an axis of its own.
      return opts.axes?.[1]?.label === 'ω (pu)';
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

describe('TimeSeriesPlot — streaming frames do not rebuild the charts', () => {
  beforeEach(() => {
    constructSpy.mockClear();
    destroySpy.mockClear();
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
    useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
  });

  afterEach(() => {
    cleanup();
    useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
  });

  /** Append ``count`` single-row frames the way the stream does, one store update each. */
  function streamFrames(runId: string, from: number, count: number, columns: string[]) {
    for (let i = from; i < from + count; i += 1) {
      const cols: Record<string, number[]> = {};
      for (const name of columns) cols[name] = [1 + i / 1000];
      act(() => appendRows(runId, [i * 0.033], cols));
    }
  }

  /** The labels of the series a construct call was given, without the time series. */
  function seriesLabels(callIdx: number): string[] {
    const opts = constructSpy.mock.calls[callIdx]?.[0] as { series: { label: string }[] };
    return opts.series.slice(1).map((s) => s.label);
  }

  it('builds each stacked chart once while frames stream in', () => {
    // The real flow: the run starts, the plot mounts on an empty run, then
    // frames arrive at up to 30 Hz.
    seedRun('r1', ['Bus_1_v', 'Gen_1_omega']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(2);

    streamFrames('r1', 0, 30, ['Bus_1_v', 'Gen_1_omega']);

    expect(constructSpy).toHaveBeenCalledTimes(2);
    expect(destroySpy).not.toHaveBeenCalled();
    // The data still reaches both charts: the last push to each carries all 30 rows.
    const lastPushes = setDataSpy.mock.calls.slice(-2).map((c) => (c[0] as Float64Array[])[0]);
    expect(lastPushes.map((t) => t?.length)).toEqual([30, 30]);
  });

  it('builds the chart once while frames stream into a pinned run in overlay mode', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1, 2], { Bus_1_v: [1.0, 1.0, 1.0] });
    seedRun('r2', ['Bus_1_v']);
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(1);

    streamFrames('r2', 0, 20, ['Bus_1_v']);

    expect(constructSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).not.toHaveBeenCalled();
    // r2's rows land on the shared time axis, whose union grows with them.
    const t = (setDataSpy.mock.calls.at(-1)?.[0] as Float64Array[])[0];
    expect(t?.length).toBeGreaterThan(20);
  });

  it('does not classify the column names again while frames stream in', () => {
    const columns = ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega', 'Line_1_p'];
    seedRun('r1', columns);
    usePlotStore.getState().setSelection('r1', new Set(columns));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(3);
    const parse = vi.spyOn(plotModule, 'parseColumnName');

    streamFrames('r1', 0, 10, columns);

    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('merges the pinned runs onto one time axis per frame, however many groups are stacked', () => {
    const columns = ['Bus_1_v', 'Gen_1_omega', 'Line_1_p'];
    seedRun('r1', columns);
    appendRows('r1', [0, 1, 2], {
      Bus_1_v: [1, 1, 1],
      Gen_1_omega: [1, 1, 1],
      Line_1_p: [5, 5, 5],
    });
    seedRun('r2', columns);
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(columns));
    const align = vi.spyOn(alignModule, 'alignRuns');

    render(<TimeSeriesPlot />);
    // Three stacked charts share the one alignment.
    expect(constructSpy).toHaveBeenCalledTimes(3);
    expect(align).toHaveBeenCalledTimes(1);

    streamFrames('r2', 0, 4, columns);

    expect(align).toHaveBeenCalledTimes(5);
    // All three charts still got the merged axis: r1's 3 times plus the 3 new ones of r2 (t=0 is shared).
    const lastPushes = setDataSpy.mock.calls.slice(-3).map((c) => (c[0] as Float64Array[])[0]);
    expect(lastPushes.map((t) => t?.length)).toEqual([6, 6, 6]);
    align.mockRestore();
  });

  it('leaves the pinned runs alone while another run streams', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1, 2], { Bus_1_v: [1, 1, 1] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1, 2], { Bus_1_v: [0.9, 0.9, 0.9] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    // A third run starts and becomes the active run, but is not pinned.
    seedRun('r3', ['Bus_1_v']);
    usePlotStore.getState().setSelection('r3', new Set(['Bus_1_v']));
    const align = vi.spyOn(alignModule, 'alignRuns');
    render(<TimeSeriesPlot />);
    expect(screen.getByTestId('time-series-plot')).toHaveAttribute('data-overlay-count', '2');
    expect(align).toHaveBeenCalledTimes(1);
    const pushes = setDataSpy.mock.calls.length;

    streamFrames('r3', 0, 15, ['Bus_1_v']);

    // The two pinned runs did not change, so nothing was merged or pushed again.
    expect(align).toHaveBeenCalledTimes(1);
    expect(setDataSpy.mock.calls.length).toBe(pushes);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    align.mockRestore();
  });

  it('rebuilds only the group whose series set changed', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_5_v', 'Gen_1_omega']);
    appendRows('r1', [0, 0.1], {
      Bus_1_v: [1, 1],
      Bus_5_v: [0.99, 0.98],
      Gen_1_omega: [1, 1.001],
    });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(2);

    act(() =>
      usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_5_v', 'Gen_1_omega'])),
    );

    // The bus_v chart gained a series and was rebuilt once; gen_state was left alone.
    expect(constructSpy).toHaveBeenCalledTimes(3);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(seriesLabels(2)).toEqual(['Bus_1_v', 'Bus_5_v']);
  });

  it('rebuilds with the other palette when the theme changes', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 0.1], { Bus_1_v: [1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    const stroke = (callIdx: number) =>
      (constructSpy.mock.calls[callIdx]?.[0] as { series: { stroke?: string }[] }).series[1]
        ?.stroke;
    const lightStroke = stroke(0);

    act(() => useThemeStore.setState({ themePreference: 'dark', resolvedTheme: 'dark' }));

    expect(constructSpy).toHaveBeenCalledTimes(2);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(stroke(1)).not.toBe(lightStroke);
  });

  it('rebuilds with the new stroke when a pinned run gets a colour override', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1, 1] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1], { Bus_1_v: [0.9, 0.9] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(1);

    act(() => useRunsStore.getState().setRunColorOverride('r2', '#ff00ff'));

    expect(constructSpy).toHaveBeenCalledTimes(2);
    const opts = constructSpy.mock.calls[1]?.[0] as { series: { stroke?: string }[] };
    expect(opts.series[2]?.stroke).toBe('#ff00ff');
  });
});

describe('TimeSeriesPlot axes and units', () => {
  interface PlotOptions {
    series: { label: string; scale?: string; stroke?: string; dash?: number[] }[];
    axes: { scale?: string; label?: string; side?: number; grid?: { show: boolean } }[];
  }

  /** The options and data uPlot was constructed with for the chart at ``callIdx``. */
  function constructed(callIdx = 0): { options: PlotOptions; data: Float64Array[] } {
    const call = constructSpy.mock.calls[callIdx];
    return { options: call?.[0] as PlotOptions, data: call?.[1] as Float64Array[] };
  }

  /** The y axes of a chart: its axes without the time axis. */
  function yAxes(options: PlotOptions) {
    return options.axes.slice(1).map((a) => [a.scale, a.label, a.side]);
  }

  beforeEach(() => {
    constructSpy.mockClear();
    destroySpy.mockClear();
    setDataSpy.mockClear();
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set() });
    usePlotStore.setState({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
    });
    useUnitsStore.setState({ mode: 'pu' });
  });

  afterEach(() => {
    cleanup();
    useUnitsStore.setState({ mode: 'pu' });
  });

  it('puts a bus angle on its own right-hand axis, in degrees, so the voltage is not squashed', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_1_a']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.02], Bus_1_a: [0, 0.5] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_1_a']));
    render(<TimeSeriesPlot />);

    const { options, data } = constructed();
    expect(yAxes(options)).toEqual([
      ['y', 'V (pu)', undefined],
      ['y2', 'θ (°)', 1],
    ]);
    // The right-hand axis draws no grid of its own over the left one's.
    expect(options.axes[2]?.grid).toEqual({ show: false });
    expect(options.series.slice(1).map((s) => [s.label, s.scale])).toEqual([
      ['Bus_1_v', 'y'],
      ['Bus_1_a', 'y2'],
    ]);
    // The angle series is dashed, so the two axes can be told apart in the plot.
    expect(options.series[1]?.dash).toBeUndefined();
    expect(options.series[2]?.dash).toEqual([6, 4]);
    // The voltage is as streamed; the angle is 0.5 rad in degrees.
    expect(Array.from(data[1]!)).toEqual([1.0, 1.02]);
    expect(data[2]![0]).toBe(0);
    expect(data[2]![1]).toBeCloseTo(28.6479, 3);
  });

  it('puts the machine speed and rotor angle on separate axes', () => {
    seedRun('r1', ['Gen_1_delta', 'Gen_1_omega']);
    appendRows('r1', [0, 1], { Gen_1_delta: [0.5, 1.0], Gen_1_omega: [1.0, 1.001] });
    usePlotStore.getState().setSelection('r1', new Set(['Gen_1_delta', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);

    const { options, data } = constructed();
    expect(yAxes(options)).toEqual([
      ['y', 'ω (pu)', undefined],
      ['y2', 'δ (°)', 1],
    ]);
    // The speed is the left axis whichever column comes first.
    expect(options.series.slice(1).map((s) => [s.label, s.scale])).toEqual([
      ['Gen_1_delta', 'y2'],
      ['Gen_1_omega', 'y'],
    ]);
    expect(data[1]![1]).toBeCloseTo(57.2958, 3);
    expect(Array.from(data[2]!)).toEqual([1.0, 1.001]);
  });

  it('leaves a power group on one axis, as before', () => {
    seedRun('r1', ['Line_1_p', 'Line_1_q']);
    appendRows('r1', [0, 1], { Line_1_p: [10, 12], Line_1_q: [2, 3] });
    usePlotStore.getState().setSelection('r1', new Set(['Line_1_p', 'Line_1_q']));
    render(<TimeSeriesPlot />);

    const { options, data } = constructed();
    expect(yAxes(options)).toEqual([['y', 'P (MW) / Q (MVar)', undefined]]);
    expect(Array.from(data[1]!)).toEqual([10, 12]);
  });

  it('shows the speed in Hz and the voltage in kV in the actual mode', () => {
    useUnitsStore.setState({ mode: 'actual' });
    seedRunWithBases('r1', ['Bus_1_v', 'Bus_2_v', 'Gen_1_omega'], {
      busKv: { '1': 230, '2': 13.8 },
      freqHz: 50,
    });
    appendRows('r1', [0, 1], {
      Bus_1_v: [1.0, 1.05],
      Bus_2_v: [1.0, 0.5],
      Gen_1_omega: [1.0, 1.002],
    });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_2_v', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);

    const bus = constructed(0);
    expect(yAxes(bus.options)).toEqual([['y', 'V (kV)', undefined]]);
    expect(bus.data[1]![0]).toBeCloseTo(230, 10);
    expect(bus.data[1]![1]).toBeCloseTo(241.5, 10);
    expect(bus.data[2]![0]).toBeCloseTo(13.8, 10);
    expect(bus.data[2]![1]).toBeCloseTo(6.9, 10);
    const gen = constructed(1);
    expect(yAxes(gen.options)).toEqual([['y', 'f (Hz)', undefined]]);
    expect(gen.data[1]![0]).toBeCloseTo(50, 10);
    expect(gen.data[1]![1]).toBeCloseTo(50.1, 10);
  });

  it('keeps a run per unit in the actual mode when it recorded no bases', () => {
    useUnitsStore.setState({ mode: 'actual' });
    seedRun('r1', ['Bus_1_v', 'Gen_1_omega']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.05], Gen_1_omega: [1.0, 1.002] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);

    expect(yAxes(constructed(0).options)).toEqual([['y', 'V (pu)', undefined]]);
    expect(Array.from(constructed(0).data[1]!)).toEqual([1.0, 1.05]);
    expect(yAxes(constructed(1).options)).toEqual([['y', 'ω (pu)', undefined]]);
    expect(Array.from(constructed(1).data[1]!)).toEqual([1.0, 1.002]);
  });

  it('rebuilds the chart in the new unit when the display units change', () => {
    seedRunWithBases('r1', ['Bus_1_v'], { busKv: { '1': 100 }, freqHz: 60 });
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    expect(yAxes(constructed(0).options)).toEqual([['y', 'V (pu)', undefined]]);

    act(() => useUnitsStore.getState().setMode('actual'));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(constructSpy).toHaveBeenCalledTimes(2);
    expect(yAxes(constructed(1).options)).toEqual([['y', 'V (kV)', undefined]]);
    expect(constructed(1).data[1]![1]).toBeCloseTo(110, 10);
  });

  it('converts each pinned run with its own bases', () => {
    useUnitsStore.setState({ mode: 'actual' });
    // Two runs of different cases: bus 1 is 115 kV in the first, 230 kV in the second.
    seedRunWithBases('r1', ['Bus_1_v'], { busKv: { '1': 115 }, freqHz: 60 });
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
    seedRunWithBases('r2', ['Bus_1_v'], { busKv: { '1': 230 }, freqHz: 60 });
    appendRows('r2', [0, 1], { Bus_1_v: [1.0, 1.0] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);

    const { options, data } = constructed();
    expect(yAxes(options)).toEqual([['y', 'V (kV)', undefined]]);
    expect(Array.from(data[1]!)).toEqual([115, 115]);
    expect(Array.from(data[2]!)).toEqual([230, 230]);
  });

  it('puts the angles of pinned runs on the right-hand axis, in degrees', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_1_a']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0], Bus_1_a: [0, Math.PI] });
    seedRun('r2', ['Bus_1_v', 'Bus_1_a']);
    appendRows('r2', [0, 1], { Bus_1_v: [1.0, 1.0], Bus_1_a: [0, Math.PI / 2] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v', 'Bus_1_a']));
    render(<TimeSeriesPlot />);

    const { options, data } = constructed();
    expect(yAxes(options)).toEqual([
      ['y', 'V (pu)', undefined],
      ['y2', 'θ (°)', 1],
    ]);
    // Series order: r1 v, r1 a, r2 v, r2 a (with the time column first).
    expect(options.series.slice(1).map((s) => s.scale)).toEqual(['y', 'y2', 'y', 'y2']);
    expect(data[2]![1]).toBeCloseTo(180, 10);
    expect(data[4]![1]).toBeCloseTo(90, 10);
  });

  it("draws a run's angle in the run's own stroke in an overlay, since a dash there names the run", () => {
    seedRun('r1', ['Bus_1_v', 'Bus_1_a']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0], Bus_1_a: [0, 1] });
    seedRun('r2', ['Bus_1_v', 'Bus_1_a']);
    appendRows('r2', [0, 1], { Bus_1_v: [1.0, 1.0], Bus_1_a: [0, 2] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v', 'Bus_1_a']));
    const { unmount } = render(<TimeSeriesPlot />);

    // Series order: r1 v, r1 a, r2 v, r2 a. The right-hand axis adds no dash of its own.
    const [v1, a1, v2, a2] = constructed().options.series.slice(1);
    expect(a1?.scale).toBe('y2');
    expect(a1?.stroke).toBe(v1?.stroke);
    expect(a1?.dash).toEqual(v1?.dash);
    expect(a2?.stroke).toBe(v2?.stroke);
    expect(a2?.dash).toEqual(v2?.dash);
    unmount();

    // In gradient mode nothing is dashed.
    constructSpy.mockClear();
    render(<TimeSeriesPlot colorMode="gradient" />);
    expect(
      constructed()
        .options.series.slice(1)
        .map((s) => s.dash),
    ).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('exports the values as simulated, and says in which units', async () => {
    const downloads = captureDownloads();
    try {
      // The plot shows the angle in degrees and the voltage in kV, but the file holds the stream.
      useUnitsStore.setState({ mode: 'actual' });
      seedRunWithBases('r1', ['Bus_1_v', 'Bus_1_a'], { busKv: { '1': 230 }, freqHz: 60 });
      appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.05], Bus_1_a: [0, 0.5] });
      usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_1_a']));
      render(<TimeSeriesPlot />);

      await exportAs(userEvent.setup(), 'csv');

      const lines = (await readBlob(downloads.blobs[0]!)).trim().split(/\r?\n/);
      expect(lines[0]).toBe(
        '# values as simulated: voltage and speed in pu, angles in rad, power in MW and MVar',
      );
      expect(lines.slice(1)).toEqual([
        'time,variable,value',
        '0,Bus_1_v,1',
        '0,Bus_1_a,0',
        '1,Bus_1_v,1.05',
        '1,Bus_1_a,0.5',
      ]);
    } finally {
      downloads.restore();
    }
  });
});

describe('TimeSeriesPlot chart titles and toolbar', () => {
  beforeEach(() => {
    constructSpy.mockClear();
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set() });
    usePlotStore.setState({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
    });
    useUnitsStore.setState({ mode: 'pu' });
  });

  afterEach(() => {
    cleanup();
  });

  function seedBus(selected: string[]) {
    seedRun('r1', ['Bus_1_v', 'Bus_1_a', 'Gen_1_omega', 'Gen_1_delta']);
    appendRows('r1', [0, 1], {
      Bus_1_v: [1.0, 1.02],
      Bus_1_a: [0, 0.5],
      Gen_1_omega: [1.0, 1.001],
      Gen_1_delta: [0.5, 1.0],
    });
    usePlotStore.getState().setSelection('r1', new Set(selected));
  }

  it('names a chart after what it draws, not after its whole group', () => {
    seedBus(['Bus_1_v']);
    const { rerender } = render(<TimeSeriesPlot />);
    const group = screen.getByTestId('time-series-plot-group-bus_v');
    expect(group).toHaveTextContent('Bus voltage');
    expect(group).not.toHaveTextContent('angle');
    // One quantity has one axis: nothing to say about which is which.
    expect(screen.queryByTestId('time-series-plot-axes-bus_v')).toBeNull();

    act(() => usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_1_a'])));
    rerender(<TimeSeriesPlot />);
    expect(screen.getByTestId('time-series-plot-group-bus_v')).toHaveTextContent(
      'Bus voltage and angle',
    );

    act(() => usePlotStore.getState().setSelection('r1', new Set(['Bus_1_a'])));
    rerender(<TimeSeriesPlot />);
    expect(screen.getByTestId('time-series-plot-group-bus_v')).toHaveTextContent('Bus angle');
  });

  it('says which axis reads what when a chart has two, and that the angle is dashed', () => {
    seedBus(['Bus_1_v', 'Bus_1_a', 'Gen_1_omega', 'Gen_1_delta']);
    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('time-series-plot-group-gen_state')).toHaveTextContent(
      'Generator speed and rotor angle',
    );
    expect(screen.getByTestId('time-series-plot-axes-bus_v')).toHaveTextContent(
      'V (pu) on the left axis, θ (°) on the right axis (dashed)',
    );
    expect(screen.getByTestId('time-series-plot-axes-gen_state')).toHaveTextContent(
      'ω (pu) on the left axis, δ (°) on the right axis (dashed)',
    );
  });

  it('does not call the angle dashed on a chart that overlays runs, where it is not', () => {
    seedBus(['Bus_1_v', 'Bus_1_a']);
    seedRun('r2', ['Bus_1_v', 'Bus_1_a']);
    appendRows('r2', [0, 1], { Bus_1_v: [1.0, 1.0], Bus_1_a: [0, 1] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v', 'Bus_1_a']));
    render(<TimeSeriesPlot />);

    const note = screen.getByTestId('time-series-plot-axes-bus_v');
    expect(note).toHaveTextContent('V (pu) on the left axis, θ (°) on the right axis');
    expect(note).not.toHaveTextContent('dashed');
  });

  it('draws the toolbar beside the export menu, with a run, without a selection, and without a run', () => {
    seedBus(['Bus_1_v']);
    const toolbar = <button type="button">Quick pick</button>;
    const { rerender } = render(<TimeSeriesPlot toolbar={toolbar} />);
    expect(screen.getByRole('button', { name: 'Quick pick' })).toBeInTheDocument();
    // A control, not part of the picture: a PNG export leaves it out.
    expect(
      screen.getByRole('button', { name: 'Quick pick' }).closest('[data-export-ignore]'),
    ).not.toBeNull();

    // Nothing selected: the toolbar is how to get something drawn.
    act(() => usePlotStore.getState().setSelection('r1', new Set()));
    rerender(<TimeSeriesPlot toolbar={toolbar} />);
    expect(screen.getByTestId('time-series-plot-empty')).toHaveTextContent(
      'Select variables to plot',
    );
    expect(screen.getByRole('button', { name: 'Quick pick' })).toBeInTheDocument();

    act(() => useRunsStore.setState({ runs: {}, activeRunId: null }));
    rerender(<TimeSeriesPlot toolbar={toolbar} />);
    expect(screen.getByTestId('time-series-plot-empty')).toHaveTextContent('Run a TDS');
    expect(screen.getByRole('button', { name: 'Quick pick' })).toBeInTheDocument();
  });

  it('draws nothing for a toolbar that is not given', () => {
    seedBus(['Bus_1_v']);
    const { container } = render(<TimeSeriesPlot />);
    expect(container.querySelector('[data-export-ignore]:not([data-testid])')).toBeNull();
  });

  it('calls its export menu "Export plot", so it is not taken for the run-data one', () => {
    seedBus(['Bus_1_v']);
    render(<TimeSeriesPlot />);
    expect(screen.getByRole('button', { name: 'Export plot' })).toBeInTheDocument();
  });
});
