/**
 * ExternalTraceChip. One chip per imported external trace, in the plot's
 * legend row beside the run chips: the dashed swatch in the trace's colour,
 * its label, and a remove button that takes the trace off the plot.
 */
import { useExternalOverlaysStore } from '@/store/externalOverlays';
import type { ExternalOverlayTrace } from '@/store/externalOverlays';
import { cn } from '@/lib/cn';

export interface ExternalTraceChipProps {
  trace: ExternalOverlayTrace;
  /** The stroke colour the plot draws the trace in (``colorFor`` of the plot). */
  color: string;
  className?: string;
}

/** The dash pattern the plot draws the traces with, as the swatch's gradient. */
const DASH: readonly [number, number] = [6, 4];

export function ExternalTraceChip({ trace, color, className }: ExternalTraceChipProps) {
  const removeTrace = useExternalOverlaysStore((s) => s.removeTrace);
  const swatchBg = `repeating-linear-gradient(90deg, ${color} 0 ${DASH[0]}px, transparent ${DASH[0]}px ${DASH[0] + DASH[1]}px)`;
  return (
    <span
      data-testid={`external-trace-chip-${trace.id}`}
      className={cn(
        'inline-flex items-center gap-1.5',
        'rounded-[var(--radius-sm)] border px-2 py-1 text-xs',
        'border-border bg-muted text-foreground',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="inline-block h-3 w-4 rounded-sm"
        style={{ background: swatchBg }}
      />
      <span className="font-mono">{trace.label}</span>
      <button
        type="button"
        aria-label={`Remove ${trace.label}`}
        data-testid={`external-trace-remove-${trace.id}`}
        onClick={() => removeTrace(trace.id)}
        className={cn(
          'rounded-[var(--radius-sm)] px-0.5',
          'hover:bg-muted/60',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      >
        ×
      </button>
    </span>
  );
}
