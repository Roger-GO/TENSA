import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { applyEigFilter, useAnalyzeStore } from '@/store/analyze';
import { subscribeEigViewReset, subscribeEigLogToggle } from '@/lib/eigViewBus';
import type { EigResult } from '@/api/types';

/**
 * EIGScatter — eigenvalue scatter (real / imag plane) for the Analyze
 * panel's EIG sub-mode (Unit 6 — Phase A; interactivity added in
 * Unit 15 of the v2.0 polish plan).
 *
 * Rendering choice: this component intentionally uses an SVG scatter
 * rather than uPlot. uPlot's scatter mode (``paths: uPlot.paths.points()``)
 * is a viable alternative but the per-point click handler we need
 * for the linked-selection model (KTD-7) is awkward to wire through
 * uPlot's hover / cursor API. SVG keeps the click target and the
 * ``data-testid="eig-scatter-point-{idx}"`` test hook trivial.
 *
 * Linked-selection model (per KTD-7):
 *
 * - Click on an eigenvalue → ``setSelectedModeId(idx)`` →
 *   EIGParticipationTable populates + EIGDampingChart highlights.
 * - The selected point gets a distinct stroke + fill class
 *   (``eig-scatter-point-selected``).
 *
 * Empty-state branches:
 *
 * - ``mode_count === 0`` → "No dynamic states" message (stock IEEE
 *   14 case; ``data-testid="eig-empty"``).
 * - ``mode_count > 0`` but the filter hides everything → smaller
 *   inline note inviting the user to widen the filter.
 *
 * --------------------------------------------------------------------
 * Unit 15 — interactivity
 * --------------------------------------------------------------------
 *
 * **Pan / zoom** (hand-rolled, no d3 dep). Local state tracks a
 * ``view`` rectangle in *data* space — i.e. the axis-aligned window of
 * (Re, Im) values currently mapped to the SVG viewport. Initial view
 * is the auto-fit ``computeViewport`` result; wheel + drag mutate the
 * view; double-click resets to auto-fit.
 *
 *  - Wheel: ``factor = 1.1`` per "tick" (deltaY < 0 → zoom in). The
 *    cursor's *data-space* coordinate is held fixed across the zoom by
 *    re-projecting around it (``v' = cursor + (v - cursor) / factor``).
 *  - Drag: pointerdown → pointermove translates the view by the
 *    pixel delta converted to data-space units (``Δdata = Δpx *
 *    range / plotPx``). Click vs drag is distinguished by a 4-px
 *    movement threshold so a clean click still fires the
 *    select-mode action on a `<circle>`.
 *  - Double-click: resets ``view`` to ``autoView``.
 *
 * **Hover tooltip**. The pointermove handler tracks the cursor against
 * the visible point set and finds the nearest neighbour via an O(n)
 * scan — at 334 modes (NPCC 140-bus) this is sub-millisecond. The
 * tooltip renders as an absolutely-positioned `<div>` over the SVG; we
 * keep it out of `<svg>` so its DOM is stylable with the same Tailwind
 * tokens as the rest of the chrome (Radix Tooltip is overkill for a
 * cursor-following mini-card).
 *
 * **Log scale** for the |Re| axis. When ``xScale === 'log'`` the
 * mapping is ``sign(x) * log10(max(|x|, EPSILON))``. Modes with
 * negative damping (positive real part — i.e., growing modes) are
 * still rendered using their signed magnitude so the user can spot
 * them; a small warning chip surfaces in the chrome when any such
 * mode is present so the unusual axis layout doesn't go unexplained.
 *
 * **State scope**. View / scale / hover state is all *local*; it
 * resets on remount (e.g., when the user switches to PF and back to
 * EIG). This is an intentional simplification — lifting the state
 * into a Zustand slice would buy "preserve zoom across sub-mode
 * switch" at the cost of a 5-field cross-cutting cascade. The plan's
 * "integration: zoom state preserved when switching sub-modes" test
 * lives as a `.fixme` until that lift happens.
 */
export interface EIGScatterProps {
  /** Override for tests; usually pulled from the analyze store. */
  result?: EigResult | null;
  className?: string;
}

interface ScatterPoint {
  idx: number;
  real: number;
  imag: number;
}

/** Pure helper: project a real/imag pair into the SVG viewport. */
// eslint-disable-next-line react-refresh/only-export-components
export function computeScatterPoints(result: EigResult, visibleIndices: number[]): ScatterPoint[] {
  const out: ScatterPoint[] = [];
  for (const i of visibleIndices) {
    const z = result.eigenvalues[i];
    if (z === undefined) continue;
    out.push({ idx: i, real: z.real, imag: z.imag });
  }
  return out;
}

const SVG_WIDTH = 320;
const SVG_HEIGHT = 240;
const PADDING = 28;

/** Smallest |x| treated as "≈0" by the log-scale mapping. */
const LOG_EPSILON = 1e-6;
/** Wheel zoom factor per tick. */
const ZOOM_STEP = 1.1;
/** Pixel movement above which a pointerdown counts as a drag (not a click). */
const DRAG_THRESHOLD = 4;
/** Tooltip is hidden when no point is within this many pixels of the cursor. */
const HOVER_RADIUS_PX = 16;

interface ViewRect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * Produce a viewport bound that includes [-x_max, x_max] x [-y_max,
 * y_max] padded slightly so points don't render on the axis line.
 * When all points are at the origin, return a sensible default range.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeViewport(points: ScatterPoint[]): ViewRect {
  if (points.length === 0) {
    return { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
  }
  let xMax = 0;
  let yMax = 0;
  for (const p of points) {
    xMax = Math.max(xMax, Math.abs(p.real));
    yMax = Math.max(yMax, Math.abs(p.imag));
  }
  // Guard against all-zero data and pad by 10%.
  if (xMax === 0) xMax = 1;
  if (yMax === 0) yMax = 1;
  xMax *= 1.1;
  yMax *= 1.1;
  return { xMin: -xMax, xMax, yMin: -yMax, yMax };
}

/**
 * Signed-log transform for the |Re| axis. Returns
 * ``sign(x) * log10(max(|x|, EPSILON))`` so values close to zero map
 * near zero, large negatives map to large negative, and growing modes
 * (positive real part) stay on the right half of the chart.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function signedLog10(x: number): number {
  const mag = Math.max(Math.abs(x), LOG_EPSILON);
  const sign = x < 0 ? -1 : 1;
  return sign * Math.log10(mag);
}

export function EIGScatter({ result: resultProp, className }: EIGScatterProps) {
  const storeResult = useAnalyzeStore((s) => s.eigResult);
  const filter = useAnalyzeStore((s) => s.filter);
  const selectedModeId = useAnalyzeStore((s) => s.selectedModeId);
  const setSelectedModeId = useAnalyzeStore((s) => s.setSelectedModeId);

  const result = resultProp !== undefined ? resultProp : storeResult;

  const visibleIndices = useMemo(
    () => (result === null ? [] : applyEigFilter(result, filter)),
    [result, filter],
  );
  const points = useMemo(
    () => (result === null ? [] : computeScatterPoints(result, visibleIndices)),
    [result, visibleIndices],
  );
  const autoView = useMemo(() => computeViewport(points), [points]);

  // ---- view + interaction state ---------------------------------------
  const [view, setView] = useState<ViewRect>(autoView);
  const [xScale, setXScale] = useState<'linear' | 'log'>('linear');
  // Pixel coordinates of the hovered cursor (within the SVG container).
  // ``null`` when the pointer has left the chart.
  const [cursorPx, setCursorPx] = useState<{ x: number; y: number } | null>(null);
  // Index (into the visible ``points`` array) of the closest point under
  // the cursor; ``null`` when nothing is close enough to surface a tooltip.
  const [hoverPointIdx, setHoverPointIdx] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  // Pointer-drag bookkeeping. ``startPx`` is captured on pointerdown;
  // ``startView`` is the view at the moment the drag began so we can
  // translate from absolute deltas (no cumulative drift).
  const dragRef = useRef<{
    pointerId: number;
    startPx: { x: number; y: number };
    startView: ViewRect;
    moved: boolean;
  } | null>(null);

  // When the underlying point set changes (filter widened, new EIG
  // result, etc.) we want the auto-fit view to take effect — but we
  // also want a user's existing zoom to survive a benign re-render.
  // The simplest correct rule: snap to autoView whenever ``autoView``
  // changes identity. Memo'd autoView only changes when ``points``
  // does, so casual re-renders don't perturb the user's view.
  //
  // Skip the very first run — ``useState(autoView)`` already
  // initialised to the same value, so the extra ``setView`` call would
  // be wasted (and would surface as an act() warning in tests because
  // it fires during the initial render commit).
  const lastAutoViewRef = useRef<ViewRect>(autoView);
  useLayoutEffect(() => {
    if (lastAutoViewRef.current === autoView) return;
    lastAutoViewRef.current = autoView;
    setView(autoView);
    setCursorPx(null);
    setHoverPointIdx(null);
  }, [autoView]);

  // ---- palette-driven actions ----------------------------------------
  // "Reset EIG zoom" + "Toggle EIG log scale" commands emit on these
  // micro-buses (see lib/eigViewBus.ts). We subscribe once on mount.
  const resetView = useCallback(() => {
    setView(autoView);
  }, [autoView]);
  const toggleLog = useCallback(() => {
    setXScale((s) => (s === 'linear' ? 'log' : 'linear'));
  }, []);
  useEffect(() => subscribeEigViewReset(resetView), [resetView]);
  useEffect(() => subscribeEigLogToggle(toggleLog), [toggleLog]);

  // ---- coordinate transforms (depend on view + scale) -----------------
  const plotW = SVG_WIDTH - PADDING * 2;
  const plotH = SVG_HEIGHT - PADDING * 2;

  // For log mode the *axis-space* x-range is the signed-log of the
  // current view bounds. We project both the data points and the
  // cursor through ``transformX`` so panning and zooming behave
  // identically in either scale.
  const transformX = useCallback((x: number) => (xScale === 'log' ? signedLog10(x) : x), [xScale]);
  const inverseTransformX = useCallback(
    (xa: number) => {
      if (xScale === 'linear') return xa;
      // Inverse of signed-log10. Note: values inside [-log10(EPS),
      // log10(EPS)] correspond to data-space values in [-EPS, EPS]
      // which we squash to ±EPS to keep things finite.
      const sign = xa < 0 ? -1 : 1;
      const mag = Math.pow(10, Math.abs(xa));
      const out = sign * Math.max(mag, LOG_EPSILON);
      return out;
    },
    [xScale],
  );

  const xAxisMin = transformX(view.xMin);
  const xAxisMax = transformX(view.xMax);
  const xRange = xAxisMax - xAxisMin || 1;
  const yRange = view.yMax - view.yMin || 1;

  const xToPx = useCallback(
    (x: number) => PADDING + ((transformX(x) - xAxisMin) / xRange) * plotW,
    [transformX, xAxisMin, xRange, plotW],
  );
  const yToPx = useCallback(
    (y: number) => PADDING + ((view.yMax - y) / yRange) * plotH,
    [view.yMax, yRange, plotH],
  );
  const pxToData = useCallback(
    (px: number, py: number) => {
      const xa = xAxisMin + ((px - PADDING) / plotW) * xRange;
      const y = view.yMax - ((py - PADDING) / plotH) * yRange;
      return { x: inverseTransformX(xa), y };
    },
    [xAxisMin, xRange, plotW, view.yMax, yRange, plotH, inverseTransformX],
  );

  // Modes whose damping is negative (or whose real part is positive)
  // are growing — flag them so the log-scale axis layout is explained.
  const negativeDampingCount = useMemo(() => {
    if (result === null) return 0;
    let n = 0;
    for (const i of visibleIndices) {
      const z = result.eigenvalues[i];
      if (z !== undefined && z.real > 0) n += 1;
    }
    return n;
  }, [result, visibleIndices]);

  // ---- hover: nearest-point search in pixel space ---------------------
  const recomputeHover = useCallback(
    (cx: number, cy: number) => {
      if (points.length === 0) {
        setHoverPointIdx(null);
        return;
      }
      let bestIdx = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p === undefined) continue;
        const dx = xToPx(p.real) - cx;
        const dy = yToPx(p.imag) - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) {
          bestDist = d2;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && Math.sqrt(bestDist) <= HOVER_RADIUS_PX) {
        setHoverPointIdx(bestIdx);
      } else {
        setHoverPointIdx(null);
      }
    },
    [points, xToPx, yToPx],
  );

  // ---- pointer events --------------------------------------------------
  /**
   * Convert a DOM pointer event into SVG-viewBox pixel coordinates.
   * The SVG renders at ``preserveAspectRatio="xMidYMid meet"`` so we
   * compute the linear scale between the SVG's CSS pixels and its
   * viewBox-pixel space directly from the bounding rect — this stays
   * correct regardless of the parent container's size.
   */
  const eventToSvgPx = (
    evt: ReactPointerEvent | ReactWheelEvent,
  ): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (svg === null) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((evt.clientX - rect.left) / rect.width) * SVG_WIDTH;
    const y = ((evt.clientY - rect.top) / rect.height) * SVG_HEIGHT;
    return { x, y };
  };

  const handleWheel = useCallback(
    (evt: ReactWheelEvent<SVGSVGElement>) => {
      // Block page-scroll while wheel-zooming inside the chart. We
      // can't make the listener itself non-passive from React without
      // dropping to addEventListener, but ``evt.preventDefault`` still
      // works on synthetic wheel events as long as React's listener
      // is attached non-passively (it is by default for `onWheel`
      // when there is at least one bubble-phase handler).
      const px = eventToSvgPx(evt);
      if (px === null) return;
      evt.preventDefault();
      const data = pxToData(px.x, px.y);
      // Zoom: deltaY < 0 → zoom IN (factor < 1 shrinks the view).
      const factor = evt.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      // Reproject view bounds around the cursor's data-space coord.
      // For the X axis we work in *axis* space (post-transform) so
      // log-mode pans/zooms as expected.
      const cursorXa = transformX(data.x);
      const newXMinA = cursorXa + (xAxisMin - cursorXa) * factor;
      const newXMaxA = cursorXa + (xAxisMax - cursorXa) * factor;
      const newYMin = data.y + (view.yMin - data.y) * factor;
      const newYMax = data.y + (view.yMax - data.y) * factor;
      setView({
        xMin: inverseTransformX(newXMinA),
        xMax: inverseTransformX(newXMaxA),
        yMin: newYMin,
        yMax: newYMax,
      });
    },
    [pxToData, transformX, inverseTransformX, xAxisMin, xAxisMax, view.yMin, view.yMax],
  );

  const handlePointerDown = (evt: ReactPointerEvent<SVGSVGElement>) => {
    // Only start drags from the SVG background — clicks on a circle
    // bubble up here too, but the circle's own onClick fires first
    // and selects the mode. We still capture so a drag starting on a
    // point pans the view rather than selecting it (the click handler
    // only fires if ``moved`` stays false).
    const px = eventToSvgPx(evt);
    if (px === null) return;
    dragRef.current = {
      pointerId: evt.pointerId,
      startPx: px,
      startView: view,
      moved: false,
    };
    evt.currentTarget.setPointerCapture(evt.pointerId);
  };

  const handlePointerMove = (evt: ReactPointerEvent<SVGSVGElement>) => {
    const px = eventToSvgPx(evt);
    if (px === null) return;
    setCursorPx(px);
    recomputeHover(px.x, px.y);

    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== evt.pointerId) return;
    const dxPx = px.x - drag.startPx.x;
    const dyPx = px.y - drag.startPx.y;
    if (!drag.moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD) return;
    drag.moved = true;
    // Translate the saved view by the pixel delta converted to data
    // (axis-space for X) units. We translate from ``startView`` so
    // pointer jitter doesn't accumulate.
    const startXMinA = transformX(drag.startView.xMin);
    const startXMaxA = transformX(drag.startView.xMax);
    const dxAxis = (dxPx / plotW) * (startXMaxA - startXMinA);
    const dyData = (dyPx / plotH) * (drag.startView.yMax - drag.startView.yMin);
    setView({
      xMin: inverseTransformX(startXMinA - dxAxis),
      xMax: inverseTransformX(startXMaxA - dxAxis),
      yMin: drag.startView.yMin + dyData,
      yMax: drag.startView.yMax + dyData,
    });
  };

  const endDrag = (evt: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== evt.pointerId) return;
    if (evt.currentTarget.hasPointerCapture(evt.pointerId)) {
      evt.currentTarget.releasePointerCapture(evt.pointerId);
    }
    dragRef.current = null;
  };

  const handlePointerLeave = () => {
    setCursorPx(null);
    setHoverPointIdx(null);
  };

  const handleDoubleClick = (evt: ReactPointerEvent<SVGSVGElement>) => {
    evt.preventDefault();
    resetView();
  };

  // The per-circle click handler short-circuits if the pointer was
  // dragged — otherwise dragging a point would race with selection.
  const handlePointClick = (idx: number) => {
    if (dragRef.current?.moved === true) return;
    setSelectedModeId(idx);
  };

  // ---- empty-state branches (unchanged from Unit 6) -------------------
  if (result === null) {
    return (
      <div
        data-testid="eig-empty"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[200px] items-center justify-center rounded border p-4 text-xs',
          className,
        )}
      >
        Run EIG to see eigenvalues.
      </div>
    );
  }

  if (result.mode_count === 0) {
    return (
      <div
        data-testid="eig-empty"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[200px] items-center justify-center rounded border p-4 text-xs',
          className,
        )}
      >
        No dynamic states present; EIG requires generators with dynamic models. Try kundur_full or
        IEEE 14 with a `.dyr` addfile.
      </div>
    );
  }

  // ---- tooltip text for the hovered point -----------------------------
  const hoveredPoint = hoverPointIdx !== null ? points[hoverPointIdx] : undefined;
  const hoveredFields = (() => {
    if (hoveredPoint === undefined) return null;
    const idx = hoveredPoint.idx;
    const damp = result.damping_ratios[idx] ?? 0;
    const freq = result.frequencies_hz[idx] ?? 0;
    return {
      idx,
      real: hoveredPoint.real,
      imag: hoveredPoint.imag,
      damping: damp,
      frequency: freq,
    };
  })();

  return (
    <div
      data-testid="eig-scatter"
      data-x-scale={xScale}
      className={cn('border-border bg-background relative flex flex-col rounded border', className)}
    >
      <div className="border-border text-muted-foreground flex items-center justify-between gap-3 border-b px-2.5 py-1.5 text-[11px]">
        <span className="tabular-nums">
          Eigenvalue scatter — {points.length} of {result.mode_count} visible (filter: damping &lt;{' '}
          {filter.dampingMax}, |Re| &lt; {filter.realAbsMax})
        </span>
        <div className="bg-muted/40 flex items-center gap-0.5 rounded p-0.5">
          {xScale === 'log' && negativeDampingCount > 0 ? (
            <span
              data-testid="eig-scatter-log-warning"
              role="status"
              className={cn(
                'border-warning/40 bg-warning/10 text-foreground',
                'mr-1 rounded border px-1.5 py-0.5 text-[9px] leading-none',
              )}
              title={`${negativeDampingCount} growing mode(s) have positive Re; on log-scale they map to the right half via signed magnitude.`}
            >
              {negativeDampingCount} growing
            </span>
          ) : null}
          <Button
            type="button"
            variant={xScale === 'log' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-[10px] font-medium"
            data-testid="eig-scatter-log-toggle"
            data-active={xScale === 'log' ? 'true' : 'false'}
            aria-pressed={xScale === 'log'}
            onClick={toggleLog}
            title="Toggle log scale on the |Re| axis"
          >
            log |Re|
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] font-medium"
            data-testid="eig-scatter-zoom-reset"
            onClick={resetView}
            title="Reset zoom (double-click in chart also works)"
          >
            Reset
          </Button>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="h-full w-full touch-none select-none"
        role="img"
        aria-label="Eigenvalue scatter"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
      >
        {/* clip rect so points dragged off-axis don't bleed over labels */}
        <defs>
          <clipPath id="eig-scatter-plot-area">
            <rect x={PADDING} y={PADDING} width={plotW} height={plotH} />
          </clipPath>
        </defs>
        {/* axes — drawn at the data-space origin if visible, else clamped */}
        <line
          x1={PADDING}
          y1={clamp(yToPx(0), PADDING, PADDING + plotH)}
          x2={PADDING + plotW}
          y2={clamp(yToPx(0), PADDING, PADDING + plotH)}
          className="stroke-border"
          strokeWidth={1}
        />
        <line
          x1={clamp(xToPx(0), PADDING, PADDING + plotW)}
          y1={PADDING}
          x2={clamp(xToPx(0), PADDING, PADDING + plotW)}
          y2={PADDING + plotH}
          className="stroke-border"
          strokeWidth={1}
        />
        <text
          x={SVG_WIDTH - PADDING + 4}
          y={clamp(yToPx(0), PADDING, PADDING + plotH) - 4}
          className="fill-muted-foreground text-[8px]"
        >
          {xScale === 'log' ? 'log|Re|' : 'Re'}
        </text>
        <text
          x={clamp(xToPx(0), PADDING, PADDING + plotW) + 4}
          y={PADDING - 6}
          className="fill-muted-foreground text-[8px]"
        >
          Im
        </text>
        {points.length === 0 ? (
          <text
            x={SVG_WIDTH / 2}
            y={SVG_HEIGHT / 2}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            All modes hidden by current filter.
          </text>
        ) : null}
        <g clipPath="url(#eig-scatter-plot-area)">
          {points.map((p, listIdx) => {
            const isSelected = selectedModeId === p.idx;
            const isHovered = hoverPointIdx === listIdx;
            const cx = xToPx(p.real);
            const cy = yToPx(p.imag);
            // Skip points that have been panned / zoomed clean off the
            // plot area — keeps the SVG node count low at extreme zoom
            // while still re-rendering them when they slide back into
            // view.
            if (
              cx < PADDING - 10 ||
              cx > PADDING + plotW + 10 ||
              cy < PADDING - 10 ||
              cy > PADDING + plotH + 10
            ) {
              return null;
            }
            return (
              <g key={p.idx}>
                {isSelected ? (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={10}
                    aria-hidden="true"
                    className="fill-primary/15 stroke-primary/40 pointer-events-none"
                    strokeWidth={1}
                  />
                ) : null}
                <circle
                  cx={cx}
                  cy={cy}
                  r={isSelected ? 5 : isHovered ? 4 : 3}
                  data-testid={`eig-scatter-point-${p.idx}`}
                  data-selected={isSelected ? 'true' : 'false'}
                  className={cn(
                    'cursor-pointer transition-[r,fill]',
                    isSelected
                      ? 'fill-primary stroke-foreground'
                      : isHovered
                        ? 'fill-primary'
                        : 'fill-foreground/60 hover:fill-primary',
                  )}
                  strokeWidth={isSelected ? 1.5 : 0}
                  onClick={() => handlePointClick(p.idx)}
                />
              </g>
            );
          })}
        </g>
      </svg>
      {hoveredFields !== null && cursorPx !== null ? (
        <Tooltip svg={svgRef.current} cursorPx={cursorPx} fields={hoveredFields} />
      ) : null}
    </div>
  );
}

interface TooltipFields {
  idx: number;
  real: number;
  imag: number;
  damping: number;
  frequency: number;
}

/**
 * Hover tooltip — absolutely positioned near the cursor. Receives
 * SVG-viewBox pixel coordinates and converts them to container-relative
 * CSS pixels by reading the SVG's bounding rect; this keeps the tooltip
 * pinned correctly even when the SVG renders at non-1:1 scale.
 */
function Tooltip({
  svg,
  cursorPx,
  fields,
}: {
  svg: SVGSVGElement | null;
  cursorPx: { x: number; y: number };
  fields: TooltipFields;
}) {
  if (svg === null) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  // Convert viewBox pixels back to CSS pixels relative to the SVG.
  const left = (cursorPx.x / SVG_WIDTH) * rect.width + 12;
  const top = (cursorPx.y / SVG_HEIGHT) * rect.height + 12;
  const realStr = formatNearZero(fields.real);
  const imagStr = formatNearZero(fields.imag);
  const sign = fields.imag < 0 ? '-' : '+';
  const dampPct = (fields.damping * 100).toFixed(1);
  return (
    <div
      data-testid="eig-scatter-tooltip"
      data-mode-idx={fields.idx}
      role="tooltip"
      className={cn(
        'pointer-events-none absolute z-10',
        'border-border bg-popover text-popover-foreground',
        'rounded-md border px-2.5 py-1.5 text-[10px] shadow-lg ring-1 ring-black/5',
        'whitespace-nowrap',
      )}
      style={{ left, top }}
    >
      <div className="text-muted-foreground mb-0.5 flex items-center gap-1.5 text-[9px] uppercase tracking-wider">
        <span>Mode</span>
        <span className="text-foreground tabular-nums">#{fields.idx}</span>
      </div>
      <div className="font-mono tabular-nums leading-snug">
        λ = {realStr} {sign}{' '}
        {Math.abs(fields.imag) < LOG_EPSILON ? '≈0' : imagStr.replace(/^-/, '')}i
      </div>
      <div className="font-mono tabular-nums leading-snug">
        ζ = {dampPct}%, f = {fields.frequency.toFixed(3)} Hz
      </div>
    </div>
  );
}

function formatNearZero(x: number): string {
  if (Math.abs(x) < LOG_EPSILON) return '≈0';
  // Three significant decimals is enough to disambiguate adjacent
  // modes in research workflows; longer numbers wrap unhelpfully on
  // the cursor-following card.
  return x.toFixed(3);
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
