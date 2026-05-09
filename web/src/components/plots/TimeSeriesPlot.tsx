import { useCallback, useEffect, useMemo, useRef } from 'react';
import type uPlot from 'uplot';
import { useRunsStore } from '@/store/runs';
import {
  usePlotStore,
  parseColumnName,
  groupAxisLabel,
  groupLabel,
  findClosestFrameIdx,
} from '@/store/plot';
import type { VarGroup } from '@/store/plot';
import type { RunRecord } from '@/store/runs';
import { UPlot } from './UPlot';
import { RunLegendChip } from './RunLegendChip';
import { ExportMenu } from '@/components/export/ExportMenu';
import { timeSeriesToCsv } from '@/components/export/exportToCsv';
import { elementToPng } from '@/components/export/exportToPng';
import { useCaseStore } from '@/store/case';
import { runIdToStrokeStyle } from '@/lib/runIdToColor';
import { cn } from '@/lib/cn';

/**
 * Stacked uPlot instances — one per non-empty variable group — sharing
 * a sync key so the cursor moves in lockstep across all stacks.
 *
 * Reads from ``useRunsStore`` (active run + overlay set) and
 * ``usePlotStore`` (selected series + group expand state). When no run
 * is active OR no series selected, renders the empty-state copy.
 *
 * **Multi-run overlay (Unit 9, v2.0):** when ``overlayRunIds.size > 1``
 * the plot renders one series family per overlay run, each coloured by
 * a runId-stable hash (see ``runIdToStrokeStyle``). All overlay runs
 * share the variable selection (the picker shows a per-run filter
 * row above the tree when overlay > 1 — see ``VariableTreePicker``).
 * When ``overlayRunIds`` is empty, the plot falls back to the active
 * run only.
 *
 * Mismatched timelines: each run keeps its own t-column, so a run
 * with ``tf=5`` simply ends at t=5 in the stacked plot's shared
 * x-axis (uPlot's ``AlignedData`` accepts NaN gaps; we instead use
 * one ``Series`` per (run, var) pair so the absent rows are simply
 * not plotted past their end).
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
   *
   * When set, this overrides the multi-run overlay set — the plot
   * renders the explicit run only. This preserves the legacy
   * single-run test surface.
   */
  runId?: string;
  className?: string;
}

/**
 * Single-run-mode (legacy) palette: distinguishable colors for variables
 * within one run. When the plot is in multi-run mode we instead colour
 * by the runId-hash; vars within one run share the run's colour and
 * differ only by uPlot's built-in series legend ordering.
 */
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

/**
 * Build the uPlot options + data for one variable group, single-run mode.
 * Each series gets a unique colour from the variable-name palette.
 */
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

/**
 * Build the uPlot options + data for one variable group, multi-run mode.
 *
 * uPlot's ``AlignedData`` requires every series to share a single x
 * (time) column. Since overlay runs may have mismatched timelines, we
 * build the **union of all timestamps** (sorted ascending, dedup'd),
 * then resample each (run, var) onto that shared axis using NaN for
 * the timestamps before the run's first sample and after its last.
 * uPlot renders NaN as a gap, so a run with ``tf=5`` simply has no
 * line past t=5 in the shared plot.
 *
 * For runs with O(1k) frames each and 5 overlay runs this is O(N log N)
 * once per render — fast enough at the v2.0 scale (the underlying
 * single-run path is still the hot path; multi-run is a deliberate
 * sub-30 Hz operation when the user pins extra runs).
 */
function buildMultiRunGroupChart(
  runs: readonly RunRecord[],
  group: VarGroup,
  selectedNames: readonly string[],
  syncKey: string,
): { options: uPlot.Options; data: uPlot.AlignedData } {
  // Collect the union of timestamps. Use a Set for dedup; sort once at
  // the end. Each run's t-array is already sorted, so a merge would be
  // O(N) total — but for v2.0 sizes the Set+sort is simpler and
  // benchmarks fine.
  const tSet = new Set<number>();
  for (const run of runs) {
    const len = run.seqCount;
    for (let i = 0; i < len; i += 1) tSet.add(run.t[i]!);
  }
  const tUnion = new Float64Array(tSet.size);
  let i = 0;
  for (const t of tSet) tUnion[i++] = t;
  // ``Float64Array.sort`` compares numerically (unlike Array.prototype.sort
  // which compares lexicographically by default).
  tUnion.sort();

  // Build a map from t-value → row index for lookup during resampling.
  const tIndex = new Map<number, number>();
  for (let j = 0; j < tUnion.length; j += 1) tIndex.set(tUnion[j]!, j);

  const dataCols: uPlot.AlignedData = [tUnion];
  const series: uPlot.Series[] = [{ label: 't' }];

  for (const run of runs) {
    const style = runIdToStrokeStyle(run.runId);
    const len = run.seqCount;
    for (const name of selectedNames) {
      const col = run.columns[name];
      if (!col) continue;
      // Resample: copy known values, leave NaN elsewhere.
      const resampled = new Float64Array(tUnion.length).fill(NaN);
      for (let k = 0; k < len; k += 1) {
        const idx = tIndex.get(run.t[k]!);
        if (idx === undefined) continue;
        resampled[idx] = col[k]!;
      }
      dataCols.push(resampled);
      // Series label encodes the run prefix + var name so the legend
      // distinguishes the same var across runs.
      const runPrefix = run.runId.length > 8 ? run.runId.slice(0, 8) : run.runId;
      const seriesProps: uPlot.Series = {
        label: `${runPrefix}·${name}`,
        stroke: style.color,
        width: 1.5,
        points: { show: false },
      };
      // uPlot's Series.dash is typed as number[] — only set when non-empty
      // so the default solid behaviour kicks in.
      if (style.dash.length > 0) {
        seriesProps.dash = [...style.dash];
      }
      series.push(seriesProps);
    }
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

/**
 * One chart in the stacked uPlot column. Wraps ``<UPlot>`` and drives
 * the underlying uPlot instance's cursor imperatively when ``scrubT``
 * is set: the cursor's index is the closest frame index for the run
 * timeline (binary searched). When ``scrubT === null`` (live mode)
 * we leave the cursor alone — uPlot's built-in cursor follows the
 * pointer, and the plot's data tail is the head of stream.
 */
function GroupChart({
  group,
  options,
  data,
  run,
  scrubT,
}: {
  group: VarGroup;
  options: uPlot.Options;
  data: uPlot.AlignedData;
  run: RunRecord;
  scrubT: number | null;
}) {
  const uplotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const inst = uplotRef.current;
    if (!inst) return;
    if (scrubT === null) {
      // Live mode: leave the cursor alone — uPlot's pointer-driven
      // cursor handles hover, and the plot's data tail is the head of
      // stream so a moving "live cursor" would be visually redundant
      // with the right edge of the chart anyway. The next user
      // interaction (hover, click) will move the cursor.
      return;
    }
    // Translate scrubT → frame index → x-pixel (via uPlot's valToPos).
    // We do the index lookup ourselves (not uPlot's valToIdx) because
    // the runs slice may over-allocate the t typed array; we know the
    // logical seqCount and don't want the uPlot data array's length
    // to shadow it (they should match in practice but the binary
    // search is cheap and self-documenting).
    const idx = findClosestFrameIdx(run.t, run.seqCount, scrubT);
    if (idx < 0) return;
    const t = run.t[idx];
    if (t === undefined) return;
    // valToPos returns CSS pixels (canvasPixels=false) — what setCursor wants.
    // jsdom: the underlying canvas has zero size, but our jsdom test
    // shim mocks uPlot entirely, so the call is captured by the spy
    // and never reaches the real implementation.
    let left = 0;
    try {
      left = inst.valToPos(t, 'x');
    } catch {
      // Some uPlot mocks (and the very-first render before scales are
      // set up) can throw; fall back to 0 — the cursor is a transient
      // visual cue, not load-bearing for correctness.
      left = 0;
    }
    inst.setCursor({ left, top: 0 }, false);
  }, [scrubT, run]);

  return (
    <div
      key={group}
      data-testid={`time-series-plot-group-${group}`}
      className="border-border min-h-[80px] flex-1 overflow-hidden rounded border"
    >
      <div className="text-muted-foreground border-border border-b px-2 py-1 text-xs font-medium">
        {groupLabel(group)}
      </div>
      <div className="h-[calc(100%-1.75rem)]">
        <UPlot options={options} data={data} uplotRef={uplotRef} />
      </div>
    </div>
  );
}

export function TimeSeriesPlot({ runId, className }: TimeSeriesPlotProps) {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const overlayRunIds = useRunsStore((s) => s.overlayRunIds);
  const allRuns = useRunsStore((s) => s.runs);
  const effectiveRunId = runId ?? activeRunId;

  // Resolve the set of runs to render. Priority:
  //   1. Explicit ``runId`` prop  → render that run only.
  //   2. Non-empty ``overlayRunIds`` → render those.
  //   3. Active run                → render it only (legacy single-run mode).
  // The intersection of the picker selection (in plot store) is shared
  // across all overlay runs.
  const overlayRuns = useMemo<readonly RunRecord[]>(() => {
    if (runId) {
      const r = allRuns[runId];
      return r ? [r] : [];
    }
    if (overlayRunIds.size > 0) {
      const out: RunRecord[] = [];
      // Iterate in runs-map insertion order (chronological) for stable
      // legend layout.
      for (const id of Object.keys(allRuns)) {
        if (overlayRunIds.has(id)) out.push(allRuns[id]!);
      }
      return out;
    }
    if (activeRunId && allRuns[activeRunId]) return [allRuns[activeRunId]!];
    return [];
  }, [runId, overlayRunIds, allRuns, activeRunId]);

  const isMultiRun = overlayRuns.length > 1;
  const primaryRun = overlayRuns[0];

  const selected = usePlotStore((s) =>
    effectiveRunId ? s.selectedByRun[effectiveRunId] : undefined,
  );
  const scrubT = usePlotStore((s) =>
    effectiveRunId ? (s.scrubByRun[effectiveRunId] ?? null) : null,
  );
  const primaryPath = useCaseStore((s) => s.selection?.primaryPath ?? null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Group the selected series by VarGroup using the column-name parser.
  // In single-run mode we use the run's columnNames for stable order;
  // in multi-run mode we use the union of column names across overlay
  // runs (still ordered by primary run first, then any extras).
  const groupedSelections = useMemo(() => {
    if (overlayRuns.length === 0 || !selected) return new Map<VarGroup, string[]>();
    const groups = new Map<VarGroup, string[]>();
    const seen = new Set<string>();
    const orderedNames: string[] = [];
    for (const run of overlayRuns) {
      for (const name of run.columnNames) {
        if (seen.has(name)) continue;
        seen.add(name);
        orderedNames.push(name);
      }
    }
    for (const name of orderedNames) {
      if (!selected.has(name)) continue;
      const parsed = parseColumnName(name);
      if (!parsed) continue;
      const bucket = groups.get(parsed.group);
      if (bucket) bucket.push(name);
      else groups.set(parsed.group, [name]);
    }
    return groups;
  }, [overlayRuns, selected]);

  const syncKey = effectiveRunId ? `tds-run-${effectiveRunId}` : 'tds-run-empty';

  // CSV export builds a long-form `(time, variable, value)` table over
  // the currently-selected series. Slices the run's typed-array columns
  // to the logical seqCount before serialising. When the run is in
  // `connection: "lagged"` state the runs slice has already evicted
  // some early rows; we surface a generic warning header (the runs
  // slice does not currently track the dropped count — Unit 2
  // plan-divergence: per-run dropped-row tracking deferred).
  //
  // CSV export is single-run only — it exports the primary (first
  // overlay) run. Multi-run CSV would need to combine timelines and
  // is deferred to Unit 18.
  const onExportCsv = useCallback(() => {
    const run = primaryRun;
    if (!run || !selected || selected.size === 0) return null;
    const len = run.seqCount;
    if (len === 0) return null;
    const tSlice = run.t.subarray(0, len);
    const orderedNames: string[] = [];
    for (const name of run.columnNames) {
      if (selected.has(name)) orderedNames.push(name);
    }
    const cols: Record<string, ArrayLike<number>> = {};
    for (const name of orderedNames) {
      const col = run.columns[name];
      if (!col) continue;
      cols[name] = col.subarray(0, len);
    }
    // Lagged-run signal: the runs slice flips `connection` to `"lagged"`
    // when active-run eviction kicks in, but doesn't expose the row
    // count. Pass `1` so the warning header is emitted; downstream
    // tooling can detect truncation even without an exact count.
    const droppedRowCount = run.connection === 'lagged' ? 1 : undefined;
    return timeSeriesToCsv({
      t: tSlice,
      columns: cols,
      droppedRowCount,
    });
  }, [primaryRun, selected]);

  // PNG export rasterises the chart container (uPlot canvas + axis
  // labels + legend) via html-to-image. Returns null when the chart
  // hasn't laid out yet so the menu surfaces "No data to export".
  const onExportPng = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return null;
    return await elementToPng(el);
  }, []);

  const caseName = primaryPath ? deriveCaseName(primaryPath) : 'case';

  // Build per-group chart props. ``useMemo`` keys on the runs + selection
  // so the construction effect inside <UPlot /> only re-fires when
  // the series-set actually changes; data updates flow through the
  // data prop and trigger uPlot.setData inside the wrapper.
  const charts = useMemo(() => {
    if (overlayRuns.length === 0) return [];
    const out: Array<{ group: VarGroup; options: uPlot.Options; data: uPlot.AlignedData }> = [];
    for (const [group, names] of groupedSelections) {
      if (isMultiRun) {
        out.push({ group, ...buildMultiRunGroupChart(overlayRuns, group, names, syncKey) });
      } else {
        out.push({ group, ...buildGroupChart(primaryRun!, group, names, syncKey) });
      }
    }
    return out;
    // ``overlayRuns`` reference changes every frame append (Zustand
    // returns a new object), so this memo recomputes each frame —
    // that's the intended hot path; the memo's role here is just
    // structuring.
  }, [overlayRuns, isMultiRun, primaryRun, groupedSelections, syncKey]);

  if (!effectiveRunId || overlayRuns.length === 0) {
    return (
      <div className={cn('h-full w-full', className)}>
        <div className="flex justify-end">
          <ExportMenu formats={['csv', 'png']} disabled panel="time-series" />
        </div>
        <EmptyState message="Run a TDS to see results" />
      </div>
    );
  }

  if (charts.length === 0) {
    return (
      <div className={cn('h-full w-full', className)}>
        <div className="flex justify-end">
          <ExportMenu formats={['csv', 'png']} disabled panel="time-series" />
        </div>
        <EmptyState message="Select variables to plot" />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="time-series-plot"
      data-run-id={effectiveRunId}
      data-overlay-count={overlayRuns.length}
      data-scrub-t={scrubT === null ? '' : String(scrubT)}
      className={cn('flex h-full w-full flex-col gap-2', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {isMultiRun ? (
          <div
            data-testid="time-series-plot-legend"
            className="flex flex-wrap items-center gap-1"
          >
            {overlayRuns.map((r) => (
              <RunLegendChip key={r.runId} runId={r.runId} pinned />
            ))}
          </div>
        ) : (
          <span />
        )}
        <ExportMenu
          formats={['csv', 'png']}
          panel="time-series"
          caseName={caseName}
          runId={effectiveRunId}
          onExportCsv={onExportCsv}
          onExportPng={onExportPng}
        />
      </div>
      {charts.map(({ group, options, data }) => (
        <GroupChart
          key={group}
          group={group}
          options={options}
          data={data}
          run={primaryRun!}
          scrubT={scrubT}
        />
      ))}
    </div>
  );
}

/**
 * Derive a short case name from a workspace path. Strips directory
 * prefix + extension. `ieee14.raw` → `ieee14`.
 */
function deriveCaseName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
