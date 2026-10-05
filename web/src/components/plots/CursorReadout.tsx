import { useState } from 'react';
import { usePlotStore } from '@/store/plot';
import type { DeltaCursors } from '@/store/plot';
import { formatSignificant } from '@/lib/series';
import { cn } from '@/lib/cn';
import { cursorHint } from './cursorRows';
import type { CursorRow } from './cursorRows';

/**
 * The A/B delta cursors of the plot: the button that turns click-to-place on
 * (and the line saying what the next click does), the strip under it with the
 * time of each cursor, which can also be typed, and the table that goes under the
 * charts with, for every plotted series, its value at A and at B, the difference
 * and the average rate of change between them.
 *
 * The table is under the charts, not above them: in the bottom drawer, which is
 * barely taller than one chart, a table above them left nothing of the charts to
 * click once the mode was on.
 *
 * Differences are B minus A, so a cursor B left of A reads as negative time and
 * a drop reads as negative, whichever way the user placed them.
 */

export interface CursorControlsProps {
  runId: string;
  className?: string;
}

export function CursorControls({ runId, className }: CursorControlsProps) {
  const armed = usePlotStore((s) => s.cursorsArmed);
  const setArmed = usePlotStore((s) => s.setCursorsArmed);
  const cursors = usePlotStore((s) => s.cursorsByRun[runId]);
  const clearCursors = usePlotStore((s) => s.clearCursors);
  const placed = cursors !== undefined && (cursors.a !== null || cursors.b !== null);
  return (
    <div
      role="group"
      aria-label="A/B cursors"
      data-testid="plot-cursor-controls"
      data-export-ignore=""
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      <button
        type="button"
        aria-pressed={armed}
        data-testid="plot-cursors-toggle"
        title="Click the plot to place two cursors, A and B, and read the difference between them"
        onClick={() => setArmed(!armed)}
        className={cn(
          'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          armed
            ? 'border-primary/50 bg-primary/15 text-foreground'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        Cursors
      </button>
      {armed ? (
        <span data-testid="plot-cursors-hint" className="text-muted-foreground text-xs">
          {cursorHint(cursors)}
        </span>
      ) : (
        <span data-testid="plot-zoom-hint" className="text-muted-foreground text-[10px]">
          Drag a chart to zoom time on all of them, double-click to reset
        </span>
      )}
      {placed ? (
        <button
          type="button"
          data-testid="plot-cursors-clear"
          onClick={() => clearCursors(runId)}
          className={cn(
            'text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 text-xs underline',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          Clear cursors
        </button>
      ) : null}
    </div>
  );
}

/** ``b - a`` where both exist, otherwise ``null``. */
function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export interface CursorTimesProps {
  cursors: DeltaCursors;
  /** Put one cursor at ``t``, or take it off the plot with ``null``. */
  onSet: (which: keyof DeltaCursors, t: number | null) => void;
  className?: string;
}

/**
 * The time of each cursor and the time between them. A time is also a box to
 * type in, which places a cursor without a click on a chart: exactly where the
 * pointer cannot be put (the disturbance at 2 s), and for a keyboard or a screen
 * reader, which have no other way to place one. Enter or leaving the box sets it,
 * and emptying it takes the cursor off.
 */
export function CursorTimes({ cursors, onSet, className }: CursorTimesProps) {
  const dt = difference(cursors.a, cursors.b);
  return (
    <div
      role="group"
      aria-label="Cursor times"
      data-testid="cursor-readout"
      // Stays at the top of the plot panel while the charts are scrolled, so the
      // times can be read from whichever chart the cursor is being placed on. The
      // panel pads its content by 0.5rem, and a strip stuck at the content's edge
      // would show the charts passing in that gap, so it sticks at the panel's own.
      className={cn(
        'border-border bg-background sticky -top-2 z-10 flex flex-wrap items-center gap-x-4 gap-y-1',
        'rounded border px-2 py-1 text-xs',
        className,
      )}
    >
      <CursorTimeField which="a" value={cursors.a} onSet={onSet} />
      <CursorTimeField which="b" value={cursors.b} onSet={onSet} />
      <span data-testid="cursor-readout-dt">
        <span className="text-muted-foreground">Δt </span>
        <span className="font-mono">{dt === null ? '–' : `${formatSignificant(dt, 5)} s`}</span>
      </span>
      <span className="text-muted-foreground">
        Type a time to place a cursor exactly. Drag a chart to zoom, double-click to reset. The
        values of each series are under the charts.
      </span>
    </div>
  );
}

function CursorTimeField({
  which,
  value,
  onSet,
}: {
  which: keyof DeltaCursors;
  value: number | null;
  onSet: CursorTimesProps['onSet'];
}) {
  // What has been typed and not yet set; ``null`` while the box shows the cursor.
  const [draft, setDraft] = useState<string | null>(null);
  const name = which.toUpperCase();
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim().replace(',', '.');
    setDraft(null);
    if (text === '') {
      onSet(which, null);
      return;
    }
    const t = Number(text);
    if (Number.isFinite(t)) onSet(which, t);
  };
  return (
    <label className="flex items-center gap-1">
      <span className="text-muted-foreground">{name}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={`Cursor ${name} time in seconds`}
        data-testid={`cursor-readout-${which}`}
        placeholder="–"
        value={draft ?? (value === null ? '' : formatSignificant(value, 5))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setDraft(null);
        }}
        className={cn(
          'border-border bg-background w-20 rounded border px-1.5 py-0.5 text-right font-mono',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      />
      <span className="text-muted-foreground">s</span>
    </label>
  );
}

export interface CursorTableProps {
  cursors: DeltaCursors;
  rows: readonly CursorRow[];
  className?: string;
}

/** Every plotted series at the cursors: its value at A and at B, the difference and the average rate. */
export function CursorTable({ cursors, rows, className }: CursorTableProps) {
  if (rows.length === 0) return null;
  const dt = difference(cursors.a, cursors.b);
  const cell = 'px-2 py-0.5 text-right font-mono';
  return (
    <div
      data-testid="cursor-readout-table"
      className={cn('border-border rounded border px-2 py-1.5 text-xs', className)}
    >
      <p className="text-muted-foreground px-2 pb-1 font-medium">Values at the cursors</p>
      <div className="max-h-64 overflow-auto">
        <table aria-label="Values at the cursors" className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="px-2 py-0.5 text-left font-medium">Series</th>
              <th className={cn(cell, 'font-medium')}>A</th>
              <th className={cn(cell, 'font-medium')}>B</th>
              <th className={cn(cell, 'font-medium')}>Δ (B − A)</th>
              <th className={cn(cell, 'font-medium')}>Δ / Δt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const delta = difference(row.a, row.b);
              return (
                <tr key={row.key} data-testid={`cursor-readout-row-${row.key}`}>
                  <td className="px-2 py-0.5 text-left">
                    <span className="font-mono">{row.label}</span>
                    {row.axis === '' ? null : (
                      <span className="text-muted-foreground"> · {row.axis}</span>
                    )}
                  </td>
                  <td className={cell}>{formatSignificant(row.a)}</td>
                  <td className={cell}>{formatSignificant(row.b)}</td>
                  <td className={cell}>{formatSignificant(delta)}</td>
                  <td className={cell}>
                    {delta === null || dt === null || dt === 0
                      ? '–'
                      : formatSignificant(delta / dt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
