import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAnalyzeStore } from '@/store/analyze';
import type { SeResult } from '@/api/types';

/**
 * SEResidualChart — state-estimation residual histogram for the
 * Analyze panel's SE sub-mode (Unit 13 of the v2.0 plan; click-to-
 * inspect detail panel added in Unit 18).
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
 * Detail panel (Unit 18):
 *
 * - Click any bar → an inline detail card appears under the chart,
 *   listing the measurements (residual indices + values) that fall
 *   into that bin and the bin's flag-reason ("≥3σ from estimate" for
 *   flagged bins, "Within tolerance" for non-flagged).
 * - The panel is local state; re-running SE clobbers ``result``
 *   identity, which a ``useEffect`` watches to clear any open
 *   selection so stale indices don't bleed across runs.
 *
 * Wire-shape limitation: the substrate's ``SeResult`` only ships the
 * scalar residual array + the flagged-index set — it does not yet
 * surface per-measurement metadata (type / bus_idx / sigma). The
 * detail panel works against what is available today; richer fields
 * will slot into the same UI when the wire shape grows.
 *
 * Test hooks:
 *
 * - ``data-testid="se-residual-chart"`` on the outer container.
 * - ``data-testid="se-residual-bar-{i}"`` on each non-flagged
 *   histogram bar.
 * - ``data-testid="se-residual-bar-flagged"`` (data attribute
 *   ``data-flagged="true"``) on bars containing flagged measurements.
 *   Each bar additionally carries ``data-bin-idx="{i}"`` so the click
 *   handler and tests can locate a specific flagged bin.
 * - ``data-testid="se-residual-empty"`` for the empty state.
 * - ``data-testid="se-residual-summary"`` for the converged/iter/J row.
 * - ``data-testid="se-residual-detail-panel"`` for the click-detail
 *   card; ``data-testid="se-residual-detail-close"`` for its close
 *   button.
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

/** One per-bin entry produced by ``buildHistogram``. */
export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
  flagged: boolean;
  /** Indices into the original ``residuals`` array that fell into this bin. */
  memberIndices: number[];
}

/**
 * Pure helper: bin the residuals into ``binCount`` equal-width bins
 * spanning ``[min(residuals), max(residuals)]``. Returns one bin entry
 * per bin with edges, count, the original residual indices that fell
 * into the bin, and whether ANY residual in the bin is in the flagged-
 * indices set. Exported for tests.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildHistogram(
  residuals: number[],
  flaggedIndices: number[],
  binCount: number,
): {
  bins: HistogramBin[];
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
  const bins: HistogramBin[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({
      lo: xMin + i * width,
      hi: xMin + (i + 1) * width,
      count: 0,
      flagged: false,
      memberIndices: [],
    });
  }
  for (let i = 0; i < residuals.length; i++) {
    const r = residuals[i]!;
    let binIdx = Math.floor((r - xMin) / width);
    // Right-edge inclusive on the last bin (so xMax falls into bin[-1]).
    if (binIdx >= binCount) binIdx = binCount - 1;
    if (binIdx < 0) binIdx = 0;
    bins[binIdx]!.count += 1;
    bins[binIdx]!.memberIndices.push(i);
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

/** Cap on how many member indices we list in the detail panel. */
const DETAIL_MEMBER_LIMIT = 12;

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

  /**
   * Locally-selected histogram bin index. ``null`` means "no
   * selection / detail panel hidden". Reset whenever the underlying
   * ``result`` identity changes (re-running SE produces a fresh
   * object), so stale bin indices don't survive across runs.
   */
  const [selectedBinIdx, setSelectedBinIdx] = useState<number | null>(null);
  useEffect(() => {
    setSelectedBinIdx(null);
  }, [result]);

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

  const selectedBin =
    selectedBinIdx !== null && selectedBinIdx >= 0 && selectedBinIdx < bins.length
      ? bins[selectedBinIdx]!
      : null;

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
            <span className="text-danger font-medium">
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
          const isSelected = selectedBinIdx === i;
          // Empty bins remain non-interactive — clicking nothing surfaces
          // nothing useful. The cursor stays default for those.
          const interactive = b.count > 0;
          return (
            <rect
              key={`bar-${i}`}
              data-testid={
                b.flagged ? 'se-residual-bar-flagged' : `se-residual-bar-${i}`
              }
              data-flagged={b.flagged ? 'true' : 'false'}
              data-bin-idx={i}
              data-selected={isSelected ? 'true' : 'false'}
              x={x}
              y={y}
              width={w}
              height={h}
              className={cn(
                'transition-[fill,stroke-width]',
                interactive ? 'cursor-pointer' : '',
                b.flagged
                  ? 'fill-danger/70 stroke-danger'
                  : 'fill-primary/40 stroke-primary',
                isSelected
                  ? b.flagged
                    ? 'fill-danger stroke-foreground'
                    : 'fill-primary stroke-foreground'
                  : '',
              )}
              strokeWidth={isSelected ? 2 : 0.5}
              onClick={
                interactive ? () => setSelectedBinIdx(i) : undefined
              }
            />
          );
        })}
      </svg>

      {selectedBin !== null ? (
        <SEResidualDetailPanel
          binIdx={selectedBinIdx!}
          bin={selectedBin}
          residuals={result.residuals}
          onClose={() => setSelectedBinIdx(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Inline detail card rendered beneath the chart when a histogram bin
 * is selected. Lists the bin's range, the contained measurement
 * indices + their residual values, and a flag-reason line.
 *
 * Wire-shape note: the substrate's ``SeResult`` does not yet surface
 * per-measurement type / bus_idx / sigma — the panel works with what
 * the result object actually carries. The flag-reason follows the
 * plan literal:
 *
 * - flagged bin → ``"≥3σ from estimate"`` (substrate flags any
 *   measurement whose ``|r_i| / sigma_i > 3``).
 * - non-flagged bin → ``"Within tolerance"``.
 */
function SEResidualDetailPanel({
  binIdx,
  bin,
  residuals,
  onClose,
}: {
  binIdx: number;
  bin: HistogramBin;
  residuals: number[];
  onClose: () => void;
}) {
  const flagReason = bin.flagged
    ? '≥3σ from estimate'
    : 'Within tolerance';

  // Min/max residual within the bin — surfaced as a quick "this
  // measurement is the worst offender" summary for flagged bins.
  let rMin = Infinity;
  let rMax = -Infinity;
  for (const idx of bin.memberIndices) {
    const r = residuals[idx];
    if (r === undefined) continue;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  const haveExtrema = bin.memberIndices.length > 0;

  const visibleMembers = bin.memberIndices.slice(0, DETAIL_MEMBER_LIMIT);
  const hiddenCount = bin.memberIndices.length - visibleMembers.length;

  return (
    <div
      data-testid="se-residual-detail-panel"
      className={cn(
        'border-border bg-muted/30 border-t px-3 py-2.5 text-xs',
        'shadow-[inset_0_1px_0_0_oklch(1_0_0/0.04)]',
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span
            aria-hidden
            className={cn(
              'mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-sm',
              bin.flagged ? 'bg-danger' : 'bg-primary',
            )}
          />
          <div>
            <div className="text-foreground font-medium">
              Bin #{binIdx}{' '}
              <span className="text-muted-foreground font-normal">
                · residuals in [{bin.lo.toExponential(2)},{' '}
                {bin.hi.toExponential(2)}]
              </span>
            </div>
            <div
              className={cn(
                'mt-0.5 text-[10px] font-medium uppercase tracking-wider',
                bin.flagged ? 'text-danger' : 'text-muted-foreground',
              )}
            >
              {flagReason}
            </div>
          </div>
        </div>
        <button
          type="button"
          data-testid="se-residual-detail-close"
          onClick={onClose}
          aria-label="Close measurement detail panel"
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-muted',
            'flex h-6 w-6 items-center justify-center rounded',
            'text-base leading-none transition-colors',
          )}
        >
          ×
        </button>
      </div>

      <dl className="text-muted-foreground grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt>Measurements in bin</dt>
        <dd className="text-foreground">{bin.count}</dd>
        {haveExtrema ? (
          <>
            <dt>Min residual</dt>
            <dd className="text-foreground">{rMin.toExponential(3)}</dd>
            <dt>Max residual</dt>
            <dd className="text-foreground">{rMax.toExponential(3)}</dd>
          </>
        ) : null}
        <dt>Flag reason</dt>
        <dd className={bin.flagged ? 'text-danger' : 'text-foreground'}>
          {flagReason}
        </dd>
      </dl>

      {visibleMembers.length > 0 ? (
        <div className="mt-2">
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            Measurement indices
          </div>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] sm:grid-cols-3">
            {visibleMembers.map((idx) => {
              const r = residuals[idx];
              return (
                <li
                  key={idx}
                  data-testid={`se-residual-detail-member-${idx}`}
                  className="font-mono"
                >
                  <span className="text-muted-foreground">#{idx}</span>{' '}
                  <span className="text-foreground">
                    {r !== undefined ? r.toExponential(2) : '—'}
                  </span>
                </li>
              );
            })}
          </ul>
          {hiddenCount > 0 ? (
            <div className="text-muted-foreground mt-1 text-[10px]">
              + {hiddenCount} more
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
