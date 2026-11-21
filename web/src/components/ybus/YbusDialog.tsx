/**
 * The admittance matrix (Ybus) dialog. It asks nothing of the server until
 * the user presses Read matrix, because the read sets the system up when it
 * is not, after which no disturbance can be added until the case is reloaded;
 * the dialog says so first. Then it lists the nonzero entries in a filterable,
 * sortable table paged at 500 rows, and offers CSV and MATLAB downloads built
 * in the browser. Closing it forgets the matrix, so the next opening reads the
 * case as it is then.
 */
import { useMemo, useState } from 'react';
import { ProblemDetailsError } from '@/api/client';
import { useForgetYbus, useYbus } from '@/api/queries';
import type { components } from '@/api/generated';
import { downloadBlob } from '@/components/export/downloadBlob';
import { buildFilename, makeTimestamp } from '@/components/export/exportFilename';
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
import { useYbusDialogStore } from '@/store/ybusDialog';
import { ybusToCsv, type YbusEntry } from './ybusToCsv';
import { ybusMatlabFilename, ybusToMatlab } from './ybusToMatlab';

type YbusResponse = components['schemas']['YbusResponse'];

/** Rows of the table per page: at most 500 rows in the document at a time. */
const PAGE_SIZE = 500;

type SortKey = 'row' | 'col' | 're' | 'im';
interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const COLUMNS: ReadonlyArray<readonly [SortKey, string]> = [
  ['row', 'Row bus'],
  ['col', 'Col bus'],
  ['re', 'G (pu)'],
  ['im', 'B (pu)'],
];

/**
 * The entries the filter keeps. A filter that is the idx of a bus keeps the
 * entries of that bus, in its row or its column; any other text keeps the
 * entries whose row or column bus idx contains it. Both ignore case. So
 * typing ``1`` on a case with buses 1 and 10 shows bus 1, not bus 10 as well.
 */
function filterEntries(data: YbusResponse, filter: string): YbusEntry[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return data.entries;
  const names = data.bus_idx.map((idx) => idx.toLowerCase());
  const exact = names.includes(needle);
  const keeps = names.map((name) => (exact ? name === needle : name.includes(needle)));
  return data.entries.filter((e) => keeps[e.row] === true || keeps[e.col] === true);
}

/**
 * The entries in the order the sort asks for; ``null`` keeps the server's
 * order. G and B sort as numbers, the buses by their idx with the digits
 * read as numbers (bus 9 before bus 10). Entries that tie keep their order.
 */
function sortEntries(data: YbusResponse, entries: YbusEntry[], sort: Sort | null): YbusEntry[] {
  if (sort === null) return entries;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const { key } = sort;
  if (key === 're' || key === 'im') {
    return [...entries].sort((a, b) => sign * (a[key] - b[key]));
  }
  const collator = new Intl.Collator(undefined, { numeric: true });
  return [...entries].sort(
    (a, b) => sign * collator.compare(data.bus_idx[a[key]] ?? '', data.bus_idx[b[key]] ?? ''),
  );
}

/** What the error says: the server's own detail where it gave one. */
function errorText(err: Error): string {
  return err instanceof ProblemDetailsError ? (err.detail ?? err.title) : err.message;
}

export function YbusDialog() {
  const open = useYbusDialogStore((s) => s.open);
  const closeDialog = useYbusDialogStore((s) => s.closeDialog);
  const query = useYbus();
  const forgetYbus = useForgetYbus();
  const caseName = useExportCaseName();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const [page, setPage] = useState(0);

  const data = query.data;
  const visible = useMemo(
    () => (data === undefined ? [] : sortEntries(data, filterEntries(data, filter), sort)),
    [data, filter, sort],
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const close = () => {
    setFilter('');
    setSort(null);
    setPage(0);
    forgetYbus();
    closeDialog();
  };

  const toggleSort = (key: SortKey) => {
    setPage(0);
    setSort((prev) =>
      prev === null || prev.key !== key
        ? { key, dir: 'asc' }
        : prev.dir === 'asc'
          ? { key, dir: 'desc' }
          : null,
    );
  };

  const download = (blob: Blob, filename: string) => {
    downloadBlob(blob, filename);
    toast.success(`Exported ${filename}`);
  };

  const fetching = query.isFetching;
  const err = query.error;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent widthClassName="max-w-3xl" data-testid="ybus-dialog">
        <DialogHeader>
          <DialogTitle>Admittance matrix (Ybus)</DialogTitle>
          <DialogDescription>
            The bus admittance matrix ANDES builds from the case&apos;s lines, transformers and
            shunts, in per unit on the system base.
          </DialogDescription>
        </DialogHeader>

        {data === undefined && !fetching && err === null && (
          <>
            <p data-testid="ybus-setup-note" className="text-muted-foreground text-sm">
              Reading the matrix sets the system up if it is not, as the connectivity check does:
              after that no disturbance can be added until the case is reloaded.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button data-testid="ybus-load" onClick={() => void query.refetch()}>
                Read matrix
              </Button>
            </DialogFooter>
          </>
        )}

        {fetching && (
          <div data-testid="ybus-loading">
            <LoadingPanel />
          </div>
        )}

        {err !== null && !fetching && (
          <>
            <div role="alert" data-testid="ybus-error" className="text-danger text-sm">
              {errorText(err)}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button data-testid="ybus-retry" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </DialogFooter>
          </>
        )}

        {data !== undefined && err === null && !fetching && (
          <>
            <p data-testid="ybus-summary" className="text-sm" aria-live="polite">
              {`${data.n_bus} buses · ${data.entries.length} nonzeros`}
              {data.base_mva !== null ? ` · base ${data.base_mva} MVA` : ' · no system base'}
            </p>
            <Input
              data-testid="ybus-filter"
              aria-label="Filter by bus idx"
              value={filter}
              onChange={(v) => {
                setFilter(v);
                setPage(0);
              }}
              placeholder="Filter by bus idx…"
            />
            <div className="border-border max-h-96 overflow-auto rounded-[var(--radius-sm)] border">
              <table
                data-testid="ybus-table"
                aria-label="Nonzero entries of the admittance matrix"
                className="w-full text-sm"
              >
                <thead>
                  <tr className="text-muted-foreground border-border border-b text-left">
                    {COLUMNS.map(([key, label]) => (
                      <th
                        key={key}
                        scope="col"
                        aria-sort={
                          sort?.key === key
                            ? sort.dir === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className="px-2 py-1 font-medium"
                      >
                        <button
                          type="button"
                          data-testid={`ybus-sort-${key}`}
                          onClick={() => toggleSort(key)}
                          className="hover:text-foreground"
                        >
                          {label}
                          <span aria-hidden="true">
                            {sort?.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((e) => (
                    <tr
                      key={`${e.row}-${e.col}`}
                      data-testid={`ybus-row-${e.row}-${e.col}`}
                      className="border-border border-b last:border-0"
                    >
                      <td className="px-2 py-1">{data.bus_idx[e.row]}</td>
                      <td className="px-2 py-1">{data.bus_idx[e.col]}</td>
                      <td className="px-2 py-1 tabular-nums">{String(e.re)}</td>
                      <td className="px-2 py-1 tabular-nums">{String(e.im)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                data-testid="ybus-prev"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <span data-testid="ybus-page" className="text-muted-foreground text-sm">
                {`Page ${currentPage + 1} of ${pageCount}`}
                {visible.length !== data.entries.length
                  ? `, ${visible.length} of ${data.entries.length} entries shown`
                  : ''}
              </span>
              <Button
                variant="ghost"
                data-testid="ybus-next"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                data-testid="ybus-download-csv"
                onClick={() =>
                  download(
                    ybusToCsv(data, visible),
                    buildFilename({
                      caseName,
                      runId: undefined,
                      panel: 'ybus',
                      ext: 'csv',
                      timestamp: makeTimestamp(),
                    }),
                  )
                }
              >
                Download CSV
              </Button>
              <Button
                variant="ghost"
                data-testid="ybus-download-mat"
                onClick={() =>
                  download(ybusToMatlab(data), ybusMatlabFilename(caseName, makeTimestamp()))
                }
              >
                Download MATLAB (.m)
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
