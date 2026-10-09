/**
 * <ResponseMetricsPanel />: the table of how each plotted signal responded.
 * The numbers come from the substrate, so ``fetchResponseMetrics`` is replaced by
 * a stand-in that records the request and answers from a fixture; what is checked
 * is what the panel asks for, when, and how it shows the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ResponseMetricsRequest, ResponseMetricsResponse, SeriesMetrics } from '@/api/types';

const requests: ResponseMetricsRequest[] = [];
let respond: (request: ResponseMetricsRequest) => Promise<ResponseMetricsResponse>;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    fetchResponseMetrics: (request: ResponseMetricsRequest) => {
      requests.push(request);
      return respond(request);
    },
  };
});

import { ResponseMetricsPanel } from '@/components/plots/ResponseMetricsPanel';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';
import { useUnitsStore } from '@/store/units';

function metrics(name: string, extra: Partial<SeriesMetrics> = {}): SeriesMetrics {
  return {
    name,
    error: null,
    samples: 4,
    t_start: 0,
    t_end: 3,
    initial: 1,
    final: 0.995,
    peak: { value: 1.001, t: 0.1 },
    nadir: { value: 0.9921, t: 1.5 },
    max_deviation: { value: -0.0079, t: 1.5 },
    rocof: { value: -0.0123, t: 0.4 },
    settling_time: 2.25,
    overshoot_pct: 12.5,
    damping: { ratio: 0.0432, frequency_hz: 0.612, extrema: 9 },
    ...extra,
  };
}

function answerWith(make: (name: string) => SeriesMetrics = (n) => metrics(n)) {
  respond = (request) => Promise.resolve({ results: request.series.map((s) => make(s.name)) });
}

function seed(
  runId: string,
  columns: Record<string, number[]>,
  options: {
    finish?: boolean;
    bases?: { busKv: Record<string, number>; freqHz: number | null };
    /** When the run first disturbs the system (s). */
    disturbedAt?: number;
  } = {},
) {
  const { finish = true, bases, disturbedAt } = options;
  useRunsStore.getState().startRun({
    runId,
    tf: 3,
    columnNames: Object.keys(columns),
    ...(bases === undefined ? {} : { bases }),
    ...(disturbedAt === undefined ? {} : { disturbedAt }),
  });
  useRunsStore.getState().appendFrame(runId, {
    t: Float64Array.from({ length: 4 }, (_, i) => i),
    columns: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, Float64Array.from(v)])),
  });
  if (finish) useRunsStore.getState().markRunDone(runId, 3, true);
}

function renderPanel(ui: ReactNode = <ResponseMetricsPanel />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  requests.length = 0;
  answerWith();
  useRunsStore.setState({
    runs: {},
    activeRunId: null,
    overlayRunIds: new Set(),
    runCount: 0,
  });
  usePlotStore.setState({ selectedByRun: {}, cursorsByRun: {}, cursorsArmed: false });
  useUnitsStore.setState({ mode: 'pu' });
});

afterEach(() => {
  cleanup();
});

describe('<ResponseMetricsPanel />: when it asks', () => {
  it('says so when there is no run, and asks nothing', () => {
    renderPanel();

    expect(screen.getByTestId('response-metrics-message')).toHaveTextContent(
      'Run a TDS to see response metrics.',
    );
    expect(requests).toEqual([]);
  });

  it('says to select variables when none is plotted', () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] });

    renderPanel();

    expect(screen.getByTestId('response-metrics-message')).toHaveTextContent('Select variables');
    expect(requests).toEqual([]);
  });

  it('waits for a run to finish: its values are still arriving', () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] }, { finish: false });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));

    renderPanel();

    expect(screen.getByTestId('response-metrics-message')).toHaveTextContent(
      'computed when the run finishes',
    );
    expect(requests).toEqual([]);
  });

  it('does not ask while frames stream in, and asks once the run is done', async () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] }, { finish: false });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    renderPanel();

    act(() =>
      useRunsStore.getState().appendFrame('r1', {
        t: Float64Array.of(4),
        columns: { Bus_1_v: Float64Array.of(0.9) },
      }),
    );
    expect(requests).toEqual([]);

    act(() => useRunsStore.getState().markRunDone('r1', 4, true));
    await screen.findByTestId('response-metrics-table');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.series[0]!.t).toHaveLength(5);
  });

  it('describes a run that was stopped, or that failed, with what it has', async () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] }, { finish: false });
    useRunsStore.getState().markRunAborted('r1');
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));

    renderPanel();

    await screen.findByTestId('response-metrics-table');
    expect(requests).toHaveLength(1);
  });
});

describe('<ResponseMetricsPanel />: what it asks', () => {
  it('asks about the plotted series of the run, with the settings the table states', async () => {
    seed('r1', { Bus_1_v: [1, 0.99, 0.98, 0.97], Gen_1_omega: [1, 0.999, 0.998, 0.999] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_omega']));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    const request = requests[0]!;
    expect(request.series.map((s) => s.name)).toEqual(['Bus_1_v', 'Gen_1_omega']);
    expect(request.series[0]).toEqual({
      name: 'Bus_1_v',
      t: [0, 1, 2, 3],
      y: [1, 0.99, 0.98, 0.97],
    });
    expect(request.settling_band).toBe(0.02);
    expect(request.rocof_window).toBe(0.5);
    // The whole run: no window.
    expect(request).not.toHaveProperty('t_start');
    expect(screen.getByTestId('response-metrics-window')).toHaveTextContent('Over the whole run');
  });

  it('describes a pinned run when no run is active, as after a reload of the page', async () => {
    seed('r1', { Bus_1_v: [1, 0.99, 0.98, 0.97] });
    useRunsStore.getState().clearActiveRun();
    useRunsStore.getState().addOverlayRun('r1');
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(requests[0]!.series.map((s) => s.name)).toEqual(['Bus_1_v']);
  });

  it('asks about the stretch between the cursors when both are placed, and again when one moves', async () => {
    seed('r1', { Bus_1_v: [1, 0.99, 0.98, 0.97] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    act(() => {
      usePlotStore.getState().placeCursor('r1', 2);
      usePlotStore.getState().placeCursor('r1', 0.5);
    });
    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ t_start: 0.5, t_end: 2 });
    expect(screen.getByTestId('response-metrics-window')).toHaveTextContent(
      'Over A to B, 0.5 to 2 s',
    );

    act(() => usePlotStore.getState().setCursor('r1', 'b', 1));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ t_start: 1, t_end: 2 });
  });

  it('uses the whole run with one cursor placed, and invites the second', async () => {
    seed('r1', { Bus_1_v: [1, 0.99, 0.98, 0.97] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    act(() => usePlotStore.getState().placeCursor('r1', 2));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(requests[0]).not.toHaveProperty('t_start');
    // Where the cursors are found, which the old line did not say.
    expect(screen.getByTestId('response-metrics-window')).toHaveTextContent(
      'press Cursors over the plot and click the plot twice (A, then B)',
    );
  });

  it('asks again when the selection changes, and not when nothing did', async () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1], Bus_2_v: [1, 1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    renderPanel();
    await screen.findByTestId('response-metrics-table');
    expect(requests).toHaveLength(1);

    act(() => usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_2_v'])));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.series.map((s) => s.name)).toEqual(['Bus_1_v', 'Bus_2_v']);

    // The same selection as a new set is not a change.
    act(() => usePlotStore.getState().setSelection('r1', new Set(['Bus_2_v', 'Bus_1_v'])));
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toHaveLength(2);
  });

  it('asks for the values in the units the charts show, and again when the units change', async () => {
    seed(
      'r1',
      { Bus_1_v: [1, 0.9, 0.9, 0.9], Gen_1_omega: [1, 1, 1, 1] },
      { bases: { busKv: { '1': 230 }, freqHz: 60 } },
    );
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Gen_1_omega']));
    renderPanel();
    await screen.findByTestId('response-metrics-table');
    expect(requests[0]!.series[0]!.y[0]).toBe(1);

    act(() => useUnitsStore.setState({ mode: 'actual' }));
    await waitFor(() => expect(requests).toHaveLength(2));

    expect(requests[1]!.series[0]!.y).toEqual([230, 207, 207, 207]);
    expect(requests[1]!.series[1]!.y[0]).toBe(60);
  });

  it('describes the active run, the one whose cursors it reads, and says so when runs are overlaid', async () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] });
    seed('r2', { Bus_1_v: [0.5, 0.5, 0.5, 0.5] });
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(requests[0]!.series[0]!.y).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(screen.getByTestId('response-metrics-overlay-note')).toHaveTextContent(
      'With runs overlaid, the metrics describe TDS #2 only.',
    );
  });

  it('describes the active run when it is drawn with a pinned one without being pinned', async () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] });
    useRunsStore.getState().setOverlayRuns(['r1']);
    seed('r2', { Bus_1_v: [0.5, 0.5, 0.5, 0.5] });
    usePlotStore.getState().setSelection('r2', new Set(['Bus_1_v']));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(requests[0]!.series[0]!.y).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(screen.getByTestId('response-metrics-overlay-note')).toHaveTextContent('TDS #2 only');
  });

  it('describes the oldest pinned run when runs are overlaid and none is active', async () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] });
    seed('r2', { Bus_1_v: [0.5, 0.5, 0.5, 0.5] });
    useRunsStore.getState().clearActiveRun();
    useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(requests[0]!.series[0]!.y).toEqual([1, 1, 1, 1]);
    expect(screen.getByTestId('response-metrics-overlay-note')).toHaveTextContent('TDS #1 only');
  });

  it('names no overlay when one run is drawn', async () => {
    seed('r1', { Bus_1_v: [1, 1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(screen.queryByTestId('response-metrics-overlay-note')).toBeNull();
  });

  it('asks about as many series as one request takes, and says how many it left out', async () => {
    const columns = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`Bus_${i + 1}_v`, [1, 1, 1, 1]]),
    );
    seed('r1', columns);
    usePlotStore.getState().setSelection('r1', new Set(Object.keys(columns)));

    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(requests[0]!.series).toHaveLength(64);
    expect(screen.getByTestId('response-metrics-skipped')).toHaveTextContent(
      '6 more plotted series are left out',
    );
  });
});

describe('<ResponseMetricsPanel />: the window a fault study reads', () => {
  it('offers the stretch from the first disturbance to the end of the run, and puts the cursors there', async () => {
    seed('r1', { Gen_1_omega: [1, 1, 1.01, 1.02] }, { disturbedAt: 1 });
    usePlotStore.getState().setSelection('r1', new Set(['Gen_1_omega']));
    renderPanel();
    await screen.findByTestId('response-metrics-table');
    // The whole run at first, the steady state before the fault included.
    expect(requests[0]).not.toHaveProperty('t_start');
    const from = screen.getByRole('button', { name: 'From the first disturbance (1 s)' });
    expect(from).toHaveAttribute('aria-pressed', 'false');
    // No way back to the whole run is offered while that is what is shown.
    expect(screen.queryByRole('button', { name: 'Whole run' })).not.toBeInTheDocument();

    fireEvent.click(from);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ t_start: 1, t_end: 3 });
    expect(usePlotStore.getState().cursorsByRun.r1).toMatchObject({ a: 1, b: 3 });
    expect(screen.getByTestId('response-metrics-window')).toHaveTextContent(
      'Over A to B, 1 to 3 s',
    );
    expect(from).toHaveAttribute('aria-pressed', 'true');

    // And back: the cursors come off the plot.
    fireEvent.click(screen.getByRole('button', { name: 'Whole run' }));
    await waitFor(() =>
      expect(screen.getByTestId('response-metrics-window')).toHaveTextContent('Over the whole run'),
    );
    expect(usePlotStore.getState().cursorsByRun.r1 ?? {}).not.toMatchObject({ a: 1 });
    expect(from).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not offer it for a run nothing disturbed, or one disturbed from its first instant', async () => {
    seed('r1', { Gen_1_omega: [1, 1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Gen_1_omega']));
    const first = renderPanel();
    await screen.findByTestId('response-metrics-table');
    expect(screen.queryByTestId('response-metrics-window-controls')).not.toBeInTheDocument();
    first.unmount();

    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set(), runCount: 0 });
    seed('r2', { Gen_1_omega: [1, 1, 1, 1] }, { disturbedAt: 0 });
    usePlotStore.getState().setSelection('r2', new Set(['Gen_1_omega']));
    renderPanel();
    await screen.findByTestId('response-metrics-table');
    expect(screen.queryByTestId('response-metrics-from-disturbance')).not.toBeInTheDocument();
  });

  it('offers the whole run again for a window that was set with the cursors of the plot', async () => {
    seed('r1', { Gen_1_omega: [1, 1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Gen_1_omega']));
    act(() => {
      usePlotStore.getState().placeCursor('r1', 2);
      usePlotStore.getState().placeCursor('r1', 0.5);
    });
    renderPanel();
    await screen.findByTestId('response-metrics-table');
    expect(screen.getByTestId('response-metrics-window')).toHaveTextContent('0.5 to 2 s');
    fireEvent.click(screen.getByRole('button', { name: 'Whole run' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).not.toHaveProperty('t_start');
    expect(screen.getByTestId('response-metrics-window')).toHaveTextContent('Over the whole run');
  });
});

describe('<ResponseMetricsPanel />: what it shows', () => {
  async function shown(name = 'Gen_1_omega') {
    seed('r1', { [name]: [1, 0.99, 0.98, 0.97] });
    usePlotStore.getState().setSelection('r1', new Set([name]));
    renderPanel();
    await screen.findByTestId('response-metrics-table');
  }

  it('shows each metric with its time, and the series with its unit', async () => {
    await shown();

    const row = screen.getByTestId('response-metrics-row-Gen_1_omega');
    expect(row).toHaveTextContent('Gen_1_omega');
    expect(row).toHaveTextContent('pu');
    expect(screen.getByTestId('response-metrics-initial-Gen_1_omega')).toHaveTextContent('1');
    expect(screen.getByTestId('response-metrics-final-Gen_1_omega')).toHaveTextContent('0.995');
    expect(screen.getByTestId('response-metrics-nadir-Gen_1_omega')).toHaveTextContent(
      '0.9921at 1.5 s',
    );
    expect(screen.getByTestId('response-metrics-peak-Gen_1_omega')).toHaveTextContent(
      '1.001at 0.1 s',
    );
    expect(screen.getByTestId('response-metrics-deviation-Gen_1_omega')).toHaveTextContent(
      '-0.0079at 1.5 s',
    );
    expect(screen.getByTestId('response-metrics-rocof-Gen_1_omega')).toHaveTextContent(
      '-0.0123at 0.4 s',
    );
    expect(screen.getByTestId('response-metrics-settling-Gen_1_omega')).toHaveTextContent('2.25');
    expect(screen.getByTestId('response-metrics-overshoot-Gen_1_omega')).toHaveTextContent('12.5');
    expect(screen.getByTestId('response-metrics-damping-Gen_1_omega')).toHaveTextContent(
      'ζ 0.0432',
    );
    expect(screen.getByTestId('response-metrics-damping-Gen_1_omega')).toHaveTextContent(
      '0.612 Hz',
    );
  });

  it('says of a signal that only rises that it has no dip, not that its nadir is the start value', async () => {
    // A speed that only rises after a fault: the lowest value of the run is
    // the first sample, which read "Nadir 1 at 0 s" and said nothing.
    answerWith((n) =>
      metrics(n, { initial: 1, nadir: { value: 1, t: 0 }, peak: { value: 1.02, t: 3 } }),
    );
    await shown();
    const nadir = screen.getByTestId('response-metrics-nadir-Gen_1_omega');
    expect(nadir).toHaveTextContent('no dip');
    expect(nadir).toHaveTextContent('stays at or above the start value, 1');
    expect(nadir).not.toHaveTextContent('at 0 s');
    // The peak is one, and reads as before.
    expect(screen.getByTestId('response-metrics-peak-Gen_1_omega')).toHaveTextContent('1.02at 3 s');
  });

  it('says of a signal that only falls that it has no rise', async () => {
    answerWith((n) =>
      metrics(n, { initial: 1, peak: { value: 1, t: 0 }, nadir: { value: 0.97, t: 3 } }),
    );
    await shown();
    const peak = screen.getByTestId('response-metrics-peak-Gen_1_omega');
    expect(peak).toHaveTextContent('no rise');
    expect(peak).toHaveTextContent('stays at or below the start value, 1');
    expect(screen.getByTestId('response-metrics-nadir-Gen_1_omega')).toHaveTextContent(
      '0.97at 3 s',
    );
  });

  it('says what each column holds, in the heading and in a list for a reader with no pointer', async () => {
    await shown();
    expect(screen.getByTestId('response-metrics-heading-nadir')).toHaveAttribute(
      'title',
      expect.stringContaining('The lowest value in the window and the time it is reached.'),
    );
    expect(screen.getByTestId('response-metrics-heading-damping').getAttribute('title')).toMatch(
      /damping ratio ζ.*0\.05 is 5 %.*frequency in Hz/,
    );
    const list = screen.getByTestId('response-metrics-definitions');
    expect(within(list).getByText('What the columns mean')).toBeInTheDocument();
    for (const title of ['Initial', 'Final', 'Nadir', 'Peak', 'Overshoot (%)', 'Settling (s)']) {
      expect(within(list).getByText(title)).toBeInTheDocument();
    }
    expect(list).toHaveTextContent('"not settled": it is still outside that band at the end.');
    expect(list).toHaveTextContent('in percent of the step from initial to final');
  });

  it('shows a signal that never settled as not settled, and the metrics it lacks as dashes', async () => {
    answerWith((n) =>
      metrics(n, { settling_time: null, overshoot_pct: null, damping: null, rocof: null }),
    );
    await shown();

    expect(screen.getByTestId('response-metrics-settling-Gen_1_omega')).toHaveTextContent(
      'not settled',
    );
    expect(screen.getByTestId('response-metrics-overshoot-Gen_1_omega')).toHaveTextContent('–');
    expect(screen.getByTestId('response-metrics-damping-Gen_1_omega')).toHaveTextContent('–');
    expect(screen.getByTestId('response-metrics-rocof-Gen_1_omega')).toHaveTextContent('–');
  });

  it('shows a series the substrate could not describe with the reason, and the others as usual', async () => {
    answerWith((n) =>
      n === 'Bus_2_v'
        ? ({
            name: n,
            error: 'the signal has 2 usable samples; at least 3 are needed',
          } as SeriesMetrics)
        : metrics(n),
    );
    seed('r1', { Bus_1_v: [1, 1, 1, 1], Bus_2_v: [1, 1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_2_v']));
    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(screen.getByTestId('response-metrics-error-Bus_2_v')).toHaveTextContent(
      'at least 3 are needed',
    );
    expect(screen.getByTestId('response-metrics-nadir-Bus_1_v')).toBeInTheDocument();
  });

  it('puts the unit of each series beside its name: kV, degrees, MVAr', async () => {
    seed(
      'r1',
      { Bus_1_v: [1, 1, 1, 1], Bus_1_a: [0, 0, 0, 0], Line_1_q: [1, 1, 1, 1] },
      { bases: { busKv: { '1': 230 }, freqHz: 60 } },
    );
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_1_a', 'Line_1_q']));
    useUnitsStore.setState({ mode: 'actual' });
    renderPanel();
    await screen.findByTestId('response-metrics-table');

    expect(screen.getByTestId('response-metrics-row-Bus_1_v')).toHaveTextContent('kV');
    expect(screen.getByTestId('response-metrics-row-Bus_1_a')).toHaveTextContent('°');
    expect(screen.getByTestId('response-metrics-row-Line_1_q')).toHaveTextContent('MVAr');
  });

  it('shows an ANDES variable with no unit', async () => {
    await shown('omega GENROU 1');

    const row = screen.getByTestId('response-metrics-row-omega GENROU 1');
    expect(within(row).getAllByRole('cell')[0]!.textContent).toBe('omega GENROU 1');
  });

  it('says it is computing before the answer, and shows a failure as it is', async () => {
    let fail: (reason: Error) => void = () => undefined;
    respond = () => new Promise((_, reject) => (fail = reject));
    seed('r1', { Bus_1_v: [1, 1, 1, 1] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('response-metrics-message')).toHaveTextContent('Computing'),
    );
    await act(async () => fail(new Error('network down')));

    await waitFor(() =>
      expect(screen.getByTestId('response-metrics-message')).toHaveTextContent(
        'Could not compute the metrics: network down',
      ),
    );
  });

  it('keeps the last table, dimmed, while a changed window is being computed', async () => {
    seed('r1', { Bus_1_v: [1, 0.99, 0.98, 0.97] });
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    renderPanel();
    await screen.findByTestId('response-metrics-table');

    let release: (r: ResponseMetricsResponse) => void = () => undefined;
    respond = () => new Promise((resolve) => (release = resolve));
    act(() => {
      usePlotStore.getState().placeCursor('r1', 1);
      usePlotStore.getState().placeCursor('r1', 2);
    });

    await waitFor(() =>
      expect(screen.getByTestId('response-metrics-table')).toHaveClass('opacity-60'),
    );
    expect(screen.getByTestId('response-metrics-row-Bus_1_v')).toBeInTheDocument();
    await act(async () => release({ results: [metrics('Bus_1_v')] }));
    await waitFor(() =>
      expect(screen.getByTestId('response-metrics-table')).not.toHaveClass('opacity-60'),
    );
  });
});
