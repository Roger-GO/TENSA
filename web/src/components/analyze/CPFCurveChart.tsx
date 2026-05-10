import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAnalyzeStore } from '@/store/analyze';
import { useTheme } from '@/lib/useTheme';
import type { CpfResult } from '@/api/types';
import type { ResolvedTheme } from '@/store/theme';

/**
 * CPFCurveChart — continuation power flow nose-curve / QV-curve render
 * for the Analyze panel's CPF sub-mode (Unit 12 of the v2.0 plan).
 *
 * Rendering choice: SVG, mirroring ``EIGScatter`` (Unit 6) for
 * consistency. uPlot is the default chart kit elsewhere but the per-
 * line click selection model + the nose-point marker are easier to
 * reason about as raw SVG. For the largest expected case (NPCC 140 =
 * 140 lines per chart × ~30 lambda steps = 4200 elements), the SVG
 * stays well within browser-render budget; the default behaviour caps
 * the visible-set at 8 buses (top-overlap + user-selected) so the
 * legend doesn't scroll.
 *
 * Wire-shape (per :class:`andes_app.core.cpf_result.CpfResult`):
 *
 * - X-axis = ``lambdas`` (continuation parameter values).
 * - Y-axis = bus voltage (each bus contributes one polyline).
 * - When ``mode === 'qv'`` the X-axis is reactive injection (Q),
 *   not lambda, but the wire field is reused; the chart relabels.
 * - The nose point (``nose_idx``) is marked with a vertical dashed
 *   line + small triangle annotation. ``nose_idx === -1`` (truncated)
 *   skips the marker and shows the truncation banner above the chart.
 *
 * Empty state:
 *
 * - ``result === null`` → "Run CPF to see the nose curve."
 * - ``lambdas.length === 0`` → "CPF returned no continuation steps."
 *
 * Linked selection (Unit 12 plan):
 *
 * - The legend buttons toggle which buses are visible. Clicking a
 *   polyline focuses the same bus. The component owns the visible-set
 *   state locally; it is not reflected into the analyze store because
 *   only one consumer renders at a time.
 *
 * Test hooks:
 *
 * - ``data-testid="cpf-curve"`` on the outer container.
 * - ``data-testid="cpf-curve-line-{busIdx}"`` on each polyline.
 * - ``data-testid="cpf-nose-marker"`` when the nose marker is rendered.
 * - ``data-testid="cpf-truncated-banner"`` when truncated.
 * - ``data-testid="cpf-empty"`` for the empty state.
 */
export interface CPFCurveChartProps {
  /** Override for tests; usually pulled from the analyze store. */
  result?: CpfResult | null;
  className?: string;
  /** Maximum number of polylines drawn at once; the rest go behind a "show more" toggle. */
  maxVisibleBuses?: number;
}

const SVG_WIDTH = 480;
const SVG_HEIGHT = 280;
const PADDING_LEFT = 44;
const PADDING_RIGHT = 16;
const PADDING_TOP = 12;
const PADDING_BOTTOM = 32;
const DEFAULT_MAX_BUSES = 8;

/** Pure helper: compute the Y-range across all visible buses, with a 5% pad. */
// eslint-disable-next-line react-refresh/only-export-components
export function computeViewport(
  result: CpfResult,
  visibleBuses: string[],
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const lambdas = result.lambdas;
  const xMin = lambdas.length > 0 ? Math.min(...lambdas) : 0;
  const xMax = lambdas.length > 0 ? Math.max(...lambdas) : 1;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const bus of visibleBuses) {
    const trace = result.voltages_per_bus[bus];
    if (!trace) continue;
    for (const v of trace) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    yMin = 0;
    yMax = 1;
  }
  if (yMin === yMax) {
    // Degenerate single-value range — pad symmetrically so the line is visible.
    yMin -= 0.05;
    yMax += 0.05;
  } else {
    const pad = (yMax - yMin) * 0.05;
    yMin -= pad;
    yMax += pad;
  }
  return {
    xMin,
    xMax: xMax === xMin ? xMin + 1 : xMax,
    yMin,
    yMax,
  };
}

/**
 * Pure helper: pick the default visible buses. For PV runs we surface
 * the buses with the largest voltage *swing* (max - min across the
 * trace) since those are the ones approaching collapse — those are
 * what the user wants to see first.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function pickDefaultVisibleBuses(
  result: CpfResult,
  maxBuses: number,
): string[] {
  if (result.bus_idxes.length <= maxBuses) {
    return [...result.bus_idxes];
  }
  const swings: { bus: string; swing: number }[] = [];
  for (const bus of result.bus_idxes) {
    const trace = result.voltages_per_bus[bus];
    if (!trace || trace.length === 0) continue;
    const lo = Math.min(...trace);
    const hi = Math.max(...trace);
    swings.push({ bus, swing: hi - lo });
  }
  swings.sort((a, b) => b.swing - a.swing);
  return swings.slice(0, maxBuses).map((s) => s.bus);
}

/**
 * Stable-ish color picker — hashes bus idx → HSL hue. Avoids relying
 * on a fixed palette so even 100+ buses get distinguishable lines.
 *
 * Theme-aware lightness (Unit 12): on a dark background a 45%-L line
 * disappears against the page; we bump to 65% in dark mode so the
 * traces stay legible. Saturation stays at 65% across themes.
 *
 * Exported for tests so the dark / light L difference is assertable
 * without rendering the full SVG.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function busColor(bus: string, theme: ResolvedTheme = 'light'): string {
  let h = 0;
  for (let i = 0; i < bus.length; i++) {
    h = (h * 31 + bus.charCodeAt(i)) >>> 0;
  }
  const lightness = theme === 'dark' ? 65 : 45;
  return `hsl(${h % 360}deg, 65%, ${lightness}%)`;
}

export function CPFCurveChart({
  result: resultProp,
  className,
  maxVisibleBuses = DEFAULT_MAX_BUSES,
}: CPFCurveChartProps) {
  const storeResult = useAnalyzeStore((s) => s.cpfResult);
  const result = resultProp !== undefined ? resultProp : storeResult;
  const { resolvedTheme } = useTheme();

  const defaultVisible = useMemo(
    () => (result === null ? [] : pickDefaultVisibleBuses(result, maxVisibleBuses)),
    [result, maxVisibleBuses],
  );
  const [visibleBuses, setVisibleBuses] = useState<string[] | null>(null);
  const effectiveVisible = visibleBuses ?? defaultVisible;

  const viewport = useMemo(
    () =>
      result === null
        ? { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }
        : computeViewport(result, effectiveVisible),
    [result, effectiveVisible],
  );

  if (result === null) {
    return (
      <div
        data-testid="cpf-empty"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[200px] items-center justify-center rounded border p-4 text-xs',
          className,
        )}
      >
        Run CPF to see the nose curve.
      </div>
    );
  }

  if (result.lambdas.length === 0) {
    return (
      <div
        data-testid="cpf-empty"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[200px] items-center justify-center rounded border p-4 text-xs',
          className,
        )}
      >
        CPF returned no continuation steps.{' '}
        {result.done_msg ? `(${result.done_msg})` : null}
      </div>
    );
  }

  const xRange = viewport.xMax - viewport.xMin;
  const yRange = viewport.yMax - viewport.yMin;
  const plotW = SVG_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotH = SVG_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const xToPx = (x: number) =>
    PADDING_LEFT + ((x - viewport.xMin) / xRange) * plotW;
  const yToPx = (y: number) =>
    PADDING_TOP + ((viewport.yMax - y) / yRange) * plotH;

  const xAxisLabel = result.mode === 'qv' ? 'Q injection (pu)' : 'lambda (load scale)';
  const yAxisLabel = 'Bus voltage (pu)';

  // Narrow ``noseLambda`` to ``number`` (rather than ``number |
  // undefined``) so the SVG marker block doesn't fight TS's
  // ``noUncheckedIndexedAccess``. ``nose_idx === -1`` (or out-of-range
  // for any reason) collapses to null and the marker is skipped.
  const noseLambdaRaw =
    result.nose_idx >= 0 && result.nose_idx < result.lambdas.length
      ? result.lambdas[result.nose_idx]
      : undefined;
  const noseLambda: number | null =
    noseLambdaRaw === undefined ? null : noseLambdaRaw;

  const toggleBus = (bus: string) => {
    setVisibleBuses((cur) => {
      const base = cur ?? defaultVisible;
      if (base.includes(bus)) {
        return base.filter((b) => b !== bus);
      }
      return [...base, bus];
    });
  };

  return (
    <div
      data-testid="cpf-curve"
      data-mode={result.mode}
      className={cn(
        'border-border bg-background flex flex-col rounded border',
        className,
      )}
    >
      <div className="border-border text-muted-foreground border-b px-2 py-1 text-[10px]">
        CPF {result.mode === 'qv' ? 'QV-curve' : 'PV-curve / nose-curve'} —{' '}
        {result.lambdas.length} steps, max {result.mode === 'qv' ? 'Q' : 'lambda'}
        {' '}={' '}
        {result.max_lam.toFixed(4)}
        {!result.truncated ? null : (
          <>
            {' '}
            <span className="text-warning-foreground">(truncated)</span>
          </>
        )}
      </div>

      {result.truncated ? (
        <div
          data-testid="cpf-truncated-banner"
          role="status"
          className={cn(
            'border-warning/40 bg-warning/10 text-foreground',
            'border-b px-2 py-1 text-[10px] leading-snug',
          )}
        >
          CPF terminated before reaching a nose point.{' '}
          {result.done_msg ? `Reason: ${result.done_msg}.` : null} The voltage-
          collapse margin could not be determined; widen ``max_iter`` or
          adjust ``step`` and re-run.
        </div>
      ) : null}

      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="h-full w-full"
        role="img"
        aria-label={`CPF ${result.mode}-curve`}
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
          y={SVG_HEIGHT - 8}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          {xAxisLabel}
        </text>
        <text
          x={10}
          y={PADDING_TOP + plotH / 2}
          transform={`rotate(-90 10 ${PADDING_TOP + plotH / 2})`}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          {yAxisLabel}
        </text>
        {/* y-axis tick labels (min, mid, max) */}
        {[viewport.yMin, (viewport.yMin + viewport.yMax) / 2, viewport.yMax].map(
          (yVal) => (
            <text
              key={`yt-${yVal}`}
              x={PADDING_LEFT - 4}
              y={yToPx(yVal) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[8px]"
            >
              {yVal.toFixed(2)}
            </text>
          ),
        )}
        {/* x-axis tick labels (min, mid, max) */}
        {[viewport.xMin, (viewport.xMin + viewport.xMax) / 2, viewport.xMax].map(
          (xVal) => (
            <text
              key={`xt-${xVal}`}
              x={xToPx(xVal)}
              y={PADDING_TOP + plotH + 12}
              textAnchor="middle"
              className="fill-muted-foreground text-[8px]"
            >
              {xVal.toFixed(2)}
            </text>
          ),
        )}

        {/* per-bus polylines */}
        {effectiveVisible.map((bus) => {
          const trace = result.voltages_per_bus[bus];
          if (!trace) return null;
          const points = trace
            .map((v, i) => {
              const lam = result.lambdas[i];
              if (lam === undefined) return null;
              return `${xToPx(lam)},${yToPx(v)}`;
            })
            .filter((p): p is string => p !== null)
            .join(' ');
          return (
            <polyline
              key={bus}
              points={points}
              fill="none"
              stroke={busColor(bus, resolvedTheme)}
              strokeWidth={1.5}
              data-testid={`cpf-curve-line-${bus}`}
            />
          );
        })}

        {/* nose marker */}
        {noseLambda !== null ? (
          <g data-testid="cpf-nose-marker">
            <line
              x1={xToPx(noseLambda)}
              y1={PADDING_TOP}
              x2={xToPx(noseLambda)}
              y2={PADDING_TOP + plotH}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="3,3"
              className="text-muted-foreground"
            />
            <polygon
              points={`${xToPx(noseLambda) - 4},${PADDING_TOP} ${xToPx(noseLambda) + 4},${PADDING_TOP} ${xToPx(noseLambda)},${PADDING_TOP + 6}`}
              className="fill-foreground"
            />
            <text
              x={xToPx(noseLambda) + 6}
              y={PADDING_TOP + 8}
              className="fill-foreground text-[8px]"
            >
              nose @ {noseLambda.toFixed(3)}
            </text>
          </g>
        ) : null}
      </svg>

      <div
        data-testid="cpf-curve-legend"
        className="border-border flex flex-wrap gap-1 border-t px-2 py-1 text-[10px]"
      >
        {result.bus_idxes.map((bus) => {
          const isVisible = effectiveVisible.includes(bus);
          return (
            <button
              key={bus}
              type="button"
              data-testid={`cpf-curve-legend-${bus}`}
              data-active={isVisible ? 'true' : 'false'}
              onClick={() => toggleBus(bus)}
              className={cn(
                'rounded border px-1.5 py-0.5 transition-colors',
                isVisible
                  ? 'border-border bg-muted/40 text-foreground'
                  : 'border-border/40 text-muted-foreground hover:text-foreground',
              )}
              title={isVisible ? 'Click to hide bus' : 'Click to show bus'}
            >
              <span
                aria-hidden
                className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                style={{ backgroundColor: busColor(bus, resolvedTheme) }}
              />
              {bus}
            </button>
          );
        })}
      </div>
    </div>
  );
}
