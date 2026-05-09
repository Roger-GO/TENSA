import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { useAnalyzeStore } from '@/store/analyze';
import type { SeResult } from '@/api/types';

/**
 * SEResidualChart — state-estimation residual histogram for the
 * Analyze panel's SE sub-mode (Unit 13 of the v2.0 plan).
 *
 * Rendering choice: SVG, mirroring ``EIGScatter`` (Unit 6) and
 * ``CPFCurveChart`` (Unit 12) for visual consistency. The histogram
 * is a small fixed-bin chart (default 20 bins); flagged bars (whose
 * underlying measurements are in ``flagged_indices``) are drawn in a
 * destructive accent so 3-sigma outliers stand out.
 *
 * Wire-shape (per :class:`andes_app.core.se_result.SeResult`):
 *
 * - ``residuals`` — per-measurement residuals ``z - h(x_est)``.
 * - ``flagged_indices`` — indices into ``residuals`` whose normalised
 *   residual exceeds 3-sigma. Bars containing any flagged measurement
 *   are highlighted.
 * - ``measurement_count`` / ``iterations`` / ``mismatch`` — surfaced
 *   in the chart header strip so the user sees the SE run summary
 *   without the summary having to be repeated by the parent panel.
 *
 * Empty state:
 *
 * - ``result === null`` → "Run SE to see the residual histogram."
 * - ``residuals.length === 0`` → "SE returned no residuals." (rare)
 *
 * Test hooks:
 *
 * - ``data-testid="se-residual-chart"`` on the outer container.
 * - ``data-testid="se-residual-bar-{i}"`` on each histogram bar.
 * - ``data-testid="se-residual-bar-flagged"`` (data attribute
 *   ``data-flagged="true"``) on bars containing flagged measurements.
 * - ``data-testid="se-residual-empty"`` for the empty state.
 * - ``data-testid="se-residual-summary"`` for the converged/iter/J row.
 */
export interface SEResidualChartProps {
  /** Override for tests; usually pulled from the analyze store. */
  result?: SeResult | null;
  className?: string;
  /** Number of histogram bins; default 20. */
  binCount?: number;
}

const SVG_WIDTH = 480;
const SVG_HEIGHT = 220;
const PADDING_LEFT = 36;
const PADDING_RIGHT = 12;
const PADDING_TOP = 12;
const PADDING_BOTTOM = 28;
const DEFAULT_BIN_COUNT = 20;

/**
 * Pure helper: bin the residuals into ``binCount`` equal-width bins
 * spanning ``[min(residuals), max(residuals)]``. Returns one bin entry
 * per bin with edges, count, and whether ANY residual in the bin is in
 * the flagged-indices set. Exported for tests.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildHistogram(
  residuals: number[],
  flaggedIndices: number[],
  binCount: number,
): {
  bins: { lo: number; hi: number; count: number; flagged: boolean }[];
  xMin: number;
  xMax: number;
  maxCount: number;
} {
  if (residuals.length === 0 || binCount <= 0) {
    return { bins: [], xMin: 0, xMax: 1, maxCount: 0 };
  }
  let xMin = residuals[0]!;
  let xMax = residuals[0]!;
  for (const r of residuals) {
    if (r < xMin) xMin = r;
    if (r > xMax) xMax = r;
  }
  if (xMin === xMax) {
    // Degenerate single-value range — pad symmetrically so we still
    // render a single bar.
    xMin -= 0.5;
    xMax += 0.5;
  }
  const flaggedSet = new Set(flaggedIndices);
  const width = (xMax - xMin) / binCount;
  const bins: { lo: number; hi: number; count: number; flagged: boolean }[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({
      lo: xMin + i * width,
      hi: xMin + (i + 1) * width,
      count: 0,
      flagged: false,
    });
  }
  for (let i = 0; i < residuals.length; i++) {
    const r = residuals[i]!;
    let binIdx = Math.floor((r - xMin) / width);
    // Right-edge inclusive on the last bin (so xMax falls into bin[-1]).
    if (binIdx >= binCount) binIdx = binCount - 1;
    if (binIdx < 0) binIdx = 0;
    bins[binIdx]!.count += 1;
    if (flaggedSet.has(i)) {
      bins[binIdx]!.flagged = true;
    }
  }
  let maxCount = 0;
  for (const b of bins) {
    if (b.count > maxCount) maxCount = b.count;
  }
  return { bins, xMin, xMax, maxCount };
}

export function SEResidualChart({
  result: resultProp,
  className,
  binCount = DEFAULT_BIN_COUNT,
}: SEResidualChartProps) {
  const storeResult = useAnalyzeStore((s) => s.seResult);
  const result = resultProp !== undefined ? resultProp : storeResult;

  const histogram = useMemo(() => {
    if (result === null) {
      return { bins: [], xMin: 0, xMax: 1, maxCount: 0 };
    }
    return buildHistogram(result.residuals, result.flagged_indices, binCount);
  }, [result, binCount]);

  if (result === null) {
    return (
      <div
        data-testid="se-residual-empty"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[200px] items-center justify-center rounded border p-4 text-xs',
          className,
        )}
      >
        Run SE to see the residual histogram.
      </div>
    );
  }

  if (result.residuals.length === 0) {
    return (
      <div
        data-testid="se-residual-empty"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[200px] items-center justify-center rounded border p-4 text-xs',
          className,
        )}
      >
        SE returned no residuals.
      </div>
    );
  }

  const plotW = SVG_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotH = SVG_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const { bins, xMin, xMax, maxCount } = histogram;
  const xRange = xMax - xMin;
  // Each bar gets ``plotW / binCount`` width with a 1-px gap on each side.
  const barWidth = bins.length > 0 ? plotW / bins.length : plotW;

  const xToPx = (x: number) =>
    PADDING_LEFT + ((x - xMin) / xRange) * plotW;
  const countToPx = (c: number) =>
    PADDING_TOP + plotH - (maxCount > 0 ? (c / maxCount) * plotH : 0);

  return (
    <div
      data-testid="se-residual-chart"
      className={cn(
        'border-border bg-background flex flex-col rounded border',
        className,
      )}
    >
      <div
        data-testid="se-residual-summary"
        className="border-border text-muted-foreground border-b px-2 py-1 text-[10px]"
      >
        SE residual histogram —{' '}
        <span className="text-foreground font-medium">
          {result.measurement_count}
        </span>{' '}
        measurements,{' '}
        <span className="text-foreground font-medium">
          {result.iterations}
        </span>{' '}
        iterations, J ={' '}
        <span className="text-foreground font-medium">
          {result.mismatch.toExponential(3)}
        </span>
        {result.flagged_indices.length > 0 ? (
          <>
            {' '}—{' '}
            <span className="text-destructive font-medium">
              {result.flagged_indices.length} flagged
            </span>{' '}
            (|r| / sigma {'>'} 3)
          </>
        ) : null}
      </div>

      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="h-full w-full"
        role="img"
        aria-label="SE residual histogram"
      >
        {/* axes */}
        <line
          x1={PADDING_LEFT}
          y1={PADDING_TOP + plotH}
          x2={PADDING_LEFT + plotW}
          y2={PADDING_TOP + plotH}
          className="stroke-border"
          strokeWidth={1}
        />
        <line
          x1={PADDING_LEFT}
          y1={PADDING_TOP}
          x2={PADDING_LEFT}
          y2={PADDING_TOP + plotH}
          className="stroke-border"
          strokeWidth={1}
        />
        {/* axis labels */}
        <text
          x={PADDING_LEFT + plotW / 2}
          y={SVG_HEIGHT - 6}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          Residual (z - h(x))
        </text>
        <text
          x={10}
          y={PADDING_TOP + plotH / 2}
          transform={`rotate(-90 10 ${PADDING_TOP + plotH / 2})`}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          Count
        </text>
        {/* y-axis tick labels (0, mid, max) */}
        {[0, Math.ceil(maxCount / 2), maxCount].map((c, i) => (
          <text
            key={`yt-${i}`}
            x={PADDING_LEFT - 4}
            y={countToPx(c) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[8px]"
          >
            {c}
          </text>
        ))}
        {/* x-axis tick labels (min, mid, max) */}
        {[xMin, (xMin + xMax) / 2, xMax].map((xVal, i) => (
          <text
            key={`xt-${i}`}
            x={xToPx(xVal)}
            y={PADDING_TOP + plotH + 12}
            textAnchor="middle"
            className="fill-muted-foreground text-[8px]"
          >
            {xVal.toExponential(2)}
          </text>
        ))}

        {/* histogram bars */}
        {bins.map((b, i) => {
          const x = xToPx(b.lo) + 0.5;
          const y = countToPx(b.count);
          const w = Math.max(0, barWidth - 1);
          const h = PADDING_TOP + plotH - y;
          return (
            <rect
              key={`bar-${i}`}
              data-testid={
                b.flagged ? 'se-residual-bar-flagged' : `se-residual-bar-${i}`
              }
              data-flagged={b.flagged ? 'true' : 'false'}
              x={x}
              y={y}
              width={w}
              height={h}
              className={cn(
                b.flagged
                  ? 'fill-destructive/70 stroke-destructive'
                  : 'fill-primary/40 stroke-primary',
              )}
              strokeWidth={0.5}
            />
          );
        })}
      </svg>
    </div>
  );
}
