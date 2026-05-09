import { useMemo } from 'react';
import type uPlot from 'uplot';
import { useRunsStore } from '@/store/runs';
import { usePlotStore, parseColumnName, groupAxisLabel, groupLabel } from '@/store/plot';
import type { VarGroup } from '@/store/plot';
import type { RunRecord } from '@/store/runs';
import { UPlot } from './UPlot';
import { cn } from '@/lib/cn';

/**
 * Stacked uPlot instances — one per non-empty variable group — sharing
 * a sync key so the cursor moves in lockstep across all stacks.
 *
 * Reads from ``useRunsStore`` (active run) and ``usePlotStore``
 * (selected series + group expand state). When no run is active OR
 * no series selected, renders the empty-state copy.
 *
 * Data flow:
 *  1. Subscribe to the active run; resolve its column metadata.
 *  2. Group the selected series by ``VarGroup`` (parse column names).
 *  3. For each group with at least one selected series, build an
 *     ``AlignedData`` of ``[t.subarray(0, seqCount), ...selected
 *     columns subarray]``. Typed-array subarrays are zero-copy.
 *  4. Pass each group's data + options into a ``<UPlot>``. All
 *     instances share ``cursor.sync.key = "tds-run-<runId>"`` so
 *     hovering one moves the cursor on the others.
 *
 * Re-render strategy: this component re-renders on runs-store changes
 * (new frames append) and on plot-store changes (selection toggle).
 * The frame-append path is the hot one (30 Hz max). For each render
 * we pass freshly-sliced typed arrays into ``<UPlot>`` whose data
 * effect calls ``setData`` — uPlot handles redraw efficiently from
 * there. We intentionally do NOT re-create the uPlot instance on data
 * change (only on series-set change).
 */
export interface TimeSeriesPlotProps {
  /**
   * Optional override for the run id rendered. Defaults to the active
   * run from the runs store. Tests pass an explicit value to bypass
   * the store coupling.
   */
  runId?: string;
  className?: string;
}

/** Distinguishable color palette (10 colors) — picked for WCAG AA contrast. */
const PALETTE: readonly string[] = [
  'oklch(0.55 0.20 28)', // red-orange
  'oklch(0.65 0.18 75)', // amber
  'oklch(0.65 0.18 145)', // green
  'oklch(0.60 0.18 200)', // cyan
  'oklch(0.55 0.22 265)', // blue
  'oklch(0.55 0.22 320)', // magenta
  'oklch(0.45 0.10 0)', // muted red
  'oklch(0.50 0.13 100)', // olive
  'oklch(0.50 0.13 175)', // teal
  'oklch(0.50 0.18 295)', // purple
];

/** Pick a stable color from the palette by series-name hash. */
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length]!;
}

/** Build the uPlot options + data for one variable group. */
function buildGroupChart(
  run: RunRecord,
  group: VarGroup,
  selectedNames: readonly string[],
  syncKey: string,
): { options: uPlot.Options; data: uPlot.AlignedData } {
  // Slice typed arrays to the logical seq count (the typed arrays are
  // over-allocated by the runs slice's geometric growth strategy).
  const len = run.seqCount;
  const tSlice = run.t.subarray(0, len);
  const dataCols: uPlot.AlignedData = [tSlice];

  const series: uPlot.Series[] = [{ label: 't' }];
  for (const name of selectedNames) {
    const col = run.columns[name];
    if (!col) continue;
    dataCols.push(col.subarray(0, len));
    series.push({
      label: name,
      stroke: colorFor(name),
      width: 1.5,
      points: { show: false },
    });
  }

  const options: uPlot.Options = {
    width: 600,
    height: 200,
    series,
    scales: {
      x: { time: false },
    },
    axes: [{ label: 't (s)' }, { label: groupAxisLabel(group) }],
    cursor: {
      sync: { key: syncKey, setSeries: false },
      drag: { x: true, y: false, uni: 50 },
    },
    legend: { show: true },
  };

  return { options, data: dataCols };
}

/** Empty-state placeholder shown when no series are selected (or no run). */
function EmptyState({ message }: { message: string }) {
  return (
    <div
      data-testid="time-series-plot-empty"
      className={cn(
        'flex h-full w-full items-center justify-center',
        'text-muted-foreground text-sm',
      )}
    >
      {message}
    </div>
  );
}

export function TimeSeriesPlot({ runId, className }: TimeSeriesPlotProps) {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const effectiveRunId = runId ?? activeRunId;
  const run = useRunsStore((s) => (effectiveRunId ? s.runs[effectiveRunId] : undefined));
  const selected = usePlotStore((s) =>
    effectiveRunId ? s.selectedByRun[effectiveRunId] : undefined,
  );

  // Group the selected series by VarGroup using the column-name parser.
  // Order within each group follows the run's ``columnNames`` (stable
  // insertion order from stream-start metadata) so the legend reads
  // naturally — Bus 1, Bus 2, ... rather than hash order.
  const groupedSelections = useMemo(() => {
    if (!run || !selected) return new Map<VarGroup, string[]>();
    const groups = new Map<VarGroup, string[]>();
    for (const name of run.columnNames) {
      if (!selected.has(name)) continue;
      const parsed = parseColumnName(name);
      if (!parsed) continue;
      const bucket = groups.get(parsed.group);
      if (bucket) bucket.push(name);
      else groups.set(parsed.group, [name]);
    }
    return groups;
  }, [run, selected]);

  const syncKey = effectiveRunId ? `tds-run-${effectiveRunId}` : 'tds-run-empty';

  // Build per-group chart props. ``useMemo`` keys on the run + selection
  // so the construction effect inside <UPlot /> only re-fires when
  // the series-set actually changes; data updates flow through the
  // data prop and trigger uPlot.setData inside the wrapper.
  const charts = useMemo(() => {
    if (!run) return [];
    const out: Array<{ group: VarGroup; options: uPlot.Options; data: uPlot.AlignedData }> = [];
    for (const [group, names] of groupedSelections) {
      out.push({ group, ...buildGroupChart(run, group, names, syncKey) });
    }
    return out;
    // ``run`` reference changes every frame append (Zustand returns a
    // new object), so this memo recomputes each frame — that's the
    // intended hot path; the memo's role here is just structuring.
  }, [run, groupedSelections, syncKey]);

  if (!effectiveRunId || !run) {
    return (
      <div className={cn('h-full w-full', className)}>
        <EmptyState message="Run a TDS to see results" />
      </div>
    );
  }

  if (charts.length === 0) {
    return (
      <div className={cn('h-full w-full', className)}>
        <EmptyState message="Select variables to plot" />
      </div>
    );
  }

  return (
    <div
      data-testid="time-series-plot"
      data-run-id={effectiveRunId}
      className={cn('flex h-full w-full flex-col gap-2', className)}
    >
      {charts.map(({ group, options, data }) => (
        <div
          key={group}
          data-testid={`time-series-plot-group-${group}`}
          className="border-border min-h-[80px] flex-1 overflow-hidden rounded border"
        >
          <div className="text-muted-foreground border-border border-b px-2 py-1 text-xs font-medium">
            {groupLabel(group)}
          </div>
          <div className="h-[calc(100%-1.75rem)]">
            <UPlot options={options} data={data} />
          </div>
        </div>
      ))}
    </div>
  );
}
