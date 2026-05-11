import { useMemo } from 'react';
import { cn } from '@/lib/cn';

/**
 * InlineSparkline (v3 Unit 9).
 *
 * Small reusable SVG line chart for the RightInspector Plots accordion
 * section. Sized ~200x80 (the SVG is responsive — actual on-screen size
 * is governed by the parent's CSS width). Stroke uses the project's
 * ``--color-primary`` token so the chart picks up theme changes without
 * a re-render.
 *
 * Empty / single-sample inputs render a degenerate SVG (no path),
 * matching the EmptyState cascade in PlotsAccordion (which shows an
 * EmptyState upstream when no run-derived data is available).
 *
 * Sparkline math is intentionally trivial — straight line segments,
 * linear x-scaling by index, linear y-scaling between min/max. No
 * smoothing, no cursor, no axis ticks. The component is read-only.
 */
export interface InlineSparklineProps {
  /** Sequence of numeric values plotted left-to-right. */
  values: number[];
  /**
   * Optional label rendered above the sparkline (e.g. ``Voltage (pu)``).
   * Falls back to no label when omitted.
   */
  label?: string;
  /**
   * Format the latest value badge displayed at the right edge. Defaults
   * to fixed-4 decimal precision; callers pass a custom formatter for
   * e.g. integer counts or percentage formatting.
   */
  valueFormat?: (n: number) => string;
  className?: string;
}

const SVG_WIDTH = 200;
const SVG_HEIGHT = 80;
const PADDING_X = 4;
const PADDING_Y = 6;

function defaultFormat(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  return n.toFixed(4);
}

export function InlineSparkline({ values, label, valueFormat, className }: InlineSparklineProps) {
  const formatter = valueFormat ?? defaultFormat;
  const lastSample = values.length > 0 ? values[values.length - 1] : undefined;
  const last: number | null = typeof lastSample === 'number' ? lastSample : null;

  const path = useMemo(() => {
    if (values.length < 2) return '';
    const usableW = SVG_WIDTH - PADDING_X * 2;
    const usableH = SVG_HEIGHT - PADDING_Y * 2;
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
    // Flat line — degenerate y-range, paint at the vertical centre.
    const range = max - min === 0 ? 1 : max - min;
    const stepX = values.length > 1 ? usableW / (values.length - 1) : 0;
    const segments: string[] = [];
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]!;
      const x = PADDING_X + stepX * i;
      // Y axis: SVG y increases downward, so invert.
      const y =
        max - min === 0
          ? PADDING_Y + usableH / 2
          : PADDING_Y + usableH - ((v - min) / range) * usableH;
      segments.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return segments.join(' ');
  }, [values]);

  return (
    <div data-testid="inline-sparkline" className={cn('flex flex-col gap-1', className)}>
      {label ? (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground text-[10px] tracking-wide uppercase">{label}</span>
          {last !== null && Number.isFinite(last) ? (
            <span
              data-testid="inline-sparkline-value"
              className="text-foreground font-mono text-xs"
            >
              {formatter(last)}
            </span>
          ) : null}
        </div>
      ) : null}
      <svg
        role="img"
        aria-label={label ? `${label} sparkline` : 'sparkline'}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        preserveAspectRatio="none"
        className={cn(
          'border-border/60 bg-muted/30 h-[64px] w-full rounded-[var(--radius-sm)] border',
        )}
      >
        {path ? (
          <path
            data-testid="inline-sparkline-path"
            d={path}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-muted-foreground"
            fontSize="10"
            fontFamily="var(--font-sans)"
          >
            Run TDS to see data
          </text>
        )}
      </svg>
    </div>
  );
}
