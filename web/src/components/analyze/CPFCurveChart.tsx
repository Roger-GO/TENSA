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
 * Lambda slider (Unit 17):
 *
 * - A native ``<input type="range">`` below the chart drives a
 *   selectable lambda value. The slider ranges from the smallest to
 *   the largest computed lambda (i.e. ``max_lam`` for happy paths,
 *   the last reached lambda for truncated runs). A vertical line on
 *   the chart tracks the slider; a small readout below the slider
 *   lists each visible bus's interpolated voltage at that lambda,
 *   sorted V-ascending so the most-stressed bus rises to the top.
 *
 * Per-bus hover (Unit 17):
 *
 * - Pointer-enter on a polyline thickens its stroke to 3px and
 *   highlights the matching legend chip; pointer-leave restores
 *   default 1.5px / muted state. Hover state is local; the analyze
 *   store is not touched because only one CPF chart renders at once.
 *
 * Test hooks:
 *
 * - ``data-testid="cpf-curve"`` on the outer container.
 * - ``data-testid="cpf-curve-line-{busIdx}"`` on each polyline.
 * - ``data-testid="cpf-nose-marker"`` when the nose marker is rendered.
 * - ``data-testid="cpf-nose-label"`` when the nose text label is rendered.
 * - ``data-testid="cpf-truncated-banner"`` when truncated.
 * - ``data-testid="cpf-truncated-label"`` truncated annotation on chart.
 * - ``data-testid="cpf-empty"`` for the empty state.
 * - ``data-testid="cpf-lambda-slider"`` slider input.
 * - ``data-testid="cpf-lambda-readout"`` per-bus voltage readout.
 * - ``data-testid="cpf-lambda-marker"`` vertical line driven by slider.
 * - ``data-testid="cpf-lambda-readout-row-{busIdx}"`` rows in readout.
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
const STROKE_DEFAULT = 1.5;
const STROKE_HOVERED = 3;

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
export function pickDefaultVisibleBuses(result: CpfResult, maxBuses: number): string[] {
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

/**
 * Pure helper: linearly interpolate the voltage of ``bus`` at lambda
 * ``lam`` from the CPF trace.
 *
 * The CPF trace can have a non-monotonic lambda axis: post-nose, the
 * curve folds back, so a single ``lam`` value may correspond to two
 * voltage points (one upper-branch, one lower-branch). To keep the
 * readout deterministic we walk the trace in *trajectory order* and
 * pick the rightmost segment whose lambda interval contains ``lam``;
 * that biases towards the post-nose / collapse branch when both exist,
 * which is the more useful answer for a stability researcher.
 *
 * Returns ``null`` when the trace is empty or lam is outside the union
 * of segment ranges.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function interpolateBusVoltage(result: CpfResult, bus: string, lam: number): number | null {
  const trace = result.voltages_per_bus[bus];
  const lambdas = result.lambdas;
  if (!trace || trace.length === 0 || lambdas.length === 0) return null;
  if (trace.length === 1) {
    const only = trace[0];
    return only === undefined ? null : only;
  }
  let pick: number | null = null;
  for (let i = 0; i < trace.length - 1; i++) {
    const lamA = lambdas[i];
    const lamB = lambdas[i + 1];
    const vA = trace[i];
    const vB = trace[i + 1];
    if (lamA === undefined || lamB === undefined || vA === undefined || vB === undefined) {
      continue;
    }
    const lo = Math.min(lamA, lamB);
    const hi = Math.max(lamA, lamB);
    if (lam < lo || lam > hi) continue;
    if (lamA === lamB) {
      // Vertical segment — pick the later (rightmost in trajectory order) voltage.
      pick = vB;
      continue;
    }
    const t = (lam - lamA) / (lamB - lamA);
    pick = vA + t * (vB - vA);
  }
  if (pick !== null) return pick;
  // Fallback: clamp to nearest endpoint by lambda.
  let nearestIdx = 0;
  let nearestDist = Infinity;
  for (let i = 0; i < lambdas.length; i++) {
    const lamI = lambdas[i];
    if (lamI === undefined) continue;
    const dist = Math.abs(lamI - lam);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIdx = i;
    }
  }
  const fallback = trace[nearestIdx];
  return fallback === undefined ? null : fallback;
}

/**
 * Pure helper: compute the slider's lambda range. Uses ``max_lam``
 * for the upper bound on happy paths so the slider stops at the nose;
 * for truncated runs ``max_lam`` is still the last computed lambda,
 * so the same expression works.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeLambdaRange(result: CpfResult): { min: number; max: number } {
  const lambdas = result.lambdas;
  if (lambdas.length === 0) return { min: 0, max: 0 };
  const min = Math.min(...lambdas);
  // ``max_lam`` is documented as the peak lambda reached and matches
  // the rightmost point on the curve for both happy + truncated runs.
  const max = Math.max(result.max_lam, ...lambdas);
  return { min, max };
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
  const [hoveredBus, setHoveredBus] = useState<string | null>(null);

  const lambdaRange = useMemo(
    () => (result === null ? { min: 0, max: 0 } : computeLambdaRange(result)),
    [result],
  );
  // Default the slider to the nose lambda when present, otherwise to
  // the last computed lambda. We derive the *displayed* value from a
  // user-touched override (``sliderLambdaOverride``); when null we fall
  // back to the nose-or-max default. This avoids a setState-after-mount
  // (which would warn about act() in tests) when a result first lands.
  const defaultSliderLambda =
    result === null
      ? null
      : result.nose_idx >= 0 && result.nose_idx < result.lambdas.length
        ? (result.lambdas[result.nose_idx] ?? lambdaRange.max)
        : lambdaRange.max;
  const [sliderLambdaOverride, setSliderLambdaOverride] = useState<number | null>(null);
  // ``sliderLambda`` is the value rendered + sampled. ``null`` only
  // when there's no result; once a result is loaded it always resolves
  // to a number.
  const sliderLambda: number | null = sliderLambdaOverride ?? defaultSliderLambda;

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
        CPF returned no continuation steps. {result.done_msg ? `(${result.done_msg})` : null}
      </div>
    );
  }

  const xRange = viewport.xMax - viewport.xMin;
  const yRange = viewport.yMax - viewport.yMin;
  const plotW = SVG_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotH = SVG_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const xToPx = (x: number) => PADDING_LEFT + ((x - viewport.xMin) / xRange) * plotW;
  const yToPx = (y: number) => PADDING_TOP + ((viewport.yMax - y) / yRange) * plotH;

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
  const noseLambda: number | null = noseLambdaRaw === undefined ? null : noseLambdaRaw;

  // V_min at the nose: the smallest bus voltage at the nose index
  // across *all* buses (not just visible) because the annotation
  // describes the system-wide collapse margin, not the legend pick.
  let noseVMin: number | null = null;
  if (noseLambda !== null) {
    let lo = Infinity;
    for (const bus of result.bus_idxes) {
      const trace = result.voltages_per_bus[bus];
      if (!trace) continue;
      const v = trace[result.nose_idx];
      if (v === undefined) continue;
      if (v < lo) lo = v;
    }
    noseVMin = Number.isFinite(lo) ? lo : null;
  }

  const toggleBus = (bus: string) => {
    setVisibleBuses((cur) => {
      const base = cur ?? defaultVisible;
      if (base.includes(bus)) {
        return base.filter((b) => b !== bus);
      }
      return [...base, bus];
    });
  };

  // Slider-driven readout: per-visible-bus interpolated voltage at the
  // current slider lambda, sorted V-ascending so the most-stressed bus
  // sits at the top.
  const sliderClamped =
    sliderLambda === null
      ? lambdaRange.max
      : Math.min(Math.max(sliderLambda, lambdaRange.min), lambdaRange.max);

  const readout: { bus: string; v: number | null }[] = effectiveVisible
    .map((bus) => ({
      bus,
      v: interpolateBusVoltage(result, bus, sliderClamped),
    }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return 0;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return a.v - b.v;
    });

  // Slider step: aim for ~200 stops across the range so a drag feels
  // continuous without flooding the readout with no-op re-renders.
  const sliderSpan = Math.max(lambdaRange.max - lambdaRange.min, 1e-6);
  const sliderStep = sliderSpan / 200;

  return (
    <div
      data-testid="cpf-curve"
      data-mode={result.mode}
      className={cn('border-border bg-background flex flex-col rounded border', className)}
    >
      <div className="border-border text-muted-foreground border-b px-2 py-1 text-[10px]">
        CPF {result.mode === 'qv' ? 'QV-curve' : 'PV-curve / nose-curve'} — {result.lambdas.length}{' '}
        steps, max {result.mode === 'qv' ? 'Q' : 'lambda'} = {result.max_lam.toFixed(4)}
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
          {result.done_msg ? `Reason: ${result.done_msg}.` : null} The voltage- collapse margin
          could not be determined; widen ``max_iter`` or adjust ``step`` and re-run.
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
        {[viewport.yMin, (viewport.yMin + viewport.yMax) / 2, viewport.yMax].map((yVal) => (
          <text
            key={`yt-${yVal}`}
            x={PADDING_LEFT - 4}
            y={yToPx(yVal) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[8px]"
          >
            {yVal.toFixed(2)}
          </text>
        ))}
        {/* x-axis tick labels (min, mid, max) */}
        {[viewport.xMin, (viewport.xMin + viewport.xMax) / 2, viewport.xMax].map((xVal) => (
          <text
            key={`xt-${xVal}`}
            x={xToPx(xVal)}
            y={PADDING_TOP + plotH + 12}
            textAnchor="middle"
            className="fill-muted-foreground text-[8px]"
          >
            {xVal.toFixed(2)}
          </text>
        ))}

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
          const isHovered = hoveredBus === bus;
          return (
            <polyline
              key={bus}
              points={points}
              fill="none"
              stroke={busColor(bus, resolvedTheme)}
              strokeWidth={isHovered ? STROKE_HOVERED : STROKE_DEFAULT}
              data-testid={`cpf-curve-line-${bus}`}
              data-hovered={isHovered ? 'true' : 'false'}
              onPointerEnter={() => setHoveredBus(bus)}
              onPointerLeave={() => setHoveredBus((cur) => (cur === bus ? null : cur))}
              style={{ cursor: 'pointer' }}
            />
          );
        })}

        {/* slider-driven vertical marker */}
        {sliderLambda !== null ? (
          <line
            data-testid="cpf-lambda-marker"
            x1={xToPx(sliderClamped)}
            y1={PADDING_TOP}
            x2={xToPx(sliderClamped)}
            y2={PADDING_TOP + plotH}
            stroke="currentColor"
            strokeOpacity={0.45}
            strokeWidth={1}
            className="text-foreground"
          />
        ) : null}

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
            {/* Detailed annotation rendered with a translucent background
                pill so the text stays legible even when polylines pass
                directly behind it. The right-edge anchor flips when the
                nose sits in the rightmost 30% of the plot. */}
            {(() => {
              const px = xToPx(noseLambda);
              const onRight = px > PADDING_LEFT + plotW * 0.7;
              const labelX = onRight ? px - 6 : px + 6;
              const anchor: 'start' | 'end' = onRight ? 'end' : 'start';
              const label = `Nose: λ=${noseLambda.toFixed(2)}${
                noseVMin !== null ? `, V_min=${noseVMin.toFixed(2)}` : ''
              }`;
              // Approximate width: 5px per char at 9px font.
              const labelW = label.length * 5 + 8;
              const rectX = onRight ? labelX - labelW : labelX - 4;
              return (
                <>
                  <rect
                    aria-hidden="true"
                    x={rectX}
                    y={PADDING_TOP + 11}
                    width={labelW}
                    height={14}
                    rx={3}
                    className="fill-background stroke-border opacity-85"
                    strokeWidth={0.5}
                  />
                  <text
                    data-testid="cpf-nose-label"
                    x={labelX}
                    y={PADDING_TOP + 21}
                    textAnchor={anchor}
                    className="fill-foreground text-[9px] font-medium"
                  >
                    {label}
                  </text>
                </>
              );
            })()}
          </g>
        ) : null}

        {/* truncated annotation on chart */}
        {result.truncated ? (
          <text
            data-testid="cpf-truncated-label"
            x={PADDING_LEFT + 6}
            y={PADDING_TOP + 12}
            className="fill-foreground text-[9px]"
          >
            {`Truncated at λ_max=${result.max_lam.toFixed(2)} (no nose found)`}
          </text>
        ) : null}
      </svg>

      {/* lambda slider + readout (Unit 17) */}
      {sliderLambda !== null ? (
        <div className="border-border flex flex-col gap-1 border-t px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-10 shrink-0 text-[10px]">
              {result.mode === 'qv' ? 'Q' : 'λ'}
            </span>
            <input
              type="range"
              data-testid="cpf-lambda-slider"
              aria-label="Sample lambda value"
              min={lambdaRange.min}
              max={lambdaRange.max}
              step={sliderStep}
              value={sliderClamped}
              onChange={(e) => setSliderLambdaOverride(Number(e.target.value))}
              className={cn(
                'slider-thumb-lg h-1.5 grow appearance-none rounded-full',
                'bg-muted accent-[var(--color-primary)]',
                'focus-visible:outline-none',
              )}
            />
            <span
              data-testid="cpf-lambda-value"
              className={cn(
                'text-foreground bg-muted/60 border-border shrink-0 rounded-md border',
                'px-1.5 py-0.5 text-right font-mono text-[10px] tabular-nums',
                'min-w-[64px]',
              )}
            >
              {sliderClamped.toFixed(3)}
            </span>
          </div>
          <ul
            data-testid="cpf-lambda-readout"
            className={cn(
              'border-border/50 bg-muted/20 max-h-24 overflow-y-auto',
              'rounded border px-1.5 py-1 text-[10px] leading-tight',
              'flex flex-col gap-0.5',
            )}
          >
            {readout.length === 0 ? (
              <li className="text-muted-foreground">No visible buses.</li>
            ) : (
              readout.map(({ bus, v }) => (
                <li
                  key={bus}
                  data-testid={`cpf-lambda-readout-row-${bus}`}
                  data-hovered={hoveredBus === bus ? 'true' : 'false'}
                  onPointerEnter={() => setHoveredBus(bus)}
                  onPointerLeave={() => setHoveredBus((cur) => (cur === bus ? null : cur))}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded px-1 py-0.5',
                    hoveredBus === bus ? 'bg-muted/60 text-foreground' : 'text-foreground/80',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: busColor(bus, resolvedTheme) }}
                    />
                    <span className="font-mono">{bus}</span>
                  </span>
                  <span className="text-foreground font-mono tabular-nums">
                    {v === null ? '—' : `${v.toFixed(3)} pu`}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <div
        data-testid="cpf-curve-legend"
        className="border-border flex flex-wrap gap-1 border-t px-2 py-1 text-[10px]"
      >
        {result.bus_idxes.map((bus) => {
          const isVisible = effectiveVisible.includes(bus);
          const isHovered = hoveredBus === bus;
          return (
            <button
              key={bus}
              type="button"
              data-testid={`cpf-curve-legend-${bus}`}
              data-active={isVisible ? 'true' : 'false'}
              data-hovered={isHovered ? 'true' : 'false'}
              onClick={() => toggleBus(bus)}
              onPointerEnter={() => setHoveredBus(bus)}
              onPointerLeave={() => setHoveredBus((cur) => (cur === bus ? null : cur))}
              className={cn(
                'rounded border px-1.5 py-0.5 transition-colors',
                isVisible
                  ? 'border-border bg-muted/40 text-foreground'
                  : 'border-border/40 text-muted-foreground hover:text-foreground',
                isHovered ? 'ring-1 ring-[var(--color-ring)]' : null,
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
