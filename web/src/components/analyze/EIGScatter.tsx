import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import {
  applyEigFilter,
  useAnalyzeStore,
} from '@/store/analyze';
import type { EigResult } from '@/api/types';

/**
 * EIGScatter — eigenvalue scatter (real / imag plane) for the Analyze
 * panel's EIG sub-mode (Unit 6).
 *
 * Rendering choice: this component intentionally uses an SVG scatter
 * rather than uPlot. uPlot's scatter mode (``paths: uPlot.paths.points()``)
 * is a viable alternative but the per-point click handler we need
 * for the linked-selection model (KTD-7) is awkward to wire through
 * uPlot's hover / cursor API. SVG keeps the click target and the
 * ``data-testid="eig-scatter-point-{idx}"`` test hook trivial. For
 * Phase 3's larger-case work (NPCC 140 = 334 modes) we may swap to
 * canvas if the SVG node count becomes a render-time pressure point;
 * the default filter (per KTD-7: damping < 5% AND |Re| < 5) keeps
 * the visible-set well below 200 for typical research cases.
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
export function computeScatterPoints(
  result: EigResult,
  visibleIndices: number[],
): ScatterPoint[] {
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

/**
 * Produce a viewport bound that includes [-x_max, x_max] x [-y_max,
 * y_max] padded slightly so points don't render on the axis line.
 * When all points are at the origin, return a sensible default range.
 */
function computeViewport(points: ScatterPoint[]): {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
} {
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
  const viewport = useMemo(() => computeViewport(points), [points]);

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
        No dynamic states present; EIG requires generators with dynamic
        models. Try kundur_full or IEEE 14 with a `.dyr` addfile.
      </div>
    );
  }

  const xRange = viewport.xMax - viewport.xMin;
  const yRange = viewport.yMax - viewport.yMin;
  const plotW = SVG_WIDTH - PADDING * 2;
  const plotH = SVG_HEIGHT - PADDING * 2;
  const xToPx = (x: number) => PADDING + ((x - viewport.xMin) / xRange) * plotW;
  const yToPx = (y: number) =>
    PADDING + ((viewport.yMax - y) / yRange) * plotH;

  return (
    <div
      data-testid="eig-scatter"
      className={cn(
        'border-border bg-background flex flex-col rounded border',
        className,
      )}
    >
      <div className="border-border text-muted-foreground border-b px-2 py-1 text-[10px]">
        Eigenvalue scatter — {points.length} of {result.mode_count} visible
        (filter: damping &lt; {filter.dampingMax}, |Re| &lt; {filter.realAbsMax})
      </div>
      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="h-full w-full"
        role="img"
        aria-label="Eigenvalue scatter"
      >
        {/* axes */}
        <line
          x1={xToPx(viewport.xMin)}
          y1={yToPx(0)}
          x2={xToPx(viewport.xMax)}
          y2={yToPx(0)}
          className="stroke-border"
          strokeWidth={1}
        />
        <line
          x1={xToPx(0)}
          y1={yToPx(viewport.yMin)}
          x2={xToPx(0)}
          y2={yToPx(viewport.yMax)}
          className="stroke-border"
          strokeWidth={1}
        />
        <text
          x={SVG_WIDTH - PADDING + 4}
          y={yToPx(0) - 4}
          className="fill-muted-foreground text-[8px]"
        >
          Re
        </text>
        <text
          x={xToPx(0) + 4}
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
        {points.map((p) => {
          const isSelected = selectedModeId === p.idx;
          return (
            <circle
              key={p.idx}
              cx={xToPx(p.real)}
              cy={yToPx(p.imag)}
              r={isSelected ? 5 : 3}
              data-testid={`eig-scatter-point-${p.idx}`}
              data-selected={isSelected ? 'true' : 'false'}
              className={cn(
                'cursor-pointer transition-[r,fill]',
                isSelected
                  ? 'fill-primary stroke-foreground'
                  : 'fill-foreground/60 hover:fill-primary',
              )}
              strokeWidth={isSelected ? 1.5 : 0}
              onClick={() => setSelectedModeId(p.idx)}
            />
          );
        })}
      </svg>
    </div>
  );
}
