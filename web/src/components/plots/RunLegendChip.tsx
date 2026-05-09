/**
 * RunLegendChip (Unit 9 of the v2.0 plan).
 *
 * One chip per overlay run, surfaced above the TimeSeriesPlot. Shows
 * the runId-stable colour swatch, a short human-facing label (the
 * runId's leading 8 chars + tf), and a click target that toggles the
 * run in/out of the overlay set.
 *
 * Lives next to the plot rather than inside ``<TimeSeriesPlot />`` so
 * the chips can be wrapped/styled by the surrounding layout (the v2.0
 * Analyze panel mounts a horizontal chip strip; the History drawer
 * reuses the same chip in the per-row pin/unpin button).
 */
import { useRunsStore } from '@/store/runs';
import { runIdToStrokeStyle } from '@/lib/runIdToColor';
import { cn } from '@/lib/cn';

export interface RunLegendChipProps {
  /** Run id this chip represents. Required — chips are run-specific. */
  runId: string;
  /**
   * Optional override for the displayed label. Defaults to
   * ``"<run-id-prefix> · tf=<tf>s"``.
   */
  label?: string;
  /**
   * When true, the chip renders in the "pinned" visual state and
   * clicking removes the run from the overlay set. When false, the
   * chip is "unpinned" and clicking adds it. Defaults to subscribing
   * to the overlay store.
   */
  pinned?: boolean;
  /**
   * Click handler override. When omitted, the chip toggles the run in
   * the overlay store. The History drawer passes its own handler so
   * the action can also surface a toast.
   */
  onToggle?: (runId: string, willBePinned: boolean) => void;
  className?: string;
}

/** Trim a run id for display (first 8 chars). */
function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

export function RunLegendChip({
  runId,
  label,
  pinned,
  onToggle,
  className,
}: RunLegendChipProps) {
  const overlayHas = useRunsStore((s) => s.overlayRunIds.has(runId));
  const addOverlay = useRunsStore((s) => s.addOverlayRun);
  const removeOverlay = useRunsStore((s) => s.removeOverlayRun);
  const run = useRunsStore((s) => s.runs[runId]);

  const isPinned = pinned ?? overlayHas;
  const style = runIdToStrokeStyle(runId);

  // Default label: ``<short> · tf=<tf>s`` so the chip is identifiable
  // even when the user has named their runs after their parameters.
  const defaultLabel = run ? `${shortRunId(runId)} · tf=${run.tf}s` : shortRunId(runId);
  const displayLabel = label ?? defaultLabel;

  const handleClick = () => {
    if (onToggle) {
      onToggle(runId, !isPinned);
      return;
    }
    if (isPinned) removeOverlay(runId);
    else addOverlay(runId);
  };

  // The colour swatch renders the dash pattern via repeating-linear-gradient
  // so the visual exactly matches what the uPlot stroke will look like
  // for this run. For solid (empty dash) we fall back to a flat fill.
  const swatchBg =
    style.dash.length === 0
      ? style.color
      : `repeating-linear-gradient(90deg, ${style.color} 0 ${style.dash[0]}px, transparent ${style.dash[0]}px ${(style.dash[0] ?? 0) + (style.dash[1] ?? 0)}px)`;

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid={`run-legend-chip-${runId}`}
      data-run-id={runId}
      data-pinned={isPinned ? 'true' : 'false'}
      aria-pressed={isPinned}
      aria-label={isPinned ? `Unpin ${displayLabel} from overlay` : `Pin ${displayLabel} to overlay`}
      className={cn(
        'inline-flex items-center gap-1.5',
        'rounded-[var(--radius-sm)] border px-2 py-1 text-xs',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'transition-colors',
        isPinned
          ? 'border-border bg-muted text-foreground hover:bg-muted/80'
          : 'border-border bg-background text-muted-foreground hover:bg-muted/40',
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-testid={`run-legend-chip-swatch-${runId}`}
        className="inline-block h-2.5 w-3 rounded-sm"
        style={{ background: swatchBg }}
      />
      <span className="font-mono">{displayLabel}</span>
    </button>
  );
}
