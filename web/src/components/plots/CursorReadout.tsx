import { usePlotStore } from '@/store/plot';
import type { DeltaCursors } from '@/store/plot';
import { formatSignificant } from '@/lib/series';
import { cn } from '@/lib/cn';
import { cursorHint } from './cursorRows';
import type { CursorRow } from './cursorRows';

/**
 * The A/B delta cursors of the plot: the button that turns click-to-place on
 * (and the line saying what the next click does), and the readout under it, the
 * time of each cursor and, for every plotted series, its value at A and at B,
 * the difference and the average rate of change between them.
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
          Clear
        </button>
      ) : null}
    </div>
  );
}

/** ``b - a`` where both exist, otherwise ``null``. */
function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export interface CursorReadoutProps {
  cursors: DeltaCursors;
  rows: readonly CursorRow[];
  className?: string;
}

export function CursorReadout({ cursors, rows, className }: CursorReadoutProps) {
  const dt = difference(cursors.a, cursors.b);
  const cell = 'px-2 py-0.5 text-right font-mono';
  return (
    <div
      data-testid="cursor-readout"
      className={cn(
        'border-border flex flex-col gap-1 rounded border px-2 py-1.5 text-xs',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
        <span data-testid="cursor-readout-a">
          <span className="text-muted-foreground">A </span>
          <span className="font-mono">
            {cursors.a === null ? '–' : `${formatSignificant(cursors.a, 5)} s`}
          </span>
        </span>
        <span data-testid="cursor-readout-b">
          <span className="text-muted-foreground">B </span>
          <span className="font-mono">
            {cursors.b === null ? '–' : `${formatSignificant(cursors.b, 5)} s`}
          </span>
        </span>
        <span data-testid="cursor-readout-dt">
          <span className="text-muted-foreground">Δt </span>
          <span className="font-mono">{dt === null ? '–' : `${formatSignificant(dt, 5)} s`}</span>
        </span>
      </div>
      {rows.length > 0 ? (
        <div className="max-h-32 overflow-auto">
          <table className="w-full border-collapse text-xs">
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
      ) : null}
    </div>
  );
}
