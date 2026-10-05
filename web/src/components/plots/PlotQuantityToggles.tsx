import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';
import { cn } from '@/lib/cn';
import { usePlotRunId } from './overlayRuns';
import { MAX_ELEMENTS, QUANTITIES, isQuantityOn, seriesOf, toggleQuantity } from './plotQuantities';

/**
 * PlotQuantityToggles. One button per quantity a run records for the bus and
 * the machine groups (bus voltage and angle, generator speed and rotor angle),
 * above the plot. Each shows whether that quantity is on the plot and flips it,
 * so "voltage and angle together" and "speed and angle together" are two clicks
 * instead of a walk down the variable tree, which stays for picking single
 * elements. Which elements a quantity takes is decided in ``plotQuantities.ts``.
 */

export interface PlotQuantityTogglesProps {
  /** Override the active run id (mostly for tests). */
  runId?: string;
  className?: string;
}

export function PlotQuantityToggles({ runId, className }: PlotQuantityTogglesProps) {
  const effectiveRunId = usePlotRunId(runId);
  // The column names are fixed for a run, so a streamed frame leaves this alone.
  const columnNames = useRunsStore(
    useShallow((s) => (effectiveRunId ? (s.runs[effectiveRunId]?.columnNames ?? []) : [])),
  );
  const selected = usePlotStore((s) =>
    effectiveRunId ? s.selectedByRun[effectiveRunId] : undefined,
  );
  const setSelection = usePlotStore((s) => s.setSelection);

  const available = useMemo(
    () =>
      QUANTITIES.map((q) => ({ q, count: seriesOf(columnNames, q.group, q.field).length })).filter(
        ({ count }) => count > 0,
      ),
    [columnNames],
  );

  if (!effectiveRunId || available.length === 0) return null;
  const selection: ReadonlySet<string> = selected ?? new Set<string>();

  return (
    <div
      role="group"
      aria-label="Quantities to plot"
      data-testid="plot-quantity-toggles"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      <span className="text-muted-foreground text-xs">Plot</span>
      {available.map(({ q, count }) => {
        const on = isQuantityOn(columnNames, selection, q);
        return (
          <button
            key={`${q.group}:${q.field}`}
            type="button"
            aria-pressed={on}
            data-testid={`plot-quantity-${q.group}-${q.field}`}
            title={
              count > MAX_ELEMENTS
                ? `Show or hide ${q.label.toLowerCase()}: the first ${MAX_ELEMENTS} of ${count} ${q.noun}. Choose variables picks others.`
                : `Show or hide ${q.label.toLowerCase()}`
            }
            onClick={() => setSelection(effectiveRunId, toggleQuantity(columnNames, selection, q))}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              on
                ? 'border-primary/50 bg-primary/15 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {q.label}
          </button>
        );
      })}
    </div>
  );
}
