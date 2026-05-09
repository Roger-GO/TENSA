import { cn } from '@/lib/cn';
import { useEigParticipation } from '@/api/queries';
import { useAnalyzeStore } from '@/store/analyze';
import type { ParticipationFactor } from '@/api/types';

/**
 * EIGParticipationTable — per-selected-mode participation factor list
 * (Unit 6 of the v2.0 plan).
 *
 * Empty-state rules:
 *
 * - No mode selected → "Click an eigenvalue point to see its
 *   participation factors."
 * - Mode selected, query in flight → ``data-testid="eig-loading"``
 *   spinner placeholder.
 * - Mode selected, query errored → inline error.
 * - Mode selected, response empty → "No participation factors for
 *   this mode."
 *
 * Virtualization (per Unit 6 plan): ``react-window`` is NOT in the
 * web ``package.json`` dependency set as of this commit. Per Unit 6's
 * constraints ("simple table; pagination is a follow-up"), we ship a
 * plain table sorted by descending |factor|. NPCC-scale (334 rows)
 * still renders in <50 ms in the browser; if perf becomes an issue
 * we can add virtualization in a follow-up. The "more than N rows
 * visible" footer is a sensible expansion point.
 */

const SORTED_TOP_N = 200;

export interface EIGParticipationTableProps {
  className?: string;
  /** Override for tests; usually fetched via the participation hook. */
  rows?: ParticipationFactor[];
}

/** Sort participation rows by descending |factor| and slice to ``maxRows``. */
// eslint-disable-next-line react-refresh/only-export-components
export function rankParticipation(
  rows: ParticipationFactor[],
  maxRows = SORTED_TOP_N,
): { ranked: ParticipationFactor[]; total: number } {
  const sorted = [...rows].sort(
    (a, b) => Math.abs(b.factor) - Math.abs(a.factor),
  );
  return { ranked: sorted.slice(0, maxRows), total: rows.length };
}

export function EIGParticipationTable({
  className,
  rows,
}: EIGParticipationTableProps) {
  const selectedModeId = useAnalyzeStore((s) => s.selectedModeId);

  // ``rows`` prop overrides the query path entirely (used in tests);
  // when not supplied, fetch via the analyze store's selected mode.
  const query = useEigParticipation(rows === undefined ? selectedModeId : null);

  // Resolve rows: prop wins, otherwise the query.
  const displayRows: ParticipationFactor[] | null =
    rows !== undefined
      ? rows
      : query.data
        ? query.data.participation
        : null;

  if (selectedModeId === null && rows === undefined) {
    return (
      <div
        data-testid="eig-participation-table"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[120px] items-center justify-center rounded border p-3 text-xs',
          className,
        )}
      >
        Click an eigenvalue point to see its participation factors.
      </div>
    );
  }

  if (rows === undefined && query.isLoading) {
    return (
      <div
        data-testid="eig-loading"
        className={cn(
          'border-border bg-muted/10 text-muted-foreground',
          'flex h-full min-h-[120px] items-center justify-center rounded border p-3 text-xs',
          className,
        )}
      >
        Loading participation factors…
      </div>
    );
  }

  if (rows === undefined && query.isError) {
    return (
      <div
        role="alert"
        data-testid="eig-participation-table"
        className={cn(
          'border-destructive/40 bg-destructive/10 text-destructive',
          'rounded border p-3 text-xs',
          className,
        )}
      >
        {query.error?.message ?? 'Failed to load participation factors.'}
      </div>
    );
  }

  const ranked = rankParticipation(displayRows ?? []);

  if (ranked.ranked.length === 0) {
    return (
      <div
        data-testid="eig-participation-table"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[120px] items-center justify-center rounded border p-3 text-xs',
          className,
        )}
      >
        No participation factors for this mode.
      </div>
    );
  }

  return (
    <div
      data-testid="eig-participation-table"
      className={cn(
        'border-border bg-background flex flex-col overflow-hidden rounded border',
        className,
      )}
    >
      <div className="border-border text-muted-foreground border-b px-2 py-1 text-[10px]">
        Participation factors (top {ranked.ranked.length} of {ranked.total},
        sorted by |factor|)
      </div>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-medium">State</th>
              <th className="px-2 py-1 text-right font-medium">Factor</th>
            </tr>
          </thead>
          <tbody>
            {ranked.ranked.map((row, idx) => (
              <tr
                key={`${row.state_name}-${idx}`}
                data-testid={`eig-participation-row-${idx}`}
                className="border-border/60 hover:bg-muted/30 border-t"
              >
                <td className="px-2 py-1 font-mono">{row.state_name}</td>
                <td className="px-2 py-1 text-right font-mono">
                  {row.factor.toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ranked.total > SORTED_TOP_N ? (
        <div className="border-border text-muted-foreground border-t px-2 py-1 text-[10px]">
          Showing top {SORTED_TOP_N} of {ranked.total} states. Pagination /
          virtualization deferred to a follow-up unit.
        </div>
      ) : null}
    </div>
  );
}
