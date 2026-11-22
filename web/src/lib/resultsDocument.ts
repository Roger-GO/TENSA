/**
 * A results document for one side of a comparison: built from a kept run
 * through the server's conversion route, or parsed from a file the user picks.
 *
 * The client never maps ANDES column names to neutral keys itself: the server
 * does that in ``POST /results/convert`` from the session's key listing, which
 * the run recorded when it started (``RunRecord.keys``). This module only
 * packs the request and checks what comes back.
 */
import { convertResult } from '@/api/queries/compare';
import type {
  CompareRequest,
  CompareSide,
  CompareTolerancesInput,
  ResultsDocument,
  Tolerances,
} from '@/api/queries/compare';
import type { RunRecord } from '@/store/runs';

/** The tolerance defaults of ``engines/compare.py``, as text for the fields. */
export const DEFAULT_QUANTITY_TOLERANCES: Readonly<
  Record<string, { value: number; text: string; unit: string }>
> = {
  voltage: { value: 1e-3, text: '0.001', unit: 'pu' },
  angle: { value: 1e-2, text: '0.01', unit: 'rad' },
  rotor_speed: { value: 1e-3, text: '0.001', unit: 'pu' },
  rotor_angle: { value: 1e-2, text: '0.01', unit: 'rad' },
  p: { value: 1.0, text: '1', unit: 'MW' },
  q: { value: 1.0, text: '1', unit: 'MVAr' },
  p_from: { value: 1.0, text: '1', unit: 'MW' },
  q_from: { value: 1.0, text: '1', unit: 'MVAr' },
};
export const DEFAULT_FREQ_TOLERANCE_HZ_TEXT = '0.02';
export const DEFAULT_DAMPING_TOLERANCE_TEXT = '0.02';
export const DEFAULT_MAX_MODE_DISTANCE_TEXT = '0.05';

/** What a run is called in a picker and the verdict, with its case when it has one. */
export function runSideLabel(run: RunRecord): string {
  const base =
    run.displayName ?? (run.ordinal !== undefined ? `TDS #${run.ordinal}` : run.runId.slice(0, 8));
  return run.caseName !== undefined ? `${base} · ${run.caseName}` : base;
}

/**
 * The document of a kept run, built by the server from the run's traces and
 * the keys it recorded. A run without keys (kept before they were recorded)
 * sends none, and the server maps what it can. The answer carries the count
 * of columns that are not in the document.
 */
export async function runToResultsDocument(
  run: RunRecord,
): Promise<{ side: CompareSide; skipped: number }> {
  const seqCount = run.seqCount;
  const t = Array.from(run.t.subarray(0, seqCount));
  const variables = run.columnNames.map((name) => ({
    name,
    values: Array.from(run.columns[name]!.subarray(0, seqCount)),
  }));
  const answer = await convertResult({
    kind: 'tds',
    engine: run.engine ?? 'andes',
    status: run.state === 'done' ? 'completed' : run.state === 'aborted' ? 'aborted' : 'failed',
    result: { t, variables, truncated: false },
    keys: run.keys ?? [],
  });
  return {
    side: { document: answer.document, label: runSideLabel(run) },
    skipped: (answer.skipped ?? []).length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function seriesProblem(index: number, entry: unknown): string | null {
  if (!isRecord(entry)) return `series ${index} is not an object`;
  for (const field of ['quantity', 'of', 'unit'] as const) {
    if (typeof entry[field] !== 'string') return `series ${index} has no string ${field}`;
  }
  if (!Array.isArray(entry.t)) return `series ${index} has no t array`;
  if (!Array.isArray(entry.y)) return `series ${index} has no y array`;
  return null;
}

/**
 * Parse a results document file (``tensa_results: 1``). The fields the compare
 * request refuses (``engine``, ``status``, ``tensa_results``, ``study``) are
 * accepted and stripped here, so a file the results-document unit writes does
 * not 422. ``tables`` passes through with its ``pflow`` and ``eig`` only.
 */
export function parseResultsDocumentFile(text: string, fileName: string): CompareSide {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} is not a JSON file`);
  }
  if (!isRecord(parsed)) throw new Error(`${fileName} is not a results document: not an object`);
  if (!Array.isArray(parsed.series)) {
    throw new Error(`${fileName} is not a results document: no series array`);
  }
  for (let i = 0; i < parsed.series.length; i += 1) {
    const problem = seriesProblem(i, parsed.series[i]);
    if (problem !== null) {
      throw new Error(`${fileName} is not a results document: ${problem}`);
    }
  }
  // The document model carries the fields the compare request refuses; the
  // file's own are dropped and these stand in for them, and the view strips
  // them again when it packs the request.
  const document: ResultsDocument = {
    tensa_results: 1,
    engine: { name: 'andes' },
    status: 'completed',
    series: parsed.series as NonNullable<ResultsDocument['series']>,
  };
  if (isRecord(parsed.tables)) {
    const tables: ResultsDocument['tables'] = {};
    if (isRecord(parsed.tables.pflow)) {
      tables.pflow = parsed.tables.pflow as NonNullable<ResultsDocument['tables']>['pflow'];
    }
    if (isRecord(parsed.tables.eig)) {
      tables.eig = parsed.tables.eig as NonNullable<ResultsDocument['tables']>['eig'];
    }
    document.tables = tables;
  }
  const label = fileName.replace(/\.[^.]*$/, '');
  return { document, label };
}

/**
 * The request body. A tolerance left at its default text is not sent, so the
 * server applies its own defaults; when nothing differs the body has no
 * ``tolerances`` key at all. Numbers are parsed with ``Number``; the caller
 * validates the text first.
 */
export function buildCompareRequest(
  reference: CompareSide,
  comparison: CompareSide,
  tolerances: CompareTolerancesInput,
): CompareRequest {
  const body: CompareRequest = {
    reference: reference.document,
    comparison: comparison.document,
  };
  const out: {
    quantities?: Record<string, number>;
    frequency_hz?: number;
    damping_ratio?: number;
    max_mode_distance?: number;
  } = {};
  const quantities: Record<string, number> = {};
  for (const [quantity, def] of Object.entries(DEFAULT_QUANTITY_TOLERANCES)) {
    const text = tolerances.quantities[quantity];
    if (text !== undefined && text !== def.text) quantities[quantity] = Number(text);
  }
  if (Object.keys(quantities).length > 0) out.quantities = quantities;
  if (tolerances.frequency_hz !== DEFAULT_FREQ_TOLERANCE_HZ_TEXT) {
    out.frequency_hz = Number(tolerances.frequency_hz);
  }
  if (tolerances.damping_ratio !== DEFAULT_DAMPING_TOLERANCE_TEXT) {
    out.damping_ratio = Number(tolerances.damping_ratio);
  }
  if (tolerances.max_mode_distance !== DEFAULT_MAX_MODE_DISTANCE_TEXT) {
    out.max_mode_distance = Number(tolerances.max_mode_distance);
  }
  if (Object.keys(out).length > 0) body.tolerances = out as Tolerances;
  return body;
}
