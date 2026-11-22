/**
 * The Network matrices dialog: the PTDF, LODF, Ybus or incidence matrix of the
 * loaded case, built by the Sienna engine with PowerNetworkMatrices and read
 * through `GET /sessions/{id}/network-matrix?kind=`. The kind is picked in the
 * dialog; the answer's axes name every row and column by its TENSA key (an arc
 * by the keys of its branches, joined). The table is windowed (a few hundred
 * buses stay usable), searchable by row or column key, and downloadable as CSV.
 * Structure, states and testids follow the Ybus dialog.
 */
import { useMemo, useState } from 'react';
import { ProblemDetailsError } from '@/api/client';
import {
  useNetworkMatrix,
  type NetworkMatrixKind,
  type NetworkMatrixResponse,
} from '@/api/queries';
import { downloadBlob } from '@/components/export/downloadBlob';
import { recordsToCsv } from '@/components/export/exportToCsv';
import { useExportCaseName } from '@/components/export/useExportCaseName';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/Input';
import { LoadingPanel } from '@/components/ui/Lazy';
import { toast } from '@/lib/toast';
import { useNetworkMatrixStore } from '@/store/networkMatrix';

/** Rows of the table per window, and columns: at most this many in the document at a time. */
export const WINDOW_ROWS = 100;
export const WINDOW_COLS = 50;

type AxisEntry = NetworkMatrixResponse['rows'][number];

/** The label of one row or column: its key, an arc by its branch keys joined, or the bus numbers. */
function axisLabel(entry: AxisEntry): string {
  if ('key' in entry) return entry.key;
  if (entry.keys.length > 0) return entry.keys.join(', ');
  return `${entry.from}-${entry.to}`;
}

/** The text a search matches against: the label, and for an arc also `from-to`. */
function axisNeedles(entry: AxisEntry): string[] {
  const label = axisLabel(entry).toLowerCase();
  if ('key' in entry) return [label];
  return [label, `${entry.from}-${entry.to}`];
}

/** What the error says: the server's own detail where it gave one. */
function errorText(err: Error): string {
  return err instanceof ProblemDetailsError ? (err.detail ?? err.title) : err.message;
}

const KINDS: readonly (readonly [NetworkMatrixKind, string])[] = [
  ['ptdf', 'PTDF'],
  ['lodf', 'LODF'],
  ['ybus', 'Ybus'],
  ['incidence', 'Incidence'],
];

/** The complex cell of a ybus entry: `re+imj` with the sign of the imaginary part. */
function complexCell(re: number, im: number): string {
  return `${re.toPrecision(4)}${im < 0 ? '-' : '+'}${Math.abs(im).toPrecision(4)}j`;
}

export function NetworkMatrixDialog() {
  const dialogOpen = useNetworkMatrixStore((s) => s.dialogOpen);
  const closeDialog = useNetworkMatrixStore((s) => s.closeDialog);
  const [kind, setKind] = useState<NetworkMatrixKind>('ptdf');
  const [search, setSearch] = useState('');
  const [windowStart, setWindowStart] = useState(0);
  const query = useNetworkMatrix(kind, dialogOpen);
  const caseName = useExportCaseName();

  const data = query.data;
  const fetching = query.isFetching;
  const err = query.error;

  // The ybus cells, looked up from the sparse entries; the dense kinds read `values`.
  const ybusCells = useMemo(() => {
    if (data === undefined || data.entries === null || data.entries === undefined) return null;
    const cells = new Map<string, { re: number; im: number }>();
    for (const e of data.entries) cells.set(`${e.row}:${e.col}`, { re: e.re, im: e.im });
    return cells;
  }, [data]);

  const rowLabels = useMemo(() => (data === undefined ? [] : data.rows.map(axisLabel)), [data]);
  const colLabels = useMemo(() => (data === undefined ? [] : data.cols.map(axisLabel)), [data]);

  // The search hit: the first row, then the first column, whose key holds the query.
  // `axis` says which the hit is on: a row hit marks its row header, a column
  // hit the cell of the first row under that column.
  const hit = useMemo(() => {
    if (data === undefined) return null;
    const needle = search.trim().toLowerCase();
    if (needle === '') return null;
    const row = data.rows.findIndex((entry: AxisEntry) =>
      axisNeedles(entry).some((text: string) => text.includes(needle)),
    );
    if (row >= 0) return { axis: 'row' as const, row, col: 0 };
    const col = data.cols.findIndex((entry: AxisEntry) =>
      axisNeedles(entry).some((text: string) => text.includes(needle)),
    );
    if (col >= 0) return { axis: 'col' as const, row: 0, col };
    return null;
  }, [data, search]);

  // Keep the hit inside the window: derived during render, as the window itself is.
  const start =
    data === undefined
      ? 0
      : hit !== null && (hit.row < windowStart || hit.row >= windowStart + WINDOW_ROWS)
        ? Math.floor(hit.row / WINDOW_ROWS) * WINDOW_ROWS
        : windowStart;
  const end = data === undefined ? 0 : Math.min(start + WINDOW_ROWS, data.n_rows);
  const colEnd = data === undefined ? 0 : Math.min(WINDOW_COLS, data.n_cols);
  const truncated = data !== undefined && data.n_rows > WINDOW_ROWS;

  const onKind = (next: NetworkMatrixKind) => {
    setKind(next);
    setSearch('');
    setWindowStart(0);
  };

  const onExportCsv = () => {
    if (data === undefined) return;
    const filename = `${caseName}-${data.kind}.csv`;
    if (ybusCells !== null) {
      // A complex column is two columns of the file, real part and imaginary part.
      const columns = ['', ...colLabels.flatMap((label: string) => [`${label} re`, `${label} im`])];
      const rows = rowLabels.map((label: string, i: number) => [
        label,
        ...colLabels.flatMap((_: string, j: number): (string | number)[] => {
          const cell = ybusCells.get(`${i}:${j}`);
          return cell === undefined ? ['', ''] : [cell.re, cell.im];
        }),
      ]);
      downloadBlob(recordsToCsv({ columns, rows }), filename);
    } else {
      const values = data.values ?? [];
      downloadBlob(
        recordsToCsv({
          columns: ['', ...colLabels],
          rows: rowLabels.map((label: string, i: number) => [
            label,
            ...Array.from({ length: data.n_cols }, (_: unknown, j: number) => values[i]?.[j] ?? ''),
          ]),
        }),
        filename,
      );
    }
    toast.success(`Exported ${filename}`);
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      <DialogContent
        widthClassName="max-w-4xl"
        data-testid="network-matrix-dialog"
        aria-label="Network matrices"
      >
        <DialogHeader>
          <DialogTitle>Network matrices</DialogTitle>
          <DialogDescription>
            Built by the Sienna engine with PowerNetworkMatrices.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-wrap gap-3" data-testid="network-matrix-kind">
          <legend className="text-muted-foreground text-xs font-medium">Matrix</legend>
          {KINDS.map(([value, label]) => (
            <label key={value} className="text-foreground flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="network-matrix-kind"
                value={value}
                data-testid={`network-matrix-kind-${value}`}
                checked={kind === value}
                onChange={() => onKind(value)}
                className="border-border h-3.5 w-3.5 rounded border focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none"
              />
              {label}
            </label>
          ))}
        </fieldset>

        {fetching && data === undefined ? (
          <div data-testid="network-matrix-loading">
            <LoadingPanel />
            <p className="text-muted-foreground text-center text-xs">Building the matrix…</p>
          </div>
        ) : null}

        {err !== null && !fetching ? (
          <>
            <p role="alert" data-testid="network-matrix-error" className="text-danger text-sm">
              {errorText(err)}
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={closeDialog}>
                Cancel
              </Button>
              <Button data-testid="network-matrix-retry" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {data !== undefined && err === null ? (
          <>
            <p data-testid="network-matrix-meta" className="text-sm" aria-live="polite">
              {`${data.n_rows} × ${data.n_cols}, ${data.n_entries} entries, base ${data.base_mva} MVA`}
              {data.ref_buses !== null && data.ref_buses !== undefined && data.ref_buses.length > 0
                ? `, reference ${data.ref_buses.join(', ')}`
                : ''}
            </p>
            <Input
              data-testid="network-matrix-search"
              aria-label="Search a row or column by key"
              value={search}
              onChange={setSearch}
              placeholder="Row or column key…"
            />
            {search.trim() !== '' && hit === null ? (
              <p data-testid="network-matrix-no-match" className="text-muted-foreground text-xs">
                No row or column key matches.
              </p>
            ) : null}
            {truncated ? (
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  data-testid="network-matrix-prev"
                  disabled={start === 0}
                  onClick={() => setWindowStart(Math.max(0, start - WINDOW_ROWS))}
                >
                  Earlier rows
                </Button>
                <span data-testid="network-matrix-window" className="text-muted-foreground text-sm">
                  {`Showing rows ${start + 1}–${end} of ${data.n_rows}.`}
                </span>
                <Button
                  variant="ghost"
                  data-testid="network-matrix-next"
                  disabled={end >= data.n_rows}
                  onClick={() => setWindowStart(start + WINDOW_ROWS)}
                >
                  Later rows
                </Button>
              </div>
            ) : null}
            <div className="border-border max-h-[60vh] overflow-auto rounded-[var(--radius-sm)] border">
              <table
                data-testid="network-matrix-table"
                aria-label="The network matrix"
                className="w-full text-xs"
              >
                <thead>
                  <tr className="text-muted-foreground border-border border-b text-left">
                    <th
                      scope="col"
                      className="bg-background sticky top-0 left-0 px-2 py-1 font-medium"
                    />
                    {colLabels.slice(0, colEnd).map((label: string, j: number) => {
                      const colHit = hit?.axis === 'col' && hit.col === j;
                      return (
                        <th
                          key={label}
                          scope="col"
                          ref={
                            colHit ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined
                          }
                          data-testid={colHit ? 'network-matrix-hit' : undefined}
                          className="bg-background sticky top-0 px-2 py-1 text-right font-medium"
                        >
                          {label}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rowLabels.slice(start, end).map((label: string, i: number) => {
                    const row = start + i;
                    const rowHit = hit?.axis === 'row' && hit.row === row;
                    return (
                      <tr
                        key={label}
                        data-testid={`network-matrix-row-${row}`}
                        className="border-border border-b last:border-0"
                      >
                        <th
                          scope="row"
                          ref={
                            rowHit ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined
                          }
                          data-testid={rowHit ? 'network-matrix-hit' : undefined}
                          className="bg-background sticky left-0 px-2 py-1 text-left font-normal"
                        >
                          {label}
                        </th>
                        {Array.from({ length: colEnd }, (_: unknown, j: number) => (
                          <td key={j} className="px-2 py-1 text-right font-mono tabular-nums">
                            {ybusCells !== null
                              ? (() => {
                                  const cell = ybusCells.get(`${row}:${j}`);
                                  return cell === undefined ? '' : complexCell(cell.re, cell.im);
                                })()
                              : (data.values?.[row]?.[j]?.toPrecision(6) ?? '')}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                data-testid="network-matrix-csv"
                disabled={fetching}
                onClick={onExportCsv}
              >
                Download CSV
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
