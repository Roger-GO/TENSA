/**
 * External overlay traces on <TimeSeriesPlot />: the export menu's import
 * entry opens the dialog through the store flag, the traces draw dashed on the
 * plot's axes with their own time base, the legend chips remove them, and the
 * exports are untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { constructSpy, FakeUPlot } = vi.hoisted(() => {
  const constructSpy = vi.fn();
  class FakeUPlot {
    root: HTMLElement;
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
    }
    posToVal(px: number): number {
      return px / 100;
    }
    setData() {}
    setCursor() {}
    valToPos(val: number): number {
      return val * 100;
    }
    redraw() {}
    setSize() {}
    destroy() {
      this.root.remove();
    }
  }
  return { constructSpy, FakeUPlot };
});

vi.mock('uplot', () => ({
  default: FakeUPlot,
}));

vi.mock('uplot/dist/uPlot.min.css', () => ({}));

// The dialog is a lazy chunk; the plot must not import it statically, and the
// tests of the plot do not load it.
vi.mock('@/components/plots/ExternalResultsDialog', () => ({
  ExternalResultsDialog: () => <div data-testid="external-results-dialog-stub" />,
}));

import { TimeSeriesPlot } from '@/components/plots/TimeSeriesPlot';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';
import { useUnitsStore } from '@/store/units';
import { useExternalOverlaysStore } from '@/store/externalOverlays';
import type { ExternalOverlayTrace } from '@/store/externalOverlays';
import { useThemeStore } from '@/store/theme';
import { captureDownloads, exportAs, readBlob } from '../../helpers/downloads';

function seedRun(runId: string, columnNames: string[], tf = 10) {
  useRunsStore.getState().startRun({ runId, tf, columnNames });
}

function appendRows(runId: string, t: number[], cols: Record<string, number[]>) {
  const tArr = new Float64Array(t);
  const colArrs: Record<string, Float64Array> = {};
  for (const k of Object.keys(cols)) colArrs[k] = new Float64Array(cols[k]!);
  useRunsStore.getState().appendFrame(runId, { t: tArr, columns: colArrs });
}

function makeTrace(over: Partial<ExternalOverlayTrace> = {}): ExternalOverlayTrace {
  return {
    id: 'tsat:column 1',
    source: 'tsat',
    name: 'column 1',
    label: 'tsat: column 1',
    t: Float64Array.of(0, 0.5, 1),
    y: Float64Array.of(5, 6, 7),
    axis: 'left',
    ...over,
  };
}

interface PlotOptions {
  series: { label: string; scale?: string; dash?: number[] }[];
}

function constructed(callIdx = 0): { options: PlotOptions; data: Float64Array[] } {
  const call = constructSpy.mock.calls[callIdx];
  return { options: call?.[0] as PlotOptions, data: call?.[1] as Float64Array[] };
}

describe('TimeSeriesPlot external overlays', () => {
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
    useExternalOverlaysStore.setState({ traces: [], dialogOpen: false });
  });

  afterEach(() => {
    cleanup();
    useExternalOverlaysStore.setState({ traces: [], dialogOpen: false });
  });

  function seedPlottedRun() {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 0.5, 1], { Bus_1_v: [1.0, 0.9, 0.8] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
  }

  it('lists "Import external result…" in the export menu, which opens the dialog', async () => {
    const user = userEvent.setup();
    seedPlottedRun();
    render(<TimeSeriesPlot />);

    await user.click(screen.getByRole('button', { name: 'Export plot' }));
    const entry = await screen.findByTestId('export-menu-import-external');
    expect(entry).toHaveTextContent('Import external result…');
    expect(entry).toHaveTextContent('Overlay a TSAT or PSS/E export (.xlsx) on this plot');

    await user.click(entry);

    expect(useExternalOverlaysStore.getState().dialogOpen).toBe(true);
    expect(await screen.findByTestId('external-results-dialog-stub')).toBeInTheDocument();
  });

  it('draws one dashed series per trace after the run series, on the left axis by default', () => {
    seedPlottedRun();
    useExternalOverlaysStore.getState().addTraces([makeTrace()]);
    render(<TimeSeriesPlot />);

    const { options, data } = constructed();
    expect(options.series.map((s) => s.label)).toEqual(['t', 'Bus_1_v', 'tsat: column 1']);
    const traceSeries = options.series[2]!;
    expect(traceSeries.dash).toEqual([6, 4]);
    expect(traceSeries.scale).toBe('y');
    // The trace keeps its own time base: its values land on the shared axis,
    // NaN where it has no sample.
    expect(Array.from(data[0]!)).toEqual([0, 0.5, 1]);
    expect(Array.from(data[2]!)).toEqual([5, 6, 7]);
  });

  it('puts a right-axis trace on the secondary scale', () => {
    seedPlottedRun();
    useExternalOverlaysStore.getState().addTraces([makeTrace({ axis: 'right' })]);
    render(<TimeSeriesPlot />);

    expect(constructed().options.series[2]?.scale).toBe('y2');
  });

  it('uses only the samples inside the run time range, so the x range stays the run', () => {
    seedPlottedRun();
    // The store keeps every sample; the chart uses the ones inside [0, 1].
    useExternalOverlaysStore
      .getState()
      .addTraces([makeTrace({ t: Float64Array.of(-5, 0.5, 9), y: Float64Array.of(1, 6, 2) })]);
    render(<TimeSeriesPlot />);

    const { data } = constructed();
    expect(Array.from(data[0]!)).toEqual([0, 0.5, 1]);
    expect(Array.from(data[2]!)).toEqual([undefined, 6, undefined]);
  });

  it('places a trace at its own times between the run rows, with its gaps as gaps', () => {
    seedPlottedRun();
    // A trace sampled between the run's rows, with a value the export did not
    // carry (NaN in the store) at t = 0.75.
    useExternalOverlaysStore
      .getState()
      .addTraces([makeTrace({ t: Float64Array.of(0.25, 0.75), y: Float64Array.of(5, NaN) })]);
    render(<TimeSeriesPlot />);

    const { data } = constructed();
    // The axis is the union of both timelines, and the x range is still the run's.
    expect(Array.from(data[0]!)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    // The run's values sit on its own rows only: nothing is interpolated in.
    expect(Array.from(data[1]!)).toEqual([1.0, undefined, 0.9, undefined, 0.8]);
    // The trace: its value at 0.25, a gap (null: uPlot breaks the line) at
    // 0.75, and undefined (drawn across, not a gap, not a zero) elsewhere.
    expect(Array.from(data[2]!)).toEqual([undefined, 5, undefined, null, undefined]);
  });

  it('leaves the run itself as it was: its times, its rows and its values', () => {
    seedPlottedRun();
    useExternalOverlaysStore
      .getState()
      .addTraces([makeTrace({ t: Float64Array.of(0.25, 0.75), y: Float64Array.of(5, 6) })]);
    render(<TimeSeriesPlot />);

    const run = useRunsStore.getState().runs['r1']!;
    expect(run.seqCount).toBe(3);
    expect(Array.from(run.t.subarray(0, run.seqCount))).toEqual([0, 0.5, 1]);
    expect(Array.from(run.columns['Bus_1_v']!.subarray(0, run.seqCount))).toEqual([1.0, 0.9, 0.8]);
  });

  it('reads the run and the trace at a cursor on their own samples', () => {
    seedPlottedRun();
    useExternalOverlaysStore
      .getState()
      .addTraces([makeTrace({ t: Float64Array.of(0.25, 0.75), y: Float64Array.of(5, 7) })]);
    // Cursor A at 0.6 lies between a run row (0.5) and a trace row (0.75).
    usePlotStore.getState().setCursor('r1', 'a', 0.6);
    render(<TimeSeriesPlot />);

    const table = screen.getByTestId('cursor-readout-table');
    const rowOf = (label: string) =>
      Array.from(table.querySelectorAll('tr')).find((tr) => tr.textContent?.includes(label))!;
    // Bus_1_v between 0.9 at 0.5 and 0.8 at 1: 0.88; the trace between 5 at
    // 0.25 and 7 at 0.75: 6.4.
    expect(rowOf('Bus_1_v').textContent).toContain('0.88');
    expect(rowOf('tsat: column 1').textContent).toContain('6.4');
  });

  it('shows more of the series when a longer run is plotted later', () => {
    seedPlottedRun();
    useExternalOverlaysStore
      .getState()
      .addTraces([makeTrace({ t: Float64Array.of(0, 1, 2), y: Float64Array.of(5, 7, 9) })]);
    const { unmount } = render(<TimeSeriesPlot />);
    expect(Array.from(constructed().data[0]!)).toEqual([0, 0.5, 1]);
    unmount();
    constructSpy.mockClear();

    // A longer run plotted later shows the trace's samples past t=1.
    seedRun('r2', ['Bus_1_v'], 2);
    appendRows('r2', [0, 1, 2], { Bus_1_v: [1.0, 1.0, 1.0] });
    useRunsStore.getState().clearActiveRun();
    useRunsStore.getState().setOverlayRuns(['r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    render(<TimeSeriesPlot />);

    expect(Array.from(constructed().data[0]!)).toEqual([0, 1, 2]);
    expect(Array.from(constructed().data[2]!)).toEqual([5, 7, 9]);
  });

  it('appends the traces once after every run series in multi-run mode', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 1], { Bus_1_v: [0.9, 0.9] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    useExternalOverlaysStore.getState().addTraces([makeTrace()]);
    render(<TimeSeriesPlot />);

    const { options } = constructed();
    const labels = options.series.map((s) => s.label);
    expect(labels.filter((l) => l === 'tsat: column 1')).toHaveLength(1);
    expect(labels.at(-1)).toBe('tsat: column 1');
    expect(options.series.at(-1)?.dash).toEqual([6, 4]);
  });

  it('places a trace at its own times in multi-run mode, inside the runs range only', () => {
    seedRun('r1', ['Bus_1_v']);
    appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
    seedRun('r2', ['Bus_1_v']);
    appendRows('r2', [0, 0.5, 2], { Bus_1_v: [0.9, 0.8, 0.9] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
    useExternalOverlaysStore.getState().addTraces([
      makeTrace({
        t: Float64Array.of(-1, 0.25, 1.5, 3),
        y: Float64Array.of(4, 5, NaN, 8),
        axis: 'right',
      }),
    ]);
    render(<TimeSeriesPlot />);

    const { options, data } = constructed();
    expect(Array.from(data[0]!)).toEqual([0, 0.25, 0.5, 1, 1.5, 2]);
    expect(Array.from(data.at(-1)!)).toEqual([undefined, 5, undefined, undefined, null, undefined]);
    expect(options.series.at(-1)?.scale).toBe('y2');
  });

  it('draws a trace in the colour its chip shows, in the dark theme too', () => {
    useThemeStore.setState({ themePreference: 'dark', resolvedTheme: 'dark' });
    try {
      seedRun('r1', ['Bus_1_v']);
      appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.0] });
      seedRun('r2', ['Bus_1_v']);
      appendRows('r2', [0, 1], { Bus_1_v: [0.9, 0.9] });
      useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
      usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));
      useExternalOverlaysStore.getState().addTraces([makeTrace()]);
      render(<TimeSeriesPlot />);

      const stroke = (constructed().options.series.at(-1) as { stroke?: string }).stroke!;
      const swatch = screen
        .getByTestId('external-trace-chip-tsat:column 1')
        .querySelector('span[aria-hidden="true"]')!;
      expect(swatch.getAttribute('style')).toContain(stroke);
      // The dark palette's colour, not the light one's.
      useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
      cleanup();
      constructSpy.mockClear();
      render(<TimeSeriesPlot />);
      const light = (constructed().options.series.at(-1) as { stroke?: string }).stroke!;
      expect(light).not.toBe(stroke);
    } finally {
      useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
    }
  });

  it('renders a chip per trace in the legend row of a single run, which removes it', async () => {
    const user = userEvent.setup();
    seedPlottedRun();
    useExternalOverlaysStore.getState().addTraces([makeTrace()]);
    render(<TimeSeriesPlot />);

    const legend = screen.getByTestId('time-series-plot-legend');
    expect(legend).toContainElement(screen.getByTestId('external-trace-chip-tsat:column 1'));
    expect(screen.getByTestId('external-trace-chip-tsat:column 1')).toHaveTextContent(
      'tsat: column 1',
    );

    constructSpy.mockClear();
    await user.click(screen.getByTestId('external-trace-remove-tsat:column 1'));

    expect(useExternalOverlaysStore.getState().traces).toEqual([]);
    expect(screen.queryByTestId('external-trace-chip-tsat:column 1')).toBeNull();
    expect(constructed().options.series.map((s) => s.label)).toEqual(['t', 'Bus_1_v']);
  });

  it('renders no trace chip and no import entry when nothing is plotted', () => {
    useExternalOverlaysStore.getState().addTraces([makeTrace()]);
    render(<TimeSeriesPlot />);

    expect(screen.queryByTestId('external-trace-chip-tsat:column 1')).toBeNull();
    expect(screen.queryByTestId('time-series-plot-legend')).toBeNull();
    // The disabled menu never opens: no extra action is wired on it.
    expect(screen.getByTestId('export-menu-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('export-menu-import-external')).toBeNull();
  });

  it('leaves the CSV export to the run columns, with no trace column', async () => {
    const downloads = captureDownloads();
    try {
      seedPlottedRun();
      // Samples between the run's rows, which the chart's time axis holds too.
      useExternalOverlaysStore
        .getState()
        .addTraces([makeTrace({ t: Float64Array.of(0.25, 0.75), y: Float64Array.of(5, 6) })]);
      render(<TimeSeriesPlot />);

      await exportAs(userEvent.setup(), 'csv');

      const lines = (await readBlob(downloads.blobs[0]!)).trim().split(/\r?\n/);
      expect(lines.slice(1)).toEqual([
        'time,variable,value',
        '0,Bus_1_v,1',
        '0.5,Bus_1_v,0.9',
        '1,Bus_1_v,0.8',
      ]);
    } finally {
      downloads.restore();
    }
  });

  it('exports the same CSV, byte for byte, with a trace on the plot as without', async () => {
    const downloads = captureDownloads();
    try {
      seedPlottedRun();
      render(<TimeSeriesPlot />);
      const user = userEvent.setup();
      await exportAs(user, 'csv');
      const without = await readBlob(downloads.blobs[0]!);

      act(() =>
        useExternalOverlaysStore
          .getState()
          .addTraces([makeTrace({ t: Float64Array.of(0.25, 0.75), y: Float64Array.of(5, NaN) })]),
      );
      await exportAs(user, 'csv');
      const withTrace = await readBlob(downloads.blobs[1]!);

      expect(withTrace).toBe(without);
    } finally {
      downloads.restore();
    }
  });

  it('sends only the run and its selected columns to the COMTRADE export', async () => {
    const downloads = captureDownloads();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      seedPlottedRun();
      // Samples between the run's rows, which the chart's time axis holds too.
      useExternalOverlaysStore
        .getState()
        .addTraces([makeTrace({ t: Float64Array.of(0.25, 0.75), y: Float64Array.of(5, 6) })]);
      render(<TimeSeriesPlot />);

      await exportAs(userEvent.setup(), 'comtrade');

      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe('/api/comtrade');
      const sent = JSON.parse(String(init.body)) as { t: number[]; channels: { name: string }[] };
      expect(sent.t).toEqual([0, 0.5, 1]);
      expect(sent.channels.map((c) => c.name)).toEqual(['Bus_1_v']);
    } finally {
      globalThis.fetch = originalFetch;
      downloads.restore();
    }
  });

  it('redraws without the trace series once it is removed from the store', () => {
    seedPlottedRun();
    useExternalOverlaysStore.getState().addTraces([makeTrace()]);
    render(<TimeSeriesPlot />);
    expect(constructed().options.series).toHaveLength(3);
    constructSpy.mockClear();

    act(() => useExternalOverlaysStore.getState().removeTrace('tsat:column 1'));

    expect(constructed().options.series.map((s) => s.label)).toEqual(['t', 'Bus_1_v']);
  });
});
