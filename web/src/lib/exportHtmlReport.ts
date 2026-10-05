/**
 * Gathers what the HTML report is made from and saves it as a file.
 *
 * ``lib/htmlReport.ts`` turns data into the document; this module finds the
 * data: the stores hold the results the UI shows (the last power flow, the two
 * kept power flows being compared, the time-domain runs and what the plot has
 * picked of them, the eigenvalues), and the server gives its version and ANDES's
 * own plain-text reports for the appendix. What the server cannot give (there is
 * no session, or it has no result for a routine) is left out and the rest is
 * still written.
 *
 * Reached through ``import()`` only (the Report dialog and the Export HTML
 * report command), so none of this is in the entry chunk.
 */
import { andesClient, TIMEOUTS } from '@/api/client';
import type { ReportResponse, ReportRoutine } from '@/api/queries';
import type { VersionInfo } from '@/api/types';
import { downloadBlob } from '@/components/export/downloadBlob';
import { buildFilename, makeTimestamp } from '@/components/export/exportFilename';
import { plotRunId, resolveOverlayRuns } from '@/components/plots/overlayRuns';
import { elementNamesOf } from '@/lib/elementNames';
import {
  buildHtmlReport,
  formatReportTime,
  hasReportContent,
  type HtmlReportData,
  type ReportAndesText,
  type ReportChart,
  type ReportComparison,
  type ReportPflow,
  type ReportRun,
} from '@/lib/htmlReport';
import { baseName, stemOf } from '@/lib/paths';
import { comparePflow } from '@/lib/pflowCompare';
import { displayedSeries } from '@/lib/responseMetrics';
import { runLabel } from '@/lib/runLabel';
import type { UnitMode } from '@/lib/units';
import { collectViolations } from '@/lib/violations';
import { useAnalyzeStore } from '@/store/analyze';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { resolveComparePair, snapshotLabel, usePflowHistoryStore } from '@/store/pflowHistory';
import { chartKeyOf, chartTitle, parseColumnName, usePlotStore, type VarGroup } from '@/store/plot';
import { useRunsStore, type RunRecord } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useUnitsStore } from '@/store/units';

/** The bus voltages a run is charted with when the plot has picked nothing of it. */
const DEFAULT_CHART_SERIES = 12;

const ANDES_REPORT_TITLE: Record<ReportRoutine, string> = {
  pflow: 'Power flow',
  tds: 'Time-domain simulation',
  eig: 'Eigenvalue analysis',
};

/** How a run ended, in a word or two. */
export function runOutcome(run: Pick<RunRecord, 'state' | 'converged'>): string {
  if (run.state === 'starting' || run.state === 'streaming') return 'still running';
  if (run.state === 'aborted') return 'aborted';
  if (run.state === 'error') return 'error';
  return run.converged === false ? 'halted early' : 'done';
}

/** The first bus voltages of a run, for a run the plot never picked variables of. */
function defaultSeries(run: RunRecord): Set<string> {
  const names = new Set<string>();
  for (const name of run.columnNames) {
    const parsed = parseColumnName(name);
    if (parsed?.group === 'bus_v' && parsed.field === 'v') names.add(name);
    if (names.size === DEFAULT_CHART_SERIES) break;
  }
  return names;
}

/**
 * The charts of a run: its selected series in the units the plot shows them
 * in, one chart per quantity and unit. The plot puts a voltage and an angle on
 * two axes of one chart; a chart on paper reads better with one axis, so here
 * they are two charts.
 */
export function reportChartsOf(
  run: RunRecord,
  selected: ReadonlySet<string>,
  mode: UnitMode,
): ReportChart[] {
  const charts = new Map<
    string,
    { group: VarGroup; fields: Set<string>; unit: string; series: ReportChart['series'][number][] }
  >();
  for (const series of displayedSeries(run, selected, mode)) {
    const parsed = parseColumnName(series.name);
    if (parsed === null) continue;
    const key = `${chartKeyOf(parsed)}|${series.unit}`;
    let chart = charts.get(key);
    if (chart === undefined) {
      chart = { group: parsed.group, fields: new Set(), unit: series.unit, series: [] };
      charts.set(key, chart);
    }
    chart.fields.add(parsed.field);
    chart.series.push({ name: series.name, t: series.t, y: series.y });
  }
  return [...charts.values()].map((chart) => ({
    title: chartTitle(chart.group, chart.fields),
    unit: chart.unit,
    series: chart.series,
  }));
}

/**
 * The power flow a report gives. The pflow slice holds the last result on the
 * open case, but after a time-domain run that is the operating point the run
 * ended at (``loadOperatingPointIntoStore``), and after a reload it is nothing.
 * The last power flow that was really solved is then the newest of the kept
 * ones, with the names it was kept with; its limits are checked only when it is
 * of the open case, whose limits they are. With no power flow at all, the
 * operating point is given as what it is.
 */
function reportPflow(caseName: string): ReportPflow | null {
  const { selection, topology } = useCaseStore.getState();
  const lastRun = usePflowStore.getState().lastRun;
  const solved = lastRun !== null && (!lastRun.converged || lastRun.summary != null);
  if (lastRun !== null && solved) {
    return {
      result: lastRun,
      names: elementNamesOf(topology),
      violations: collectViolations(lastRun, topology),
    };
  }
  const { snapshots } = usePflowHistoryStore.getState();
  const latest = snapshots[snapshots.length - 1];
  if (latest !== undefined) {
    const ofOpenCase = selection !== null && latest.caseName === caseName;
    return {
      result: latest.result,
      names: latest.names,
      violations: ofOpenCase ? collectViolations(latest.result, topology) : null,
      origin: `${snapshotLabel(latest)}, solved on ${latest.caseName} at ${formatReportTime(new Date(latest.takenAt))}`,
    };
  }
  if (lastRun === null) return null;
  return {
    result: lastRun,
    names: elementNamesOf(topology),
    violations: collectViolations(lastRun, topology),
  };
}

/** What the stores hold of a report, without what only the server can give. */
export function collectReportData(
  generatedAt: Date = new Date(),
): Omit<HtmlReportData, 'versions' | 'andesReports'> {
  const { selection } = useCaseStore.getState();
  const primaryPath = selection?.primaryPath ?? null;
  const caseName =
    primaryPath !== null ? stemOf(primaryPath) : selection !== null ? 'New system' : 'Results';
  const files = [
    ...(primaryPath === null ? [] : [primaryPath]),
    ...(selection?.addfiles ?? []),
  ].map(baseName);

  const history = usePflowHistoryStore.getState();
  const pflow = reportPflow(caseName);

  const pair = resolveComparePair(history);
  let comparison: ReportComparison | null = null;
  if (pair.a !== null && pair.b !== null) {
    const side = (s: NonNullable<typeof pair.a>) => ({
      label: snapshotLabel(s),
      caseName: s.caseName,
      takenAt: formatReportTime(new Date(s.takenAt)),
    });
    comparison = { a: side(pair.a), b: side(pair.b), comparison: comparePflow(pair.a, pair.b) };
  }

  const runsState = useRunsStore.getState();
  const plotted = new Set(resolveOverlayRuns(runsState).map((r) => r.runId));
  const anchor = plotRunId(runsState);
  const picked = anchor === null ? undefined : usePlotStore.getState().selectedByRun[anchor];
  const mode = useUnitsStore.getState().mode;
  const runs: ReportRun[] = Object.values(runsState.runs).map((run) => ({
    label: runLabel(run),
    outcome: runOutcome(run),
    startedAt: formatReportTime(new Date(run.startedAt)),
    tf: run.tf,
    tEnd: run.tCurrent,
    rows: run.seqCount,
    charts:
      plotted.has(run.runId) && run.seqCount > 0
        ? reportChartsOf(
            run,
            picked !== undefined && picked.size > 0 ? picked : defaultSeries(run),
            mode,
          )
        : [],
  }));

  return {
    caseName,
    files,
    generatedAt,
    pflow,
    comparison,
    runs,
    eig: useAnalyzeStore.getState().eigResult,
  };
}

/** The server's versions, or ``null`` when it does not answer. */
async function fetchVersions(): Promise<HtmlReportData['versions']> {
  try {
    const info = await andesClient.get<VersionInfo>('/version', { timeoutMs: TIMEOUTS.workspace });
    return { tensa: info.tensa, andes: info.andes };
  } catch {
    return null;
  }
}

/**
 * ANDES's own plain-text reports for the routines that have a result on the
 * session. One that the server refuses (it has no such result after all) or
 * cannot write is left out: the appendix is an extra, not what the report is for.
 */
async function fetchAndesReports(): Promise<ReportAndesText[]> {
  const sessionId = useSessionStore.getState().sessionId;
  if (sessionId === null) return [];
  const lastRun = usePflowStore.getState().lastRun;
  const { runs, activeRunId } = useRunsStore.getState();
  const active = activeRunId === null ? undefined : runs[activeRunId];
  const wanted: ReportRoutine[] = [];
  // A solved power flow has totals; the operating point read after a run has none.
  if (lastRun?.converged === true && lastRun.summary != null) wanted.push('pflow');
  if (active !== undefined && active.state !== 'starting' && active.state !== 'streaming') {
    wanted.push('tds');
  }
  if (useAnalyzeStore.getState().eigResult !== null) wanted.push('eig');

  const reports: ReportAndesText[] = [];
  for (const routine of wanted) {
    try {
      const response = await andesClient.get<ReportResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/report`,
        { query: { routine }, timeoutMs: TIMEOUTS.workspace },
      );
      if (response.plain_text.trim().length > 0) {
        reports.push({ title: ANDES_REPORT_TITLE[routine], text: response.plain_text });
      }
    } catch {
      // Left out; see above.
    }
  }
  return reports;
}

/** The report as it would be saved now, or ``null`` when there is nothing to report. */
export async function makeHtmlReport(generatedAt: Date = new Date()): Promise<{
  html: string;
  caseName: string;
} | null> {
  const local = collectReportData(generatedAt);
  if (!hasReportContent(local)) return null;
  const [versions, andesReports] = await Promise.all([fetchVersions(), fetchAndesReports()]);
  return { html: buildHtmlReport({ ...local, versions, andesReports }), caseName: local.caseName };
}

/**
 * Build the report and hand it to the browser as a download. Returns the file
 * name, or ``null`` when there is nothing to report yet.
 */
export async function exportHtmlReport(): Promise<string | null> {
  const now = new Date();
  const report = await makeHtmlReport(now);
  if (report === null) return null;
  const filename = buildFilename({
    caseName: report.caseName,
    runId: undefined,
    panel: 'report',
    ext: 'html',
    timestamp: makeTimestamp(now),
  });
  downloadBlob(new Blob([report.html], { type: 'text/html;charset=utf-8' }), filename);
  return filename;
}
