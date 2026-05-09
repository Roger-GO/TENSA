import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { cn } from '@/lib/cn';

/**
 * Thin React wrapper around a single uPlot instance.
 *
 * Lifecycle:
 *  - On mount: construct one ``uPlot`` instance into the wrapper div.
 *  - On ``data`` change (same shape): call ``setData(data, false)``
 *    to push new column values without resetting scales — this is the
 *    fast streaming path (no DOM re-mount; uPlot redraws to the
 *    existing canvas in <2 ms for typical sizes).
 *  - On ``options`` change OR series-count change: destroy + recreate.
 *    uPlot has ``addSeries`` / ``delSeries`` but recreating is simpler
 *    and the cost is acceptable when toggling a series in the picker
 *    (a deliberate, low-frequency action).
 *  - On unmount: ``destroy()`` to release listeners and the canvas.
 *
 * Sizing: a ``ResizeObserver`` watches the wrapper div; on each
 * resize the chart's ``setSize`` is called. The chart's intrinsic
 * width/height come from the wrapper's content box. The parent is
 * responsible for giving the wrapper a non-zero size (CSS flex / grid).
 *
 * jsdom note: uPlot constructs a ``<canvas>`` and reads
 * ``getContext('2d')``; jsdom returns ``null`` for that, which uPlot
 * handles by skipping draw calls but still building the DOM. Tests
 * therefore assert on lifecycle (mount / unmount / setData calls)
 * rather than rendered pixels — see the test file for the chosen
 * approach.
 */
export interface UPlotProps {
  /** uPlot options object. Width/height are overridden by ResizeObserver. */
  options: uPlot.Options;
  /** Aligned data: ``[xs, ...ys]``. Typed arrays accepted directly. */
  data: uPlot.AlignedData;
  /** Extra class on the wrapper div. */
  className?: string;
  /**
   * Optional fallback rendered when the data has zero rows. Use this
   * for the empty-state placeholder ("Run a TDS to see results");
   * when supplied AND the data is empty, the wrapper renders the
   * fallback instead of constructing a uPlot instance (saves the
   * canvas allocation + skips the empty-line draw).
   */
  emptyFallback?: React.ReactNode;
  /** Optional ref into the underlying uPlot instance for tests / advanced flows. */
  uplotRef?: React.MutableRefObject<uPlot | null>;
}

/** Identity check that's stable across re-renders for the series-count comparison. */
function seriesCount(opts: uPlot.Options): number {
  return opts.series?.length ?? 0;
}

export function UPlot({ options, data, className, emptyFallback, uplotRef }: UPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<uPlot | null>(null);
  const optionsRef = useRef<uPlot.Options>(options);
  const seriesCountRef = useRef<number>(seriesCount(options));
  const xLen =
    Array.isArray(data[0]) || ArrayBuffer.isView(data[0])
      ? (data[0] as ArrayLike<number>).length
      : 0;

  // Detect whether to render the empty fallback. We check at render
  // time so the JSX branch chooses correctly; the effect below also
  // skips construction when the fallback is active.
  const showFallback = emptyFallback !== undefined && xLen === 0;

  // Construction effect. Runs on mount + whenever ``options`` identity
  // changes OR series count changes. We do NOT depend on ``data`` here
  // — the data-update effect below handles incremental updates.
  useEffect(() => {
    if (showFallback) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    // Sized to the container's content box. uPlot wants concrete
    // numbers up front; ResizeObserver below patches subsequent sizes.
    const rect = container.getBoundingClientRect();
    const initialOptions: uPlot.Options = {
      ...options,
      width: Math.max(1, Math.round(rect.width || 600)),
      height: Math.max(1, Math.round(rect.height || 200)),
    };

    const instance = new uPlot(initialOptions, data, container);
    instanceRef.current = instance;
    if (uplotRef) uplotRef.current = instance;
    optionsRef.current = options;
    seriesCountRef.current = seriesCount(options);

    return () => {
      instance.destroy();
      instanceRef.current = null;
      if (uplotRef) uplotRef.current = null;
    };
    // We intentionally key construction on the options reference + the
    // series count. Data updates flow through the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, showFallback]);

  // Data-update effect. Runs on every render where the data prop
  // changes; pushes the new aligned data into the existing instance.
  // Skips when the construction effect just (re)created the instance
  // because the constructor already received this data.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    // ``setData(data, false)`` keeps the user's current scale (zoom).
    // For a fresh run with monotonically growing t, we still want the
    // x-axis to expand — uPlot's scale-auto handles this when the
    // current scale's max equals the prior data tail.
    instance.setData(data, false);
  }, [data]);

  // Resize observer. Re-runs ``setSize`` whenever the wrapper resizes.
  useEffect(() => {
    if (showFallback) return undefined;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const instance = instanceRef.current;
      if (instance && width > 0 && height > 0) {
        instance.setSize({ width: Math.round(width), height: Math.round(height) });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [showFallback]);

  if (showFallback) {
    return (
      <div
        ref={containerRef}
        data-testid="uplot-empty"
        className={cn('flex h-full w-full items-center justify-center', className)}
      >
        {emptyFallback}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="uplot-container"
      className={cn('relative h-full w-full', className)}
    />
  );
}
