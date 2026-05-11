/**
 * Long-form CSV serialiser shared by every Export menu (Unit 2 of the
 * v2.0 plan).
 *
 * Two row shapes are supported:
 *
 * - Time-series: `(time, variable, value)` — used by `<TimeSeriesPlot>`
 *   and `<ScrubControl>`. One physical CSV row per (time-sample x
 *   selected variable) tuple. Long-form (rather than wide-form) keeps
 *   the column count fixed at 3 regardless of how many variables the
 *   user selected, so downstream pandas / R / MATLAB readers don't need
 *   schema discovery per export.
 *
 * - Table: `(row_label, column, value)` — used by the v3 ``DataGrid``
 *   per-bucket tabs in the BottomDrawer (and by the now-retired v2
 *   ``<ResultsTable>``, removed in v3 Unit 15). One physical CSV row
 *   per (visible-row x visible-column) tuple. Mirrors
 *   the visible filter + sort state in the table; the caller is
 *   expected to pass already-filtered/sorted rows.
 *
 * Encoding:
 *
 * - UTF-8 (no BOM). Excel-on-Windows users who need Excel auto-detect
 *   are explicitly out of scope for v1.5; the long-form shape lands in
 *   Excel as text-only anyway and the user is expected to use
 *   Data > From Text.
 * - Newlines are LF (`\n`) — the v2.0 plan calls this out explicitly.
 *   CRLF is what the RFC 4180 spec asks for, but every modern parser
 *   tolerates both and LF keeps the bytes-on-disk smaller.
 * - Cells containing `,`, `"`, `\n`, or `\r` are quoted; embedded
 *   double-quotes are doubled per RFC 4180.
 *
 * Header comments:
 *
 * - When `droppedRowCount` is provided (and > 0), the output starts
 *   with `# WARNING: this run dropped X early rows due to memory
 *   pressure\n`. This signals lossy export from a `connection: 'lagged'`
 *   run so post-processing scripts can detect truncation. The `#`-prefix
 *   is the standard pandas / numpy `comment='#'` convention.
 * - Additional `comments` are emitted in order, each prefixed with
 *   `# `. Use this for any non-data context the caller wants (e.g.,
 *   the table's filter query string).
 *
 * Returned shape: a UTF-8 `Blob` ready for `URL.createObjectURL`. We
 * intentionally don't take a filename — file-naming policy lives in
 * `<ExportMenu>` so all three exporters share a single convention.
 */

/** A long-form time-series export descriptor. */
export interface TimeSeriesCsvInput {
  /** Time samples. Caller is expected to pass the logical-length slice. */
  readonly t: ArrayLike<number>;
  /**
   * Variable columns keyed by display name. Each column array MUST be
   * the same length as `t`. Variables iterate in `Object.keys` order;
   * pass an ordered object (or a `Map` via `Object.fromEntries`) if you
   * need a stable column order in the output.
   */
  readonly columns: Readonly<Record<string, ArrayLike<number>>>;
  /**
   * Optional dropped-row count for the lagged-run warning header. When
   * undefined or 0 the warning is omitted. The runs store does not
   * track this number directly today (Unit 2 plan-divergence note);
   * the caller passes it explicitly when known.
   */
  readonly droppedRowCount?: number;
  /** Optional extra header comments, emitted in order, each `# `-prefixed. */
  readonly comments?: readonly string[];
}

/** A long-form table export descriptor. */
export interface TableCsvInput {
  /** Column headers in display order. */
  readonly columns: readonly string[];
  /**
   * Rows. Each row is `{ label, cells }`: `label` becomes the
   * `row_label` column; `cells` is parallel to `columns` and emits one
   * CSV row per cell.
   */
  readonly rows: ReadonlyArray<{
    readonly label: string;
    readonly cells: readonly string[];
  }>;
  /** Optional extra header comments. See `TimeSeriesCsvInput`. */
  readonly comments?: readonly string[];
}

/**
 * Quote a CSV cell per RFC 4180 only when needed. Empty / null-style
 * sentinels (em-dash, undefined-stringified) are passed through unquoted
 * because they don't carry the special chars the spec quotes for.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? formatNumber(value) : value;
  // Quote on `"`, `,`, `\n`, or `\r`. `"` becomes `""`.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialise a number to a CSV-safe string. Uses default JS toString for
 * finite values (which preserves precision for ANDES outputs in the
 * 1e-15..1e15 range without scientific-notation surprises for typical
 * power-system magnitudes), and writes `NaN` / `Inf` as the literal
 * tokens pandas reads back as `nan` / `inf`.
 */
function formatNumber(n: number): string {
  if (Number.isFinite(n)) return String(n);
  if (Number.isNaN(n)) return 'NaN';
  // +/-Infinity → `Infinity` / `-Infinity` (pandas reads as inf).
  return n > 0 ? 'Infinity' : '-Infinity';
}

/** Build the leading `# `-prefixed comment block (incl. the lagged warning). */
function buildHeaderComments(
  droppedRowCount: number | undefined,
  comments: readonly string[] | undefined,
): string {
  const parts: string[] = [];
  if (droppedRowCount !== undefined && droppedRowCount > 0) {
    parts.push(`# WARNING: this run dropped ${droppedRowCount} early rows due to memory pressure`);
  }
  if (comments) {
    for (const c of comments) parts.push(`# ${c}`);
  }
  return parts.length === 0 ? '' : `${parts.join('\n')}\n`;
}

/**
 * Serialise a time-series panel to a long-form CSV `Blob`.
 *
 * Output shape (with N samples, V variables):
 *
 *     time,variable,value
 *     0,Bus_1_v,1.06
 *     0,Bus_2_v,1.045
 *     ...
 *
 * Total row count: `1 + N * V` (header plus body), or `2+ + N*V` when
 * the warning header is present.
 */
export function timeSeriesToCsv(input: TimeSeriesCsvInput): Blob {
  const { t, columns, droppedRowCount, comments } = input;
  const variableNames = Object.keys(columns);
  const lines: string[] = [];
  const header = buildHeaderComments(droppedRowCount, comments);
  if (header.length > 0) lines.push(header.trimEnd());
  lines.push('time,variable,value');
  const n = t.length;
  for (let i = 0; i < n; i++) {
    const time = t[i];
    if (time === undefined) continue;
    const tCell = csvCell(time);
    for (const name of variableNames) {
      const col = columns[name]!;
      const value = col[i];
      // Skip rows where the value column is shorter than t — defensive
      // against mismatched-length inputs. The caller is expected to
      // pass parallel arrays; this just prevents an exception that
      // would lose the entire export to a single bad column.
      if (value === undefined) continue;
      lines.push(`${tCell},${csvCell(name)},${csvCell(value)}`);
    }
  }
  // Trailing newline so concatenated CSVs (e.g., a future "append" mode)
  // stay row-aligned. RFC 4180 makes the trailing newline optional.
  return new Blob([`${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
}

/**
 * Serialise a results-table panel to a long-form CSV `Blob`.
 *
 * Output shape (with R rows, C columns):
 *
 *     row_label,column,value
 *     1,idx,1
 *     1,name,Bus1
 *     1,V (pu),1.0600
 *     ...
 *
 * The caller passes already-filtered/sorted rows (so a CSV mirrors the
 * table's visible state — addresses the Unit 2 integration scenario).
 */
export function tableToCsv(input: TableCsvInput): Blob {
  const { columns, rows, comments } = input;
  const lines: string[] = [];
  const header = buildHeaderComments(undefined, comments);
  if (header.length > 0) lines.push(header.trimEnd());
  lines.push('row_label,column,value');
  for (const row of rows) {
    const labelCell = csvCell(row.label);
    for (let c = 0; c < columns.length; c++) {
      const colName = columns[c]!;
      const cell = row.cells[c];
      // Allow short rows: emit empty cell for missing values so a
      // jagged input still produces a structurally-valid CSV.
      lines.push(`${labelCell},${csvCell(colName)},${csvCell(cell ?? '')}`);
    }
  }
  return new Blob([`${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
}
