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
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';

const { constructSpy, destroySpy, setDataSpy, setCursorSpy, valToPosSpy, redrawSpy, FakeUPlot } =
  vi.hoisted(() => {
    const constructSpy = vi.fn();
    const destroySpy = vi.fn();
    const setDataSpy = vi.fn();
    const setCursorSpy = vi.fn();
    const valToPosSpy = vi.fn();
    const redrawSpy = vi.fn();
    class FakeUPlot {
      root: HTMLElement;
      /** The element over the plot area, which is where uPlot takes the pointer. */
      over: HTMLElement;
      scales: Record<string, { min?: number; max?: number }>;
      cursor = { left: -10 };
      constructor(opts: unknown, data: unknown, target: HTMLElement) {
        constructSpy(opts, data, target);
        this.root = document.createElement('div');
        const wrap = document.createElement('div');
        this.over = document.createElement('div');
        this.over.className = 'u-over';
        wrap.appendChild(this.over);
        this.root.appendChild(wrap);
        target.appendChild(this.root);
        const t = (data as ArrayLike<number>[])[0] ?? [];
        this.scales = { x: { min: t[0], max: t[t.length - 1] } };
        // The plugins are the code under test where a chart is clicked: run their
        // ``ready`` hook as uPlot does, on this stand-in.
        const { plugins = [] } = opts as { plugins?: { hooks: Record<string, unknown> }[] };
        for (const plugin of plugins) {
          (plugin.hooks['ready'] as ((u: unknown) => void) | undefined)?.(this);
        }
      }
      posToVal(px: number): number {
        return px / 100;
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
      redraw(rebuildPaths?: boolean, recalcAxes?: boolean) {
        redrawSpy(rebuildPaths, recalcAxes);
      }
      setSize() {}
      destroy() {
        destroySpy();
        this.root.remove();
      }
    }
    return {
      constructSpy,
      destroySpy,
      setDataSpy,
      setCursorSpy,
      valToPosSpy,
      redrawSpy,
      FakeUPlot,
    };
  });

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

  it('does not point at the history while there is nothing in it', () => {
    const { getByTestId } = render(<TimeSeriesPlot />);
    expect(getByTestId('time-series-plot-empty')).not.toHaveTextContent('History');
  });

  it('points at the history when runs are kept but none is active, as after Reset run', () => {
    seedRun('r1', ['Bus_1_v']);
    useRunsStore.getState().markRunDone('r1', 1);
    useRunsStore.getState().clearActiveRun();
    const { getByTestId } = render(<TimeSeriesPlot />);
    expect(getByTestId('time-series-plot-empty')).toHaveTextContent(
      'Run a TDS to see results. Earlier runs are in History.',
    );
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

  it('syncs the time axis between the stacked plots, and not the y scale', () => {
    // The pointer, a drag-zoom and a double-click reset follow the time axis in
    // every chart. A synced y scale would draw the pointer's horizontal line at
    // the same y value in a chart of another quantity, where it means nothing.
    seedRun('r1', ['Bus_1_v', 'Gen_1_omega']);
    appendRows('r1', [0, 0.1], { Bus_1_v: [1.0, 1.0], Gen_1_omega: [1.0, 1.001] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_omega']));
    render(<TimeSeriesPlot />);

    for (const call of constructSpy.mock.calls) {
      const cursor = (
        call[0] as {
          cursor: { sync: { scales: unknown }; drag: { x: boolean; y: boolean } };
        }
      ).cursor;
      expect(cursor.sync.scales).toEqual(['x', null]);
      // A drag zooms time only.
      expect(cursor.drag).toMatchObject({ x: true, y: false });
    }
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
      runCount: 0,
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

  it('names each run in the plot legend by its number and scenario, not by its id', () => {
    const start = (runId: string, scenario?: string) =>
      useRunsStore.getState().startRun({
        runId,
        tf: 10,
        columnNames: ['Bus_1_v'],
        ...(scenario === undefined ? {} : { scenario }),
      });
    start('abcdef1234567890', 'fault bus 7');
    appendRows('abcdef1234567890', [0, 1], { Bus_1_v: [1.0, 1.0] });
    start('0123456789abcdef');
    appendRows('0123456789abcdef', [0, 1], { Bus_1_v: [0.9, 0.9] });
    useRunsStore.getState().setOverlayRuns(['abcdef1234567890', '0123456789abcdef']);
    usePlotStore.getState().setSelection('0123456789abcdef', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);

    const opts = constructSpy.mock.calls[0]?.[0] as { series: { label: string }[] };
    expect(opts.series.slice(1).map((s) => s.label)).toEqual([
      'TDS #1 - fault bus 7 · Bus_1_v',
      'TDS #2 · Bus_1_v',
    ]);
  });

  it('puts a name the researcher gave a run in the plot legend', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1], { Bus_1_v: [0.9, 0.9] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);
    constructSpy.mockClear();

    act(() => useRunsStore.getState().setRunDisplayName('r1', 'Baseline'));

    const opts = constructSpy.mock.calls.at(-1)?.[0] as { series: { label: string }[] };
    expect(opts.series.slice(1).map((s) => s.label)).toEqual([
      'Baseline · Bus_1_v',
      'TDS #2 · Bus_1_v',
    ]);
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
    expect(yAxes(options)).toEqual([['y', 'P (MW) / Q (MVAr)', undefined]]);
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
        '# values as simulated: voltage and speed in pu, angles in rad, power in MW and MVAr',
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

describe('TimeSeriesPlot: ANDES variables', () => {
  beforeEach(() => {
    constructSpy.mockClear();
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set() });
    usePlotStore.setState({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
      cursorsByRun: {},
      cursorsArmed: false,
    });
    useUnitsStore.setState({ mode: 'pu' });
  });

  afterEach(() => {
    cleanup();
  });

  function seedAndes() {
    seedRun('r1', ['Bus_1_v', 'omega GENROU 1', 'omega GENROU 2', 'vf GENROU 1', 'vf GENROU 2']);
    appendRows('r1', [0, 1], {
      Bus_1_v: [1, 1],
      'omega GENROU 1': [1, 1.001],
      'omega GENROU 2': [1, 1.002],
      'vf GENROU 1': [2.0, 2.1],
      'vf GENROU 2': [2.0, 2.2],
    });
  }

  it('draws one chart per ANDES variable, the devices of a variable together', () => {
    seedAndes();
    usePlotStore
      .getState()
      .setSelection(
        'r1',
        new Set(['omega GENROU 1', 'omega GENROU 2', 'vf GENROU 1', 'vf GENROU 2']),
      );

    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('time-series-plot-group-dae:omega')).toHaveTextContent(
      'omega · ANDES variable',
    );
    expect(screen.getByTestId('time-series-plot-group-dae:vf')).toHaveTextContent(
      'vf · ANDES variable',
    );
    expect(constructSpy).toHaveBeenCalledTimes(2);
    const labels = constructSpy.mock.calls.map((c) =>
      (c[0] as { series: { label: string }[] }).series.slice(1).map((s) => s.label),
    );
    expect(labels).toEqual([
      ['omega GENROU 1', 'omega GENROU 2'],
      ['vf GENROU 1', 'vf GENROU 2'],
    ]);
  });

  it('draws them as ANDES holds them: an axis named for the variable, no scaling', () => {
    seedRunWithBases('r1', ['omega GENROU 1'], { busKv: {}, freqHz: 60 });
    appendRows('r1', [0, 1], { 'omega GENROU 1': [1, 1.001] });
    usePlotStore.getState().setSelection('r1', new Set(['omega GENROU 1']));
    // Actual units turn a streamed speed into hertz and leave this one alone.
    useUnitsStore.setState({ mode: 'actual' });

    render(<TimeSeriesPlot />);

    const data = constructSpy.mock.calls[0]?.[1] as Float64Array[];
    expect(Array.from(data[1]!)).toEqual([1, 1.001]);
    const axes = (constructSpy.mock.calls[0]?.[0] as { axes: { label?: string }[] }).axes;
    expect(axes.map((a) => a.label)).toEqual(['t (s)', 'omega']);
  });

  it('ranges the y axes so that a signal at rest, a hair off its value, cannot hang the ticks of uPlot', () => {
    seedAndes();
    usePlotStore.getState().setSelection('r1', new Set(['omega GENROU 1', 'Bus_1_v']));
    render(<TimeSeriesPlot />);

    const scalesOf = constructSpy.mock.calls.map(
      (c) => (c[0] as { scales: Record<string, { range?: unknown }> }).scales,
    );
    expect(scalesOf).toHaveLength(2);
    for (const scales of scalesOf) {
      expect(typeof scales['y']!.range).toBe('function');
      expect(scales['x']).toEqual({ time: false });
    }
  });

  it('draws them beside the streamed groups of the same run', () => {
    seedAndes();
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'vf GENROU 1']));

    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('time-series-plot-group-bus_v')).toBeInTheDocument();
    expect(screen.getByTestId('time-series-plot-group-dae:vf')).toBeInTheDocument();
  });
});

describe('TimeSeriesPlot: A/B cursors', () => {
  beforeEach(() => {
    constructSpy.mockClear();
    redrawSpy.mockClear();
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set() });
    usePlotStore.setState({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
      cursorsByRun: {},
      cursorsArmed: false,
    });
    useUnitsStore.setState({ mode: 'pu' });
  });

  afterEach(() => {
    cleanup();
  });

  function seedVolts() {
    seedRun('r1', ['Bus_1_v', 'Bus_1_a']);
    appendRows('r1', [0, 1, 2], {
      Bus_1_v: [1.0, 0.9, 0.8],
      Bus_1_a: [0, Math.PI / 18, Math.PI / 9],
    });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_1_a']));
  }

  it('shows no readout until a cursor is placed', () => {
    seedVolts();
    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('plot-cursors-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('cursor-readout')).toBeNull();
    expect(screen.queryByTestId('plot-cursors-clear')).toBeNull();
  });

  it('shows the readout from the moment the mode is on, so placing A does not move the charts', async () => {
    seedVolts();
    const user = userEvent.setup();
    render(<TimeSeriesPlot />);
    expect(screen.queryByTestId('cursor-readout')).toBeNull();

    await user.click(screen.getByTestId('plot-cursors-toggle'));

    expect(screen.getByTestId('cursor-readout')).toBeInTheDocument();
    // The rows are there, blank, with the same number of lines they will have.
    const before = screen.getAllByRole('row').length;
    expect(
      screen.getByTestId('cursor-readout-row-bus_v:1').querySelectorAll('td')[1],
    ).toHaveTextContent('–');
    act(() => usePlotStore.getState().placeCursor('r1', 0.5));
    expect(screen.getAllByRole('row')).toHaveLength(before);
    expect(
      screen.getByTestId('cursor-readout-row-bus_v:1').querySelectorAll('td')[1],
    ).toHaveTextContent('0.95');

    // Turning the mode off with nothing placed takes the readout away again.
    act(() => usePlotStore.getState().clearCursors('r1'));
    await user.click(screen.getByTestId('plot-cursors-toggle'));
    expect(screen.queryByTestId('cursor-readout')).toBeNull();
  });

  it('keeps the readout of cursors that are placed after the mode is turned off', async () => {
    seedVolts();
    const user = userEvent.setup();
    render(<TimeSeriesPlot />);
    await user.click(screen.getByTestId('plot-cursors-toggle'));
    act(() => usePlotStore.getState().placeCursor('r1', 1));

    await user.click(screen.getByTestId('plot-cursors-toggle'));

    expect(screen.getByTestId('cursor-readout-a')).toHaveValue('1');
  });

  it('turns the click-to-place mode on and off, and says what a click does', async () => {
    seedVolts();
    const user = userEvent.setup();
    render(<TimeSeriesPlot />);

    await user.click(screen.getByTestId('plot-cursors-toggle'));

    expect(usePlotStore.getState().cursorsArmed).toBe(true);
    expect(screen.getByTestId('plot-cursors-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plot-cursors-hint')).toHaveTextContent(
      'Click the plot to place cursor A',
    );
    expect(screen.getByTestId('time-series-plot-group-bus_v')).toHaveAttribute(
      'data-cursors-armed',
      'true',
    );

    act(() => usePlotStore.getState().placeCursor('r1', 0.5));
    expect(screen.getByTestId('plot-cursors-hint')).toHaveTextContent(
      'Click again to place cursor B',
    );

    await user.click(screen.getByTestId('plot-cursors-toggle'));
    expect(usePlotStore.getState().cursorsArmed).toBe(false);
    expect(screen.queryByTestId('plot-cursors-hint')).toBeNull();
  });

  it('says how to zoom time on every chart while the mode is off, and what a click does while it is on', async () => {
    seedVolts();
    const user = userEvent.setup();
    render(<TimeSeriesPlot />);
    expect(screen.getByTestId('plot-zoom-hint')).toHaveTextContent(
      'Drag a chart to zoom time on all of them, double-click to reset',
    );

    await user.click(screen.getByTestId('plot-cursors-toggle'));

    expect(screen.queryByTestId('plot-zoom-hint')).toBeNull();
    expect(screen.getByTestId('plot-cursors-hint')).toBeInTheDocument();
  });

  it('keeps the controls out of a PNG export, and the readout in it', () => {
    seedVolts();
    act(() => usePlotStore.getState().placeCursor('r1', 0.5));
    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('plot-cursor-controls')).toHaveAttribute('data-export-ignore');
    expect(screen.getByTestId('cursor-readout').closest('[data-export-ignore]')).toBeNull();
  });

  it('reads every plotted series at each cursor, in the units the chart shows', () => {
    seedVolts();
    act(() => {
      usePlotStore.getState().placeCursor('r1', 0.5);
      usePlotStore.getState().placeCursor('r1', 1.5);
    });
    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('cursor-readout-a')).toHaveValue('0.5');
    expect(screen.getByTestId('cursor-readout-b')).toHaveValue('1.5');
    expect(screen.getByTestId('cursor-readout-dt')).toHaveTextContent('Δt 1 s');
    const volts = screen.getByTestId('cursor-readout-row-bus_v:1');
    expect(volts).toHaveTextContent('Bus_1_v');
    expect(volts).toHaveTextContent('V (pu)');
    // 0.95 at A, 0.85 at B: down 0.1 over 1 s.
    const cells = Array.from(volts.querySelectorAll('td')).map((td) => td.textContent);
    expect(cells.slice(1)).toEqual(['0.95', '0.85', '-0.1', '-0.1']);
    // The angle is plotted in degrees, so it is read in degrees: 5 and 15 at A and B.
    const angle = screen.getByTestId('cursor-readout-row-bus_v:2');
    expect(angle).toHaveTextContent('θ (°)');
    expect(
      Array.from(angle.querySelectorAll('td'))
        .map((td) => td.textContent)
        .slice(1, 4),
    ).toEqual(['5', '15', '10']);
  });

  it('reads in kV where the chart is in kV', () => {
    seedRunWithBases('r1', ['Bus_1_v'], { busKv: { '1': 230 }, freqHz: 60 });
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 0.9] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    useUnitsStore.setState({ mode: 'actual' });
    act(() => usePlotStore.getState().placeCursor('r1', 0));
    render(<TimeSeriesPlot />);

    const row = screen.getByTestId('cursor-readout-row-bus_v:1');
    expect(row).toHaveTextContent('V (kV)');
    expect(row.querySelectorAll('td')[1]).toHaveTextContent('230');
  });

  it('shows what one cursor has and leaves the difference blank', () => {
    seedVolts();
    act(() => usePlotStore.getState().placeCursor('r1', 1));
    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('cursor-readout-b')).toHaveValue('');
    expect(screen.getByTestId('cursor-readout-b')).toHaveAttribute('placeholder', '–');
    expect(screen.getByTestId('cursor-readout-dt')).toHaveTextContent('Δt –');
    const cells = Array.from(
      screen.getByTestId('cursor-readout-row-bus_v:1').querySelectorAll('td'),
    ).map((td) => td.textContent);
    expect(cells.slice(1)).toEqual(['0.9', '–', '–', '–']);
  });

  it('reads B minus A, so a B placed before A shows negative time and the opposite change', () => {
    seedVolts();
    act(() => {
      usePlotStore.getState().placeCursor('r1', 1.5);
      usePlotStore.getState().placeCursor('r1', 0.5);
    });
    render(<TimeSeriesPlot />);

    expect(screen.getByTestId('cursor-readout-dt')).toHaveTextContent('Δt -1 s');
    const cells = Array.from(
      screen.getByTestId('cursor-readout-row-bus_v:1').querySelectorAll('td'),
    ).map((td) => td.textContent);
    expect(cells.slice(1)).toEqual(['0.85', '0.95', '0.1', '-0.1']);
  });

  it('puts the strip of times above the charts and the table of values under them', () => {
    seedVolts();
    act(() => usePlotStore.getState().setCursorsArmed(true));
    render(<TimeSeriesPlot />);

    const strip = screen.getByTestId('cursor-readout');
    const chart = screen.getByTestId('time-series-plot-group-bus_v');
    const table = screen.getByTestId('cursor-readout-table');
    // In the bottom drawer a table above the charts left none of them in view.
    expect(strip.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chart.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(table).toHaveTextContent('Values at the cursors');
    expect(screen.getByRole('table', { name: 'Values at the cursors' })).toBeInTheDocument();
  });

  it('names each chart and says what a click on it does while the mode is on', async () => {
    seedVolts();
    const user = userEvent.setup();
    render(<TimeSeriesPlot />);
    expect(screen.getByRole('group', { name: 'Bus voltage and angle chart' })).toBeInTheDocument();

    await user.click(screen.getByTestId('plot-cursors-toggle'));
    expect(
      screen.getByRole('group', {
        name: 'Bus voltage and angle chart. Click the plot to place cursor A',
      }),
    ).toBeInTheDocument();

    act(() => usePlotStore.getState().placeCursor('r1', 0.5));
    expect(
      screen.getByRole('group', {
        name: 'Bus voltage and angle chart. Click again to place cursor B',
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('plot-cursors-toggle'));
    expect(screen.getByRole('group', { name: 'Bus voltage and angle chart' })).toBeInTheDocument();
  });

  it('names the element over the plot, the one a click lands on, and a click on it places a cursor', () => {
    seedVolts();
    act(() => usePlotStore.getState().setCursorsArmed(true));
    render(<TimeSeriesPlot />);
    const chart = () => screen.getByRole('group', { name: /^Bus voltage and angle chart/ });
    const stored = () => usePlotStore.getState().cursorsByRun['r1'];

    // The name is on the plot area, not on the box around it, whose middle can be
    // an axis once a legend wraps.
    expect(chart()).toHaveClass('u-over');

    // A click 150 px into the plot, which maps 100 px to one second.
    fireEvent.click(chart(), { clientX: 150, detail: 1 });
    expect(stored()).toEqual({ a: 1.5, b: null });
    expect(chart()).toHaveAccessibleName(
      'Bus voltage and angle chart. Click again to place cursor B',
    );

    // What a script's click, or one that assistive technology makes, is: no position
    // at all, which stands for the middle of the time shown (the run covers 0 to 2 s).
    act(() => chart().click());
    expect(stored()).toEqual({ a: 1.5, b: 1 });
  });

  it('keeps the name on the plot area when a chart is rebuilt', () => {
    seedRun('r1', ['Bus_1_v', 'Bus_1_a', 'Bus_2_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1, 1], Bus_1_a: [0, 0], Bus_2_v: [1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_1_a']));
    render(<TimeSeriesPlot />);
    const built = constructSpy.mock.calls.length;
    expect(screen.getByRole('group', { name: 'Bus voltage and angle chart' })).toHaveClass(
      'u-over',
    );

    // Another series on the same chart: the chart is built again, with a new
    // element over its plot, and its title has not changed.
    act(() =>
      usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_1_a', 'Bus_2_v'])),
    );

    expect(constructSpy.mock.calls.length).toBeGreaterThan(built);
    expect(screen.getByRole('group', { name: 'Bus voltage and angle chart' })).toHaveClass(
      'u-over',
    );
  });

  describe('typing a time', () => {
    async function open() {
      seedVolts();
      act(() => usePlotStore.getState().setCursorsArmed(true));
      const user = userEvent.setup();
      render(<TimeSeriesPlot />);
      return user;
    }
    const box = (which: 'A' | 'B') =>
      screen.getByRole('textbox', { name: `Cursor ${which} time in seconds` });
    const stored = () => usePlotStore.getState().cursorsByRun['r1'];

    it('places a cursor at a time typed in its box and set with Enter', async () => {
      const user = await open();

      await user.type(box('A'), '1.5{Enter}');
      await user.type(box('B'), '0.5{Enter}');

      expect(stored()).toEqual({ a: 1.5, b: 0.5 });
      expect(screen.getByTestId('cursor-readout-dt')).toHaveTextContent('Δt -1 s');
      expect(
        Array.from(screen.getByTestId('cursor-readout-row-bus_v:1').querySelectorAll('td'))
          .map((td) => td.textContent)
          .slice(1),
      ).toEqual(['0.85', '0.95', '0.1', '-0.1']);
    });

    it('sets it when the box is left, and takes a comma for the decimal point', async () => {
      const user = await open();

      await user.type(box('A'), '1,25');
      expect(stored()).toBeUndefined();
      await user.tab();

      expect(stored()?.a).toBe(1.25);
    });

    it('holds a time past the end of the run to the end, and shows where it went', async () => {
      const user = await open();

      await user.type(box('B'), '99{Enter}');
      await user.type(box('A'), '-4{Enter}');

      // The run covers 0 to 2 s.
      expect(stored()).toEqual({ a: 0, b: 2 });
      expect(box('B')).toHaveValue('2');
      expect(box('A')).toHaveValue('0');
    });

    it('takes the cursor off when its box is emptied', async () => {
      const user = await open();
      act(() => {
        usePlotStore.getState().placeCursor('r1', 0.5);
        usePlotStore.getState().placeCursor('r1', 1.5);
      });

      await user.clear(box('A'));
      await user.tab();

      expect(stored()).toEqual({ a: null, b: 1.5 });
      expect(screen.getByTestId('cursor-readout-dt')).toHaveTextContent('Δt –');
    });

    it('puts back what it showed when the text is not a number, or Escape is pressed', async () => {
      const user = await open();
      act(() => usePlotStore.getState().placeCursor('r1', 0.5));

      await user.clear(box('A'));
      await user.type(box('A'), 'soon{Enter}');
      expect(box('A')).toHaveValue('0.5');
      await user.clear(box('A'));
      await user.type(box('A'), '1{Escape}');

      expect(box('A')).toHaveValue('0.5');
      expect(stored()).toEqual({ a: 0.5, b: null });
    });

    it('leaves a cursor where it is when its box is entered and left without a change', async () => {
      const user = await open();
      // Shown as 0.33333, but placed at 1/3: a click that moved it to 0.33333 would be a change.
      act(() => usePlotStore.getState().placeCursor('r1', 1 / 3));

      await user.click(box('A'));
      await user.tab();

      expect(stored()?.a).toBe(1 / 3);
    });

    it('follows a cursor placed with a click while the box is not being typed in', async () => {
      await open();
      expect(box('A')).toHaveValue('');

      act(() => usePlotStore.getState().placeCursor('r1', 1));

      expect(box('A')).toHaveValue('1');
    });
  });

  it('clears the cursors with the Clear cursors button', async () => {
    seedVolts();
    act(() => usePlotStore.getState().placeCursor('r1', 1));
    const user = userEvent.setup();
    render(<TimeSeriesPlot />);

    await user.click(screen.getByRole('button', { name: 'Clear cursors' }));

    expect(usePlotStore.getState().cursorsByRun['r1']).toBeUndefined();
    expect(screen.queryByTestId('cursor-readout')).toBeNull();
  });

  it('gives every chart a cursor plugin that places cursors on the active run', () => {
    seedVolts();
    act(() => usePlotStore.getState().setCursorsArmed(true));
    render(<TimeSeriesPlot />);

    const options = constructSpy.mock.calls[0]?.[0] as {
      plugins?: { hooks: { ready?: (u: unknown) => void } }[];
    };
    expect(options.plugins).toHaveLength(1);
    const root = document.createElement('div');
    const over = document.createElement('div');
    root.appendChild(over);
    over.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
    options.plugins![0]!.hooks.ready!({ root, over, posToVal: (px: number) => px / 100 });
    act(() => {
      over.dispatchEvent(new MouseEvent('mousedown', { clientX: 150, bubbles: true }));
      over.dispatchEvent(new MouseEvent('mouseup', { clientX: 150, bubbles: true }));
      over.dispatchEvent(new MouseEvent('click', { clientX: 150, detail: 1, bubbles: true }));
    });

    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 1.5, b: null });
  });

  it('does not rebuild the chart to move a cursor: the plugin is redrawn instead', () => {
    seedVolts();
    render(<TimeSeriesPlot />);
    expect(constructSpy).toHaveBeenCalledTimes(1);
    redrawSpy.mockClear();

    act(() => usePlotStore.getState().placeCursor('r1', 1));

    expect(constructSpy).toHaveBeenCalledTimes(1);
    // Without rebuilding the paths, and with the axes measured again.
    expect(redrawSpy).toHaveBeenCalledTimes(1);
    expect(redrawSpy).toHaveBeenCalledWith(false, true);
  });

  it('does not redraw a chart it has just built: uPlot has still to make its first draw', () => {
    // A redraw that skips the axes, right after construction, left uPlot drawing axes
    // it had never measured (a TypeError in the browser, not in a stand-in).
    seedVolts();
    act(() => usePlotStore.getState().placeCursor('r1', 1));
    redrawSpy.mockClear();

    render(<TimeSeriesPlot />);

    expect(constructSpy).toHaveBeenCalled();
    expect(redrawSpy).not.toHaveBeenCalled();
  });

  it('does not redraw for a render in which no cursor moved', () => {
    seedVolts();
    render(<TimeSeriesPlot />);
    redrawSpy.mockClear();

    act(() =>
      useRunsStore.getState().appendFrame('r1', {
        t: Float64Array.of(3),
        columns: { Bus_1_v: Float64Array.of(0.7), Bus_1_a: Float64Array.of(1) },
      }),
    );

    expect(redrawSpy).not.toHaveBeenCalled();
  });

  it('follows the mode and the cursors through the plugin without being rebuilt', () => {
    seedVolts();
    render(<TimeSeriesPlot />);
    const plugin = (
      constructSpy.mock.calls[0]?.[0] as {
        plugins: { hooks: { draw: (u: unknown) => void; ready: (u: unknown) => void } }[];
      }
    ).plugins[0]!;
    // Mode off at build time; turned on afterwards: a click must still place.
    const root = document.createElement('div');
    const over = document.createElement('div');
    root.appendChild(over);
    over.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
    plugin.hooks.ready({ root, over, posToVal: (px: number) => px / 100 });
    const click = () =>
      act(() => {
        over.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
        over.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, bubbles: true }));
        over.dispatchEvent(new MouseEvent('click', { clientX: 100, detail: 1, bubbles: true }));
      });
    click();
    expect(usePlotStore.getState().cursorsByRun['r1']).toBeUndefined();

    act(() => usePlotStore.getState().setCursorsArmed(true));
    click();

    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 1, b: null });
    expect(constructSpy).toHaveBeenCalledTimes(1);
  });
});
