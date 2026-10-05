/**
 * The HTML report as a document: what each section holds, that a name from a
 * case file cannot become markup, and the charts' ticks and thinning.
 */
import { describe, expect, it } from 'vitest';
import { parseRunId } from '@/api/types';
import type { EigResult, PflowResult } from '@/api/types';
import type { ElementNames } from '@/lib/elementNames';
import {
  buildHtmlReport,
  escapeHtml,
  formatReportTime,
  hasReportContent,
  MAX_CHART_SERIES,
  niceTicks,
  svgLineChart,
  thinSeries,
  type HtmlReportData,
  type ReportRun,
} from '@/lib/htmlReport';
import { comparePflow } from '@/lib/pflowCompare';
import { collectViolations } from '@/lib/violations';
import { LIMITS_TOPOLOGY, limitsPflow } from '../helpers/limitsCase';
import { lineFlow } from '../helpers/lineFlow';

const NAMES: ElementNames = {
  buses: { '1': 'North', '2': 'South' },
  lines: { L1: 'North-South' },
  generators: { G1: 'Hydro' },
  loads: { D1: 'Town' },
};

function pf(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('pf-1'),
    converged: true,
    iterations: 4,
    mismatch: 3.2e-9,
    bus_voltages: { '1': 1.02, '2': 0.9731 },
    bus_angles: { '1': 0, '2': -0.05 },
    line_flows: {
      L1: lineFlow(
        60,
        10,
        { from: 1, to: 2 },
        { p_to: -58.8, q_to: -9, loss: 1.2, rate_a: 100, loading_pct: 60.8 },
      ),
    },
    generator_outputs: { G1: { p: 60, q: 10, v: 1.02, bus: 1, q_min: -20, q_max: 30 } },
    load_consumption: { D1: { p: 58.8, q: 9, bus: 2 } },
    settings: { tolerance: 1e-6, max_iterations: 25, flat_start: false, enforce_q_limits: false },
    summary: {
      generation_p: 60,
      generation_q: 10,
      load_p: 58.8,
      load_q: 9,
      shunt_p: 0,
      shunt_q: 0,
      loss_p: 1.2,
      loss_q: 1,
      slack_p: 60,
      slack_q: 10,
    },
    ...overrides,
  };
}

function data(overrides: Partial<HtmlReportData> = {}): HtmlReportData {
  return {
    caseName: 'two_bus',
    files: ['two_bus.raw', 'two_bus.dyr'],
    generatedAt: new Date(2026, 9, 5, 14, 2),
    versions: { tensa: '0.4.0', andes: '2.0.0' },
    pflow: null,
    comparison: null,
    runs: [],
    eig: null,
    andesReports: [],
    ...overrides,
  };
}

/** The document as a DOM, to read it the way a browser will. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function tableAfter(doc: Document, heading: string): HTMLTableElement {
  const h = [...doc.querySelectorAll('h2, h3')].find((el) => el.textContent?.startsWith(heading));
  if (!h) throw new Error(`no heading "${heading}"`);
  let el = h.nextElementSibling;
  while (el !== null && el.querySelector('table') === null && el.tagName !== 'TABLE') {
    el = el.nextElementSibling;
  }
  const table = el?.tagName === 'TABLE' ? el : el?.querySelector('table');
  if (!table) throw new Error(`no table after "${heading}"`);
  return table as HTMLTableElement;
}

function rowsOf(table: HTMLTableElement): string[][] {
  return [...table.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''),
  );
}

function headersOf(table: HTMLTableElement): string[] {
  return [...table.querySelectorAll('thead th')].map((th) => th.textContent ?? '');
}

describe('buildHtmlReport: the document', () => {
  it('is one self-contained HTML document: no script, nothing fetched', () => {
    const html = buildHtmlReport(data({ pflow: { result: pf(), names: NAMES, violations: null } }));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const doc = parse(html);
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('link')).toBeNull();
    expect(doc.querySelector('img')).toBeNull();
    expect(html).not.toMatch(/\bsrc=|url\(|@import|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    // Its own policy forbids scripts and requests, whatever a name in it holds.
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute('content')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    expect(doc.querySelector('meta[charset]')?.getAttribute('charset')).toBe('utf-8');
    expect(doc.querySelector('style')?.textContent).toContain('@media print');
  });

  it('heads the report with the case, when it was made, the versions and the files', () => {
    const doc = parse(
      buildHtmlReport(data({ eig: null, pflow: { result: pf(), names: NAMES, violations: null } })),
    );
    expect(doc.title).toBe('TENSA report: two_bus');
    expect(doc.querySelector('h1')?.textContent).toBe('two_bus');
    const meta = doc.querySelector('header .meta')?.textContent;
    expect(meta).toBe(
      'Report made 2026-10-05 14:02 by TENSA 0.4.0 with ANDES 2.0.0. Case files: two_bus.raw, two_bus.dyr.',
    );
  });

  it('does without the versions when the server did not give them', () => {
    const doc = parse(buildHtmlReport(data({ versions: null, files: [] })));
    expect(doc.querySelector('header .meta')?.textContent).toBe(
      'Report made 2026-10-05 14:02 by TENSA.',
    );
  });

  it('says so when there is nothing to report', () => {
    const doc = parse(buildHtmlReport(data()));
    expect(doc.querySelector('section')).toBeNull();
    expect(doc.body.textContent).toContain('There are no results to report yet.');
  });

  it('links to each section it has, in order', () => {
    const run: ReportRun = {
      label: 'TDS #1',
      outcome: 'done',
      startedAt: '2026-10-05 13:58',
      tf: 5,
      tEnd: 5,
      rows: 151,
      charts: [],
    };
    const doc = parse(
      buildHtmlReport(
        data({
          pflow: { result: pf(), names: NAMES, violations: null },
          runs: [run],
          andesReports: [{ title: 'Power flow', text: 'BUS DATA:' }],
        }),
      ),
    );
    const links = [...doc.querySelectorAll('nav a')].map((a) => [
      a.getAttribute('href'),
      a.textContent,
    ]);
    expect(links).toEqual([
      ['#power-flow', 'Power flow'],
      ['#time-domain', 'Time-domain runs'],
      ['#andes-reports', 'ANDES reports'],
    ]);
    for (const [href] of links) expect(doc.querySelector(href!)).not.toBeNull();
  });
});

describe('buildHtmlReport: a name from a case file cannot become markup', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

  it('escapes element names, the case name, file names and run names', () => {
    const names: ElementNames = {
      buses: { '1': hostile, '2': 'South' },
      lines: { L1: hostile },
      generators: { G1: hostile },
      loads: { D1: hostile },
    };
    const html = buildHtmlReport(
      data({
        caseName: hostile,
        files: [hostile],
        pflow: { result: pf(), names, violations: null, origin: hostile },
        comparison: {
          a: { label: hostile, caseName: hostile, takenAt: hostile },
          b: { label: 'PF #2', caseName: 'x', takenAt: 'now' },
          comparison: comparePflow({ result: pf(), names }, { result: pf(), names }),
        },
        runs: [
          {
            label: hostile,
            outcome: hostile,
            startedAt: hostile,
            tf: 1,
            tEnd: 1,
            rows: 2,
            charts: [
              { title: hostile, unit: hostile, series: [{ name: hostile, t: [0, 1], y: [1, 2] }] },
            ],
          },
        ],
        andesReports: [{ title: hostile, text: `${hostile}\n</pre><script>alert(3)</script>` }],
      }),
    );
    const doc = parse(html);
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    // The text is all there, as text.
    expect(doc.querySelector('h1')?.textContent).toBe(hostile);
    expect(rowsOf(tableAfter(doc, 'Buses'))[0]?.[1]).toBe(hostile);
    expect(doc.querySelector('pre')?.textContent).toContain('</pre><script>alert(3)</script>');
    expect(doc.querySelector('svg')?.getAttribute('aria-label')).toContain(hostile);
  });

  it('escapeHtml covers what ends an element or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;',
    );
    expect(escapeHtml(12.5)).toBe('12.5');
  });
});

describe('buildHtmlReport: the power flow', () => {
  const report = () =>
    parse(buildHtmlReport(data({ pflow: { result: pf(), names: NAMES, violations: null } })));

  it('says how it converged and what it ran with', () => {
    const text = report().querySelector('#power-flow')?.textContent;
    expect(text).toContain('Converged in 4 iterations, final mismatch 3.20e-9.');
    expect(text).toContain('It ran with tolerance 1e-6, up to 25 iterations');
  });

  it('gives the system totals, as the summary panel does', () => {
    const table = tableAfter(report(), 'System totals');
    expect(headersOf(table)).toEqual(['quantity', 'P (MW)', 'Q (MVAr)']);
    expect(rowsOf(table)).toEqual([
      ['Generation', '60.00', '10.00'],
      ['Load', '58.80', '9.00'],
      ['Bus shunts', '0.00', '0.00'],
      ['Line losses', '1.20', '1.00'],
      ['of which slack', '60.00', '10.00'],
    ]);
    expect(report().querySelector('#power-flow')?.textContent).toContain(
      'the lines lose 2.00% of the active generation',
    );
  });

  it('lists every bus with its name, its voltage and its angle in degrees', () => {
    const table = tableAfter(report(), 'Buses (2)');
    expect(headersOf(table)).toEqual(['idx', 'name', 'V (pu)', 'angle (deg)']);
    expect(rowsOf(table)).toEqual([
      ['1', 'North', '1.0200', '0.000'],
      ['2', 'South', '0.9731', '-2.865'],
    ]);
  });

  it('lists the lines with the flow at both ends, the loss and the loading', () => {
    const table = tableAfter(report(), 'Lines and transformers (1)');
    expect(rowsOf(table)).toEqual([
      ['L1', 'North-South', '1', '2', '60.00', '10.00', '-58.80', '-9.00', '1.200', '60.8'],
    ]);
  });

  it('lists the generators with their reactive limits, and the loads', () => {
    expect(rowsOf(tableAfter(report(), 'Generators (1)'))).toEqual([
      ['G1', 'Hydro', '1', '60.00', '10.00', '1.0200', '-20.00', '30.00'],
    ]);
    expect(rowsOf(tableAfter(report(), 'Loads (1)'))).toEqual([
      ['D1', 'Town', '2', '58.80', '9.00'],
    ]);
  });

  it('marks the numeric columns, which a reader and a printer align right', () => {
    const table = tableAfter(report(), 'Buses (2)');
    const classes = [...table.querySelectorAll('tbody tr:first-child td')].map(
      (td) => td.className,
    );
    expect(classes).toEqual(['', '', 'n', 'n']);
  });

  it('leaves a value there is none of empty, and falls back to the idx for a name', () => {
    const doc = parse(
      buildHtmlReport(
        data({
          pflow: {
            result: pf({
              line_flows: { L9: lineFlow(5, 1, { from: 1, to: 2 }) },
              generator_outputs: { G9: { p: 5, q: 1, v: 1, bus: 1, q_min: null, q_max: null } },
            }),
            names: NAMES,
            violations: null,
          },
        }),
      ),
    );
    const line = rowsOf(tableAfter(doc, 'Lines and transformers'))[0]!;
    expect(line[1]).toBe('L9');
    expect(line.at(-1)).toBe('');
    expect(rowsOf(tableAfter(doc, 'Generators'))[0]?.slice(-2)).toEqual(['', '']);
  });

  it('lists the limits the result breaks, the violations first', () => {
    const result = limitsPflow();
    const doc = parse(
      buildHtmlReport(
        data({
          pflow: {
            result,
            names: NAMES,
            violations: collectViolations(result, LIMITS_TOPOLOGY),
          },
        }),
      ),
    );
    expect(doc.querySelector('#power-flow')?.textContent).toContain(
      '4 violations and 3 warnings. Checked 3 bus voltages, 3 rated lines and 2 generators; 1 line has no rating and is not checked for overload.',
    );
    const table = tableAfter(doc, 'Limits');
    expect(headersOf(table)).toEqual([
      'severity',
      'type',
      'name',
      'idx',
      'finding',
      'value',
      'limit',
      'unit',
    ]);
    const rows = rowsOf(table);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual([
      'Violation',
      'Bus voltage',
      'Bus1',
      '1',
      'Above vmax',
      '1.070',
      '1.050',
      'pu',
    ]);
    expect(rows.map((r) => r[0])).toEqual([
      'Violation',
      'Violation',
      'Violation',
      'Violation',
      'Warning',
      'Warning',
      'Warning',
    ]);
  });

  it('says that no limit is broken without a table of none', () => {
    const result = pf();
    const calm = collectViolations(result, {
      state: 'committed',
      buses: [
        { idx: 1, name: 'North', kind: 'Bus', params: { vmin: 0.9, vmax: 1.1 } },
        { idx: 2, name: 'South', kind: 'Bus', params: { vmin: 0.9, vmax: 1.1 } },
      ],
      lines: [{ idx: 'L1', name: 'North-South', kind: 'Line' }],
      transformers: [],
      generators: [{ idx: 'G1', name: 'Hydro', kind: 'Slack' }],
      loads: [],
    });
    const doc = parse(buildHtmlReport(data({ pflow: { result, names: NAMES, violations: calm } })));
    const limits = [...doc.querySelectorAll('h3')].find((h) => h.textContent === 'Limits')!;
    expect(limits.nextElementSibling?.textContent).toBe(
      'No limit is violated. Checked 2 bus voltages, 1 rated line and 1 generator.',
    );
    expect(limits.nextElementSibling?.nextElementSibling?.tagName).toBe('H3');
  });

  it('says a power flow did not converge, and gives no tables for it', () => {
    const doc = parse(
      buildHtmlReport(
        data({
          pflow: {
            result: pf({ converged: false, iterations: 26, mismatch: 0.42, summary: null }),
            names: NAMES,
            violations: null,
          },
        }),
      ),
    );
    const section = doc.querySelector('#power-flow')!;
    expect(section.textContent).toContain('did not converge in 26 iterations');
    expect(section.querySelector('table')).toBeNull();
  });

  it('calls the state read after a time-domain run an operating point, not a power flow', () => {
    const doc = parse(
      buildHtmlReport(
        data({
          pflow: {
            result: pf({
              line_flows: {},
              generator_outputs: {},
              load_consumption: {},
              summary: null,
              settings: null,
            }),
            names: NAMES,
            violations: null,
          },
        }),
      ),
    );
    const section = doc.querySelector('#power-flow')!;
    expect(section.querySelector('h2')?.textContent).toBe('Operating point');
    expect(section.textContent).toContain('read after a time-domain run');
    expect(section.textContent).not.toContain('Converged in');
    expect([...section.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Buses (2)']);
  });

  it('says which kept power flow it reports when it is not the one on screen', () => {
    const doc = parse(
      buildHtmlReport(
        data({
          pflow: {
            result: pf(),
            names: NAMES,
            violations: null,
            origin: 'PF #2, solved on two_bus at 2026-10-05 13:40',
          },
        }),
      ),
    );
    expect(doc.querySelector('#power-flow .meta')?.textContent).toBe(
      'The last power flow solved: PF #2, solved on two_bus at 2026-10-05 13:40.',
    );
  });
});

describe('buildHtmlReport: the comparison', () => {
  const a = { result: pf(), names: NAMES };
  const b = {
    result: pf({ bus_voltages: { '1': 1.02, '2': 0.95 } }),
    names: NAMES,
  };
  const doc = parse(
    buildHtmlReport(
      data({
        comparison: {
          a: { label: 'Base case', caseName: 'two_bus', takenAt: '2026-10-05 13:40' },
          b: { label: 'PF #2', caseName: 'two_bus', takenAt: '2026-10-05 13:55' },
          comparison: comparePflow(a, b),
        },
      }),
    ),
  );

  it('names the two results and says which way the differences go', () => {
    const section = doc.querySelector('#comparison')!;
    expect([...section.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'A (reference): Base case, two_bus, solved 2026-10-05 13:40',
      'B: PF #2, two_bus, solved 2026-10-05 13:55',
    ]);
    expect(section.textContent).toContain(
      'Largest change: ΔV -0.0231 pu at South (2). Every difference is B minus A.',
    );
  });

  it('prints the same tables as the Compare tab, the differences with their sign', () => {
    const table = tableAfter(doc, 'Buses (2)');
    expect(headersOf(table)).toEqual([
      'idx',
      'name',
      'V A (pu)',
      'V B (pu)',
      'ΔV (pu)',
      'θ A (deg)',
      'θ B (deg)',
      'Δθ (deg)',
    ]);
    expect(rowsOf(table)[0]).toEqual([
      '2',
      'South',
      '0.9731',
      '0.9500',
      '-0.02310',
      '-2.865',
      '-2.865',
      '0.0000',
    ]);
    expect(rowsOf(tableAfter(doc, 'Totals (5)'))[0]?.[0]).toBe('Generation');
  });

  it('leaves out a table that has no rows', () => {
    const bare = { result: pf({ load_consumption: {}, summary: null }), names: NAMES };
    const other = parse(
      buildHtmlReport(
        data({
          comparison: {
            a: { label: 'A', caseName: 'x', takenAt: 't' },
            b: { label: 'B', caseName: 'x', takenAt: 't' },
            comparison: comparePflow(bare, bare),
          },
        }),
      ),
    );
    const headings = [...other.querySelectorAll('#comparison h3')].map((h) => h.textContent);
    expect(headings).toEqual(['Buses (2)', 'Lines (1)', 'Generators (1)']);
  });
});

describe('buildHtmlReport: the time-domain runs', () => {
  const t = [0, 0.5, 1, 1.5, 2];
  const plotted: ReportRun = {
    label: 'TDS #2 - fault bus 7',
    outcome: 'done',
    startedAt: '2026-10-05 13:58',
    tf: 2,
    tEnd: 2,
    rows: 5,
    charts: [
      {
        title: 'Bus voltage',
        unit: 'pu',
        series: [
          { name: 'Bus_1_v', t, y: [1.0, 0.62, 0.95, 1.01, 1.0] },
          { name: 'Bus_2_v', t, y: [0.98, 0.7, 0.93, 0.99, 0.98] },
        ],
      },
    ],
  };
  const listed: ReportRun = {
    label: 'TDS #1',
    outcome: 'halted early',
    startedAt: '2026-10-04 09:10',
    tf: 20,
    tEnd: 3.25,
    rows: 98,
    charts: [],
  };
  const doc = parse(buildHtmlReport(data({ runs: [listed, plotted] })));

  it('lists every run kept, with how it ended and how far it got', () => {
    const table = doc.querySelector('#time-domain table') as HTMLTableElement;
    expect(headersOf(table)).toEqual([
      'run',
      'started',
      'outcome',
      'tf (s)',
      'reached t (s)',
      'rows',
    ]);
    expect(rowsOf(table)).toEqual([
      ['TDS #1', '2026-10-04 09:10', 'halted early', '20.000', '3.250', '98'],
      ['TDS #2 - fault bus 7', '2026-10-05 13:58', 'done', '2.000', '2.000', '5'],
    ]);
  });

  it('draws a chart of each plotted quantity, as inline SVG with a legend', () => {
    const figures = doc.querySelectorAll('#time-domain figure');
    expect(figures).toHaveLength(1);
    const figure = figures[0]!;
    expect(figure.querySelector('figcaption')?.textContent).toBe('Bus voltage (pu)');
    const svg = figure.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Bus voltage (pu) over time');
    expect(svg.querySelectorAll('polyline')).toHaveLength(2);
    // Five samples, five points on the line.
    expect(svg.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(5);
    expect([...figure.querySelectorAll('.legend span')].map((s) => s.textContent)).toEqual([
      'Bus_1_v',
      'Bus_2_v',
    ]);
    expect(svg.textContent).toContain('time (s)');
  });

  it('heads the charts with the run they are of, and only for a run that has charts', () => {
    expect([...doc.querySelectorAll('#time-domain h3')].map((h) => h.textContent)).toEqual([
      'TDS #2 - fault bus 7',
    ]);
  });

  it('gives where each series started, its lowest and highest value and when, and where it ended', () => {
    const table = doc.querySelectorAll('#time-domain table')[1] as HTMLTableElement;
    expect(headersOf(table)).toEqual([
      'series',
      'initial (pu)',
      'lowest (pu)',
      'at t (s)',
      'highest (pu)',
      'at t (s)',
      'final (pu)',
    ]);
    expect(rowsOf(table)).toEqual([
      ['Bus_1_v', '1', '0.62', '0.500', '1.01', '1.500', '1'],
      ['Bus_2_v', '0.98', '0.7', '0.500', '0.99', '1.500', '0.98'],
    ]);
  });

  it('says how to get a chart when no run was on the plot', () => {
    const none = parse(buildHtmlReport(data({ runs: [listed] })));
    expect(none.querySelector('#time-domain figure')).toBeNull();
    expect(none.querySelector('#time-domain')?.textContent).toContain(
      'Pin a run in History and pick variables on the Plot tab to chart it.',
    );
  });
});

describe('buildHtmlReport: the eigenvalues and the ANDES reports', () => {
  const eig: EigResult = {
    eigenvalues: [
      { real: -0.5, imag: 6.2832 },
      { real: 0.02, imag: 3.1 },
      { real: -1.2, imag: 0 },
    ],
    damping_ratios: [0.0793, -0.0065, 1],
    frequencies_hz: [1.0, 0.4934, 0],
    mode_count: 3,
    state_count: 3,
    state_names: ['delta', 'omega', 'e1q'],
    tds_initialized: true,
  };

  it('lists the modes, the least damped first, and counts the unstable ones', () => {
    const doc = parse(buildHtmlReport(data({ eig })));
    const section = doc.querySelector('#eigenvalues')!;
    expect(section.textContent).toContain('3 modes of 3 states. 1 has a positive real part.');
    expect(rowsOf(section.querySelector('table') as HTMLTableElement)).toEqual([
      ['2', '0.0200', '3.1000', '-0.65', '0.4934'],
      ['1', '-0.5000', '6.2832', '7.93', '1.0000'],
      ['3', '-1.2000', '0.0000', '100.00', '0.0000'],
    ]);
  });

  it('says none is unstable when none is', () => {
    const stable = { ...eig, eigenvalues: eig.eigenvalues.map((e) => ({ ...e, real: -1 })) };
    expect(parse(buildHtmlReport(data({ eig: stable }))).body.textContent).toContain(
      'None has a positive real part.',
    );
  });

  it('appends the text ANDES wrote, as it wrote it', () => {
    const text = 'BUS DATA:\n\n     Vm(pu)   Va(rad.)\n1    1.03     0\n';
    const doc = parse(buildHtmlReport(data({ andesReports: [{ title: 'Power flow', text }] })));
    const section = doc.querySelector('#andes-reports')!;
    expect(section.querySelector('h3')?.textContent).toBe('Power flow');
    expect(section.querySelector('pre')?.textContent).toBe(text);
  });
});

describe('hasReportContent', () => {
  const nothing = { pflow: null, comparison: null, runs: [], eig: null };

  it('is false with no result of any kind, and true with any one', () => {
    expect(hasReportContent(nothing)).toBe(false);
    expect(
      hasReportContent({ ...nothing, pflow: { result: pf(), names: NAMES, violations: null } }),
    ).toBe(true);
    expect(
      hasReportContent({
        ...nothing,
        runs: [{ label: 'r', outcome: 'done', startedAt: '', tf: 1, tEnd: 1, rows: 1, charts: [] }],
      }),
    ).toBe(true);
  });
});

describe('formatReportTime', () => {
  it('writes a local date and time to the minute', () => {
    expect(formatReportTime(new Date(2026, 0, 9, 7, 5, 59))).toBe('2026-01-09 07:05');
  });
});

describe('niceTicks', () => {
  it('gives round values inside the range', () => {
    expect(niceTicks(0, 5, 8)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0.893, 1.104, 5)).toEqual([0.9, 0.95, 1, 1.05, 1.1]);
    expect(niceTicks(-12, 37, 5)).toEqual([-10, 0, 10, 20, 30]);
  });

  it('does not carry the rounding of repeated addition into a label', () => {
    for (const tick of niceTicks(0, 1, 10)) {
      expect(String(tick).length).toBeLessThanOrEqual(3);
    }
  });

  it('handles a range of one value and a range that is not a number', () => {
    expect(niceTicks(2, 2)).toEqual([2]);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });
});

describe('thinSeries', () => {
  it('keeps every point of a short series, in order, and skips what is not a number', () => {
    expect(thinSeries([0, 1, 2, 3], [1, Number.NaN, 3, 4])).toEqual([
      [0, 1],
      [2, 3],
      [3, 4],
    ]);
  });

  it('thins a long series without losing a spike between two drawn points', () => {
    const n = 10_000;
    const t = Float64Array.from({ length: n }, (_, i) => i / 100);
    const y = new Float64Array(n).fill(1);
    y[4321] = 9; // one sample, far above the rest
    y[7777] = -5;
    const points = thinSeries(t, y, 200);
    expect(points.length).toBeLessThanOrEqual(200);
    expect(points.length).toBeGreaterThan(50);
    expect(points.some(([, v]) => v === 9)).toBe(true);
    expect(points.some(([, v]) => v === -5)).toBe(true);
    // Time never goes backwards along the line.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]![0]).toBeGreaterThanOrEqual(points[i - 1]![0]);
    }
  });

  it('counts only the samples both arrays have', () => {
    expect(thinSeries([0, 1, 2], [5, 6])).toEqual([
      [0, 5],
      [1, 6],
    ]);
  });
});

describe('svgLineChart', () => {
  const parseSvg = (svg: string) => parse(`<body>${svg}</body>`);

  it('draws a flat signal in a band of its own', () => {
    const doc = parseSvg(
      svgLineChart({
        title: 'Bus voltage',
        unit: 'pu',
        series: [{ name: 'Bus_1_v', t: [0, 1], y: [1, 1] }],
      }),
    );
    const points = doc.querySelector('polyline')?.getAttribute('points') ?? '';
    // Both points at one height, inside the plot and not on its edge.
    const ys = points.split(' ').map((p) => Number(p.split(',')[1]));
    expect(ys[0]).toBe(ys[1]);
    expect(ys[0]).toBeGreaterThan(10);
    expect(ys[0]).toBeLessThan(218);
    expect(points).not.toContain('NaN');
  });

  it('says there is nothing to draw for a series with no samples', () => {
    const doc = parseSvg(
      svgLineChart({
        title: 'omega',
        unit: '',
        series: [{ name: 'omega GENROU 1', t: [], y: [] }],
      }),
    );
    expect(doc.querySelector('svg')).toBeNull();
    expect(doc.querySelector('figcaption')?.textContent).toBe('omega');
    expect(doc.body.textContent).toContain('No samples to draw.');
  });

  it('draws the first series of a crowded chart and says how many it left out', () => {
    const series = Array.from({ length: MAX_CHART_SERIES + 5 }, (_, i) => ({
      name: `Bus_${i + 1}_v`,
      t: [0, 1],
      y: [1, 1 + i / 100],
    }));
    const doc = parseSvg(svgLineChart({ title: 'Bus voltage', unit: 'pu', series }));
    expect(doc.querySelectorAll('polyline')).toHaveLength(MAX_CHART_SERIES);
    expect(doc.querySelectorAll('.legend span')).toHaveLength(MAX_CHART_SERIES);
    expect(doc.body.textContent).toContain(
      `The first ${MAX_CHART_SERIES} of ${MAX_CHART_SERIES + 5} series are drawn.`,
    );
    // Past the ten colours the lines are dashed, so two of one colour stay apart.
    const dashed = [...doc.querySelectorAll('polyline')].filter((p) =>
      p.hasAttribute('stroke-dasharray'),
    );
    expect(dashed).toHaveLength(MAX_CHART_SERIES - 10);
  });

  it('labels the axes with round numbers', () => {
    const doc = parseSvg(
      svgLineChart({
        title: 'Generator speed',
        unit: 'Hz',
        series: [{ name: 'Gen_1_omega', t: [0, 10], y: [59.8, 60.2] }],
      }),
    );
    const labels = [...doc.querySelectorAll('svg text')].map((el) => el.textContent);
    expect(labels).toEqual(expect.arrayContaining(['59.8', '60', '60.2', '0', '10', 'time (s)']));
  });
});
