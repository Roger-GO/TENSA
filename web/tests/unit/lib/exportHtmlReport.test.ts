/**
 * Gathering the HTML report: what `collectReportData` takes from the stores,
 * what `makeHtmlReport` asks the server for, and the file `exportHtmlReport`
 * hands to the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunId, parseSessionId, parseWorkspacePath } from '@/api/types';
import type { EigResult, PflowResult, TopologySummary } from '@/api/types';
import { NO_ELEMENT_NAMES } from '@/lib/elementNames';
import {
  collectReportData,
  exportHtmlReport,
  makeHtmlReport,
  reportChartsOf,
  runOutcome,
} from '@/lib/exportHtmlReport';
import { useAnalyzeStore } from '@/store/analyze';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { usePlotStore } from '@/store/plot';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useUnitsStore } from '@/store/units';
import { captureDownloads, readBlob, type DownloadCapture } from '../helpers/downloads';
import { lineFlow } from '../helpers/lineFlow';
import { finishedRun } from '../helpers/runs';

const TOPOLOGY: TopologySummary = {
  state: 'committed',
  buses: [
    { idx: 1, name: 'North', kind: 'Bus', params: { Vn: 230, vmin: 0.95, vmax: 1.05 } },
    { idx: 2, name: 'South', kind: 'Bus', params: { Vn: 230, vmin: 0.95, vmax: 1.05 } },
  ],
  lines: [{ idx: 'L1', name: 'North-South', kind: 'Line' }],
  transformers: [],
  generators: [{ idx: 'G1', name: 'Hydro', kind: 'Slack' }],
  loads: [{ idx: 'D1', name: 'Town', kind: 'PQ' }],
  freq_hz: 60,
};

function pf(id: string, overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId(id),
    converged: true,
    iterations: 4,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.02, '2': 0.93 },
    bus_angles: { '1': 0, '2': -0.05 },
    line_flows: { L1: lineFlow(60, 10, { from: 1, to: 2 }) },
    generator_outputs: { G1: { p: 60, q: 10, v: 1.02, bus: 1 } },
    load_consumption: { D1: { p: 60, q: 10, bus: 2 } },
    summary: {
      generation_p: 60,
      generation_q: 10,
      load_p: 60,
      load_q: 10,
      shunt_p: 0,
      shunt_q: 0,
      loss_p: 0,
      loss_q: 0,
    },
    ...overrides,
  };
}

/** The operating point `loadOperatingPointIntoStore` writes after a time-domain run. */
function operatingPoint(): PflowResult {
  return pf('op-1', {
    bus_voltages: { '1': 1.0, '2': 0.9 },
    line_flows: {},
    generator_outputs: {},
    load_consumption: {},
    summary: null,
    settings: null,
  });
}

const EIG: EigResult = {
  eigenvalues: [{ real: -0.5, imag: 6.28 }],
  damping_ratios: [0.079],
  frequencies_hz: [1.0],
  mode_count: 1,
  state_count: 1,
  state_names: ['delta'],
  tds_initialized: true,
};

function openCase(): void {
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('cases/two_bus.raw'),
      addfiles: [parseWorkspacePath('cases/two_bus.dyr')],
    },
    topology: TOPOLOGY,
  });
}

function resetStores(): void {
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null, topology: null });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  usePflowHistoryStore.getState().clear();
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set(), runCount: 0 });
  usePlotStore.setState({ selectedByRun: {} });
  useAnalyzeStore.setState({ eigResult: null });
  useUnitsStore.setState({ mode: 'pu' });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answer the server's part of a report: its version, and a report per routine. */
function serve(reports: Partial<Record<'pflow' | 'tds' | 'eig', string | number>> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname === '/api/version') return jsonResponse({ tensa: '0.4.0', andes: '2.0.0' });
    const routine = url.searchParams.get('routine') as 'pflow' | 'tds' | 'eig' | null;
    const answer = routine === null ? undefined : reports[routine];
    if (typeof answer === 'string') {
      return jsonResponse({ routine, plain_text: answer, structured: { tables: [] } });
    }
    return jsonResponse(
      { type: 'about:blank', title: 'Conflict', status: answer ?? 409, detail: 'no result' },
      typeof answer === 'number' ? answer : 409,
    );
  });
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

beforeEach(resetStores);
afterEach(() => {
  vi.restoreAllMocks();
  resetStores();
});

describe('runOutcome', () => {
  it('says how a run ended', () => {
    expect(runOutcome({ state: 'done', converged: true })).toBe('done');
    expect(runOutcome({ state: 'done', converged: null })).toBe('done');
    expect(runOutcome({ state: 'done', converged: false })).toBe('halted early');
    expect(runOutcome({ state: 'aborted', converged: null })).toBe('aborted');
    expect(runOutcome({ state: 'error', converged: null })).toBe('error');
    expect(runOutcome({ state: 'streaming', converged: null })).toBe('still running');
  });
});

describe('reportChartsOf', () => {
  const run = finishedRun('r1', {
    columns: {
      Bus_1_v: new Float64Array([1, 0.9, 1]),
      Bus_1_a: new Float64Array([0, Math.PI / 6, 0]),
      Gen_1_omega: new Float64Array([1, 1.01, 1]),
    },
    columnNames: ['Bus_1_v', 'Bus_1_a', 'Gen_1_omega'],
    bases: { busKv: { '1': 230 }, freqHz: 60 },
  });

  it('gives one chart per quantity and unit, with the values the plot shows', () => {
    const charts = reportChartsOf(run, new Set(['Bus_1_v', 'Bus_1_a', 'Gen_1_omega']), 'pu');
    expect(charts.map((c) => [c.title, c.unit, c.series.map((s) => s.name)])).toEqual([
      ['Bus voltage', 'pu', ['Bus_1_v']],
      // The plot puts the angle on a second axis; on paper it is a chart of its own.
      ['Bus angle', '°', ['Bus_1_a']],
      ['Generator speed', 'pu', ['Gen_1_omega']],
    ]);
    // Radians as streamed, degrees as shown.
    expect(charts[1]!.series[0]!.y[1]).toBeCloseTo(30, 9);
    expect(Array.from(charts[0]!.series[0]!.t)).toEqual([0, 0.1, 0.2]);
  });

  it('follows the units switch: kV and Hz where the run has the bases', () => {
    const charts = reportChartsOf(run, new Set(['Bus_1_v', 'Gen_1_omega']), 'actual');
    expect(charts.map((c) => c.unit)).toEqual(['kV', 'Hz']);
    expect(charts[0]!.series[0]!.y[0]).toBeCloseTo(230, 9);
    expect(charts[1]!.series[0]!.y[1]).toBeCloseTo(60.6, 9);
  });

  it('charts only what is selected, and nothing for a selection of nothing', () => {
    expect(reportChartsOf(run, new Set(['Gen_1_omega']), 'pu').map((c) => c.title)).toEqual([
      'Generator speed',
    ]);
    expect(reportChartsOf(run, new Set(), 'pu')).toEqual([]);
  });
});

describe('collectReportData', () => {
  it('has nothing for a tab with no results', () => {
    const data = collectReportData();
    expect(data).toMatchObject({
      caseName: 'Results',
      files: [],
      pflow: null,
      comparison: null,
      runs: [],
      eig: null,
    });
  });

  it('names the case by its file, and lists the files it was opened from', () => {
    openCase();
    const data = collectReportData(new Date(2026, 9, 5, 14, 2));
    expect(data.caseName).toBe('two_bus');
    expect(data.files).toEqual(['two_bus.raw', 'two_bus.dyr']);
    expect(data.generatedAt).toEqual(new Date(2026, 9, 5, 14, 2));
  });

  it('calls a system built from scratch a new system', () => {
    useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
    expect(collectReportData().caseName).toBe('New system');
  });

  it('takes the last power flow, the names of its elements and the limits it breaks', () => {
    openCase();
    usePflowStore.setState({ lastRun: pf('pf-1') });
    const { pflow } = collectReportData();
    expect(pflow?.result.run_id).toBe('pf-1');
    expect(pflow?.names.buses).toEqual({ '1': 'North', '2': 'South' });
    expect(pflow?.origin).toBeUndefined();
    // Bus 2 at 0.93 against a vmin of 0.95.
    expect(pflow?.violations?.violationCount).toBe(1);
    expect(pflow?.violations?.items[0]).toMatchObject({ idx: '2', finding: 'Below vmin' });
  });

  it('reports a power flow that did not converge as the last one, without falling back', () => {
    openCase();
    usePflowHistoryStore
      .getState()
      .record(pf('pf-1'), { caseName: 'two_bus', names: NO_ELEMENT_NAMES });
    usePflowStore.setState({ lastRun: pf('pf-2', { converged: false, summary: null }) });
    expect(collectReportData().pflow?.result.run_id).toBe('pf-2');
  });

  describe('once a time-domain run has moved the system on', () => {
    beforeEach(() => {
      openCase();
      usePflowHistoryStore.getState().record(pf('pf-1'), {
        caseName: 'two_bus',
        names: { ...NO_ELEMENT_NAMES, buses: { '1': 'North (kept)', '2': 'South (kept)' } },
      });
      usePflowStore.setState({ lastRun: operatingPoint() });
    });

    it('reports the last power flow that was solved, not the state the run ended at', () => {
      const { pflow } = collectReportData();
      expect(pflow?.result.run_id).toBe('pf-1');
      expect(pflow?.result.summary).not.toBeNull();
      // With the names it was kept with.
      expect(pflow?.names.buses['1']).toBe('North (kept)');
      expect(pflow?.origin).toMatch(/^PF #1, solved on two_bus at \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      // It is of the open case, so its limits are that case's.
      expect(pflow?.violations?.violationCount).toBe(1);
    });

    it('does not judge a power flow of another case by the open case limits', () => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('other.raw'), addfiles: [] },
      });
      const { pflow } = collectReportData();
      expect(pflow?.result.run_id).toBe('pf-1');
      expect(pflow?.violations).toBeNull();
    });

    it('gives the operating point, as what it is, when no power flow was kept', () => {
      usePflowHistoryStore.getState().clear();
      const { pflow } = collectReportData();
      expect(pflow?.result.run_id).toBe('op-1');
      expect(pflow?.origin).toBeUndefined();
    });
  });

  it('reports the newest kept power flow after a reload, with no case open', () => {
    usePflowHistoryStore.getState().record(pf('pf-1'), {
      caseName: 'two_bus',
      names: NO_ELEMENT_NAMES,
    });
    const data = collectReportData();
    expect(data.caseName).toBe('Results');
    expect(data.pflow?.result.run_id).toBe('pf-1');
    expect(data.pflow?.violations).toBeNull();
  });

  it('compares the two power flows the Compare tab compares, and none with one kept', () => {
    usePflowHistoryStore
      .getState()
      .record(pf('pf-1'), { caseName: 'two_bus', names: NO_ELEMENT_NAMES });
    expect(collectReportData().comparison).toBeNull();

    usePflowHistoryStore.getState().record(pf('pf-2', { bus_voltages: { '1': 1.02, '2': 0.9 } }), {
      caseName: 'two_bus_edited',
      names: NO_ELEMENT_NAMES,
    });
    usePflowHistoryStore.getState().rename('pf-1', 'Base case');
    const { comparison } = collectReportData();
    expect(comparison?.a).toMatchObject({ label: 'Base case', caseName: 'two_bus' });
    expect(comparison?.b).toMatchObject({ label: 'PF #2', caseName: 'two_bus_edited' });
    expect(comparison?.comparison.maxDV?.value).toBeCloseTo(-0.03, 12);
  });

  describe('the time-domain runs', () => {
    function seed(runId: string, columns: string[]): void {
      useRunsStore
        .getState()
        .startRun({ runId, tf: 2, columnNames: columns, scenario: 'fault bus 2' });
      useRunsStore.getState().appendFrame(runId, {
        t: new Float64Array([0, 1, 2]),
        columns: Object.fromEntries(columns.map((c) => [c, new Float64Array([1, 0.8, 1])])),
      });
      useRunsStore.getState().markRunDone(runId, 2, true);
    }

    it('lists every run kept and charts the one on the plot with what the plot has picked', () => {
      seed('r1', ['Bus_1_v', 'Bus_2_v']);
      seed('r2', ['Bus_1_v', 'Bus_2_v', 'Gen_1_omega']);
      usePlotStore.getState().setSelection('r2', new Set(['Gen_1_omega']));

      const { runs } = collectReportData();

      expect(runs.map((r) => [r.label, r.outcome, r.tf, r.tEnd, r.rows])).toEqual([
        ['TDS #1 - fault bus 2', 'done', 2, 2, 3],
        ['TDS #2 - fault bus 2', 'done', 2, 2, 3],
      ]);
      // r2 is the active run: it is the one plotted.
      expect(runs[0]!.charts).toEqual([]);
      expect(runs[1]!.charts.map((c) => c.title)).toEqual(['Generator speed']);
      expect(runs[1]!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('charts the bus voltages of a run the plot never picked variables of', () => {
      seed('r1', ['Bus_1_v', 'Bus_2_v', 'Gen_1_omega']);
      const { runs } = collectReportData();
      expect(runs[0]!.charts).toHaveLength(1);
      expect(runs[0]!.charts[0]!.series.map((s) => s.name)).toEqual(['Bus_1_v', 'Bus_2_v']);
    });

    it('charts every pinned run with the one selection the plot has, as the plot does', () => {
      seed('r1', ['Bus_1_v', 'Bus_2_v']);
      seed('r2', ['Bus_1_v', 'Bus_2_v']);
      useRunsStore.getState().clearActiveRun();
      useRunsStore.getState().setOverlayRuns(['r1', 'r2']);
      // With no active run the plot keys its selection on the oldest pinned run.
      usePlotStore.getState().setSelection('r1', new Set(['Bus_2_v']));

      const { runs } = collectReportData();
      expect(runs.map((r) => r.charts.flatMap((c) => c.series.map((s) => s.name)))).toEqual([
        ['Bus_2_v'],
        ['Bus_2_v'],
      ]);
    });

    it('charts none when no run is active or pinned, and still lists them', () => {
      seed('r1', ['Bus_1_v']);
      useRunsStore.getState().clearActiveRun();
      const { runs } = collectReportData();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.charts).toEqual([]);
    });
  });

  it('takes the eigenvalues when an eigenvalue analysis has run', () => {
    useAnalyzeStore.setState({ eigResult: EIG });
    expect(collectReportData().eig).toBe(EIG);
  });
});

describe('makeHtmlReport', () => {
  it('is nothing when there is nothing to report, and asks the server nothing', async () => {
    const fetchSpy = serve();
    expect(await makeHtmlReport()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds the versions, and the ANDES reports of the routines that have a result', async () => {
    openCase();
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    usePflowStore.setState({ lastRun: pf('pf-1') });
    useAnalyzeStore.setState({ eigResult: EIG });
    const fetchSpy = serve({ pflow: 'BUS DATA:\n1  1.02\n', eig: 'EIGENVALUE ANALYSIS REPORT\n' });

    const report = await makeHtmlReport(new Date(2026, 9, 5, 14, 2));

    const asked = fetchSpy.mock.calls.map(([url]) => String(url)).sort();
    expect(asked).toEqual([
      '/api/sessions/sess-1/report?routine=eig',
      '/api/sessions/sess-1/report?routine=pflow',
      '/api/version',
    ]);
    const doc = parse(report!.html);
    expect(report!.caseName).toBe('two_bus');
    expect(doc.querySelector('header .meta')?.textContent).toContain(
      'by TENSA 0.4.0 with ANDES 2.0.0',
    );
    const appendix = doc.querySelector('#andes-reports')!;
    expect([...appendix.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'Power flow',
      'Eigenvalue analysis',
    ]);
    expect(appendix.querySelector('pre')?.textContent).toBe('BUS DATA:\n1  1.02\n');
    expect(doc.querySelector('#power-flow')).not.toBeNull();
    expect(doc.querySelector('#eigenvalues')).not.toBeNull();
  });

  it('asks for the time-domain report of a finished active run, not of one still streaming', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1, columnNames: ['Bus_1_v'] });
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([0, 1]),
      columns: { Bus_1_v: new Float64Array([1, 1]) },
    });
    let fetchSpy = serve({ tds: 'Time Domain Simulation Summary' });
    await makeHtmlReport();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['/api/version']);
    fetchSpy.mockRestore();

    useRunsStore.getState().markRunDone('r1', 1, true);
    fetchSpy = serve({ tds: 'Time Domain Simulation Summary' });
    const report = await makeHtmlReport();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain(
      '/api/sessions/sess-1/report?routine=tds',
    );
    expect(parse(report!.html).querySelector('#andes-reports h3')?.textContent).toBe(
      'Time-domain simulation',
    );
  });

  it('does not ask for the power-flow text of an operating point read after a run', async () => {
    openCase();
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    usePflowStore.setState({ lastRun: operatingPoint() });
    const fetchSpy = serve({ pflow: 'BUS DATA:' });
    await makeHtmlReport();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['/api/version']);
  });

  it('writes the report without what the server would not give', async () => {
    openCase();
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    usePflowStore.setState({ lastRun: pf('pf-1') });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const report = await makeHtmlReport(new Date(2026, 9, 5, 14, 2));

    const doc = parse(report!.html);
    expect(doc.querySelector('header .meta')?.textContent).toContain('by TENSA. Case files');
    expect(doc.querySelector('#andes-reports')).toBeNull();
    expect(doc.querySelector('#power-flow table')).not.toBeNull();
  });

  it('asks the server for no report without a session, as after a reload', async () => {
    usePflowHistoryStore
      .getState()
      .record(pf('pf-1'), { caseName: 'two_bus', names: NO_ELEMENT_NAMES });
    const fetchSpy = serve({ pflow: 'BUS DATA:' });
    const report = await makeHtmlReport();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['/api/version']);
    expect(parse(report!.html).querySelector('#power-flow')).not.toBeNull();
  });
});

describe('exportHtmlReport', () => {
  let downloads: DownloadCapture;
  beforeEach(() => {
    downloads = captureDownloads();
  });
  afterEach(() => downloads.restore());

  it('saves nothing, and says so, when there is nothing to report', async () => {
    serve();
    expect(await exportHtmlReport()).toBeNull();
    expect(downloads.blobs).toEqual([]);
  });

  it('hands the browser an HTML file named for the case', async () => {
    openCase();
    usePflowStore.setState({ lastRun: pf('pf-1') });
    serve();

    const filename = await exportHtmlReport();

    expect(filename).toMatch(/^two_bus_report_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.html$/);
    expect(downloads.filenames).toEqual([filename]);
    expect(downloads.blobs[0]!.type).toBe('text/html;charset=utf-8');
    const html = await readBlob(downloads.blobs[0]!);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(parse(html).querySelector('h1')?.textContent).toBe('two_bus');
  });
});
