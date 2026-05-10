import { useCallback, useMemo, useRef, useState } from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { cn } from '@/lib/cn';
import { useEigParticipation } from '@/api/queries';
import { useAnalyzeStore } from '@/store/analyze';
import { useHotkeys } from '@/lib/useHotkeys';
import { Input } from '@/components/ui/Input';
import type { ParticipationFactor } from '@/api/types';

/**
 * EIGParticipationTable — per-selected-mode participation factor list
 * (Unit 6 + Unit 16 of the v2.0 plan).
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
 * Unit 16 additions:
 *
 * - Per-column click-to-sort. Header cycles ``asc → desc → none → asc``.
 *   Default (no explicit sort) is ``|factor| desc`` — the operator's
 *   common-case "show me the dominant states for this mode".
 * - Filter input above the table. Case-insensitive substring match
 *   against ``state_name``. ``⌘/`` focuses the input — but ONLY while
 *   the analyze sub-mode is ``eig``, so we don't fight the SLD
 *   search-popover binding (which uses the same chord and is the
 *   right answer when the canvas is in focus).
 * - Virtualization (``react-window``'s ``FixedSizeList``) kicks in
 *   above 50 rows. Below the threshold we render a regular ``<table>``
 *   for cleaner copy-paste / accessibility defaults.
 *
 * Notes on the hotkey scoping decision: rather than accept the "soft
 * conflict" of two ``⌘/`` listeners (SLD search + this filter) firing
 * simultaneously, we gate this binding on ``subMode === 'eig'`` —
 * registering a no-op when the analyze panel is on a different
 * sub-mode (or when the user isn't even on the analyze panel). The
 * SLD canvas binding is unconditional, so on the SLD canvas it
 * always wins; here it ALSO wins in non-eig sub-modes (we don't
 * register). Inside the EIG sub-mode both fire — we accept this:
 * "open the search of whatever I'm looking at" is the user intent
 * either way, and Radix popovers stack cleanly.
 */

const VIRTUALIZE_THRESHOLD = 50;
const ROW_HEIGHT = 32;
const VIRTUAL_VIEWPORT_HEIGHT = 320;

export interface EIGParticipationTableProps {
  className?: string;
  /** Override for tests; usually fetched via the participation hook. */
  rows?: ParticipationFactor[];
}

/** Column key the user can sort by. */
type SortColumn = 'state' | 'factor';
/** Sort direction; ``none`` returns the |factor|-desc default ordering. */
type SortDirection = 'asc' | 'desc' | 'none';

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

const DEFAULT_SORT: SortState = { column: 'factor', direction: 'none' };

/**
 * Sort participation rows. ``direction === 'none'`` returns the
 * default ordering: descending by ``|factor|`` (the v0.1 contract).
 *
 * Numeric sort uses raw factor (signed) when the user explicitly picks
 * the column — they may want to see the most-negative or most-positive
 * factors. The default (``none``) keeps the magnitude-based ordering
 * because the operator usually cares about "dominant states" first.
 *
 * Exported for test reuse.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sortParticipation(
  rows: ParticipationFactor[],
  sort: SortState,
): ParticipationFactor[] {
  const sorted = [...rows];
  if (sort.direction === 'none') {
    sorted.sort((a, b) => Math.abs(b.factor) - Math.abs(a.factor));
    return sorted;
  }
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.column === 'state') {
    sorted.sort(
      (a, b) => sign * a.state_name.localeCompare(b.state_name, undefined, { numeric: true }),
    );
  } else {
    // Factor column — sort by signed factor when user explicitly picked.
    sorted.sort((a, b) => sign * (a.factor - b.factor));
  }
  return sorted;
}

/** Case-insensitive substring filter on ``state_name``. */
// eslint-disable-next-line react-refresh/only-export-components
export function filterParticipation(
  rows: ParticipationFactor[],
  query: string,
): ParticipationFactor[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.state_name.toLowerCase().includes(q));
}

/**
 * Back-compat helper retained from Unit 6: rank by descending |factor|
 * and slice to ``maxRows``. Unit 16 removed the in-component cap (the
 * virtualized list handles arbitrary row counts) but kept this export
 * so existing tests / callers don't break.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function rankParticipation(
  rows: ParticipationFactor[],
  maxRows = 200,
): { ranked: ParticipationFactor[]; total: number } {
  const sorted = sortParticipation(rows, DEFAULT_SORT);
  return { ranked: sorted.slice(0, maxRows), total: rows.length };
}

/** Cycle header click: ``none → asc → desc → none`` (per-column). */
function nextSort(current: SortState, column: SortColumn): SortState {
  if (current.column !== column) {
    // Switching columns: jump straight to ascending — gives the user
    // immediate visible feedback without a no-op intermediate state.
    return { column, direction: 'asc' };
  }
  if (current.direction === 'none') return { column, direction: 'asc' };
  if (current.direction === 'asc') return { column, direction: 'desc' };
  return { column, direction: 'none' };
}

interface VirtualRowData {
  rows: ParticipationFactor[];
}

/** Render one virtualized row. Memoized indirectly via ``itemData``. */
function VirtualRow({ index, style, data }: ListChildComponentProps<VirtualRowData>) {
  const row = data.rows[index];
  if (row === undefined) return null;
  return (
    <div
      style={style}
      data-testid={`eig-participation-row-${index}`}
      className={cn('border-border/60 flex items-center border-t text-xs', 'hover:bg-muted/30')}
    >
      <div className="flex-1 truncate px-2 py-1 font-mono">{row.state_name}</div>
      <div className="w-28 px-2 py-1 text-right font-mono">{row.factor.toFixed(4)}</div>
    </div>
  );
}

export function EIGParticipationTable({ className, rows }: EIGParticipationTableProps) {
  const selectedModeId = useAnalyzeStore((s) => s.selectedModeId);
  const subMode = useAnalyzeStore((s) => s.subMode);

  // ``rows`` prop overrides the query path entirely (used in tests);
  // when not supplied, fetch via the analyze store's selected mode.
  const query = useEigParticipation(rows === undefined ? selectedModeId : null);

  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);

  // ⌘/ focuses the filter input — only when we're on the EIG sub-mode
  // (see header note for the rationale). When ``rows`` is provided
  // (test path) we still register so the binding is unit-testable in
  // isolation; in production the parent always lives under the
  // analyze panel and the sub-mode gating is meaningful.
  const focusFilter = useCallback((event: KeyboardEvent) => {
    event.preventDefault();
    filterInputRef.current?.focus();
    filterInputRef.current?.select();
  }, []);
  useHotkeys(
    'meta+slash, ctrl+slash',
    focusFilter,
    {
      enabled: rows !== undefined || subMode === 'eig',
      enableOnFormTags: ['INPUT', 'TEXTAREA'],
    },
    [focusFilter, subMode, rows],
  );

  // Resolve rows: prop wins, otherwise the query.
  const displayRows: ParticipationFactor[] | null =
    rows !== undefined ? rows : query.data ? query.data.participation : null;

  // Filter + sort. Memoize so virtualization doesn't recompute on
  // unrelated re-renders (sub-mode flips, theme toggles).
  const processed = useMemo(() => {
    const base = displayRows ?? [];
    const filtered = filterParticipation(base, filter);
    const sorted = sortParticipation(filtered, sort);
    return { sorted, total: base.length, filteredCount: filtered.length };
  }, [displayRows, filter, sort]);

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
          'border-danger/40 bg-danger/10 text-danger',
          'rounded border p-3 text-xs',
          className,
        )}
      >
        {query.error?.message ?? 'Failed to load participation factors.'}
      </div>
    );
  }

  if (processed.total === 0) {
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

  const sortGlyph = (column: SortColumn): string => {
    if (sort.column !== column || sort.direction === 'none') return '';
    return sort.direction === 'asc' ? ' ↑' : ' ↓';
  };

  const useVirtualization = processed.sorted.length > VIRTUALIZE_THRESHOLD;

  return (
    <div
      data-testid="eig-participation-table"
      className={cn(
        'border-border bg-background flex flex-col overflow-hidden rounded border',
        className,
      )}
    >
      <div className="border-border text-muted-foreground border-b px-2 py-1 text-[10px]">
        Participation factors ({processed.sorted.length}
        {processed.filteredCount !== processed.total
          ? ` of ${processed.total} matched`
          : ` of ${processed.total}`}
        )
      </div>
      <div className="border-border border-b p-2">
        <Input
          ref={filterInputRef}
          value={filter}
          onChange={setFilter}
          placeholder="Filter states…"
          aria-label="Filter participation factors by state name"
          data-testid="participation-filter-input"
          className="h-7 text-xs"
        />
      </div>
      {processed.sorted.length === 0 ? (
        <div
          data-testid="participation-empty-filter"
          className="text-muted-foreground flex min-h-[80px] items-center justify-center px-2 py-4 text-xs"
        >
          No states match “{filter}”.
        </div>
      ) : useVirtualization ? (
        <>
          <div
            className="bg-muted/40 text-muted-foreground border-border flex border-b text-xs font-medium"
            role="row"
          >
            <button
              type="button"
              onClick={() => setSort((s) => nextSort(s, 'state'))}
              className={cn(
                'flex flex-1 cursor-pointer items-center px-2 py-1 text-left',
                'hover:text-foreground focus-visible:outline-none',
              )}
              data-testid="participation-header-state"
              aria-sort={
                sort.column === 'state' && sort.direction !== 'none'
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              }
            >
              State{sortGlyph('state')}
            </button>
            <button
              type="button"
              onClick={() => setSort((s) => nextSort(s, 'factor'))}
              className={cn(
                'flex w-28 cursor-pointer items-center justify-end px-2 py-1 text-right',
                'hover:text-foreground focus-visible:outline-none',
              )}
              data-testid="participation-header-factor"
              aria-sort={
                sort.column === 'factor' && sort.direction !== 'none'
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              }
            >
              Factor{sortGlyph('factor')}
            </button>
          </div>
          <FixedSizeList<VirtualRowData>
            height={Math.min(VIRTUAL_VIEWPORT_HEIGHT, processed.sorted.length * ROW_HEIGHT)}
            itemCount={processed.sorted.length}
            itemSize={ROW_HEIGHT}
            width="100%"
            itemData={{ rows: processed.sorted }}
            overscanCount={4}
          >
            {VirtualRow}
          </FixedSizeList>
        </>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground sticky top-0">
              <tr>
                <th
                  scope="col"
                  className="px-0 py-0 text-left font-medium"
                  aria-sort={
                    sort.column === 'state' && sort.direction !== 'none'
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    onClick={() => setSort((s) => nextSort(s, 'state'))}
                    className={cn(
                      'flex w-full cursor-pointer items-center px-2 py-1 text-left',
                      'hover:text-foreground focus-visible:outline-none',
                    )}
                    data-testid="participation-header-state"
                  >
                    State{sortGlyph('state')}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-0 py-0 text-right font-medium"
                  aria-sort={
                    sort.column === 'factor' && sort.direction !== 'none'
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    onClick={() => setSort((s) => nextSort(s, 'factor'))}
                    className={cn(
                      'flex w-full cursor-pointer items-center justify-end px-2 py-1 text-right',
                      'hover:text-foreground focus-visible:outline-none',
                    )}
                    data-testid="participation-header-factor"
                  >
                    Factor{sortGlyph('factor')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {processed.sorted.map((row, idx) => (
                <tr
                  key={`${row.state_name}-${idx}`}
                  data-testid={`eig-participation-row-${idx}`}
                  className="border-border/60 hover:bg-muted/30 border-t"
                >
                  <td className="px-2 py-1 font-mono">{row.state_name}</td>
                  <td className="px-2 py-1 text-right font-mono">{row.factor.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
