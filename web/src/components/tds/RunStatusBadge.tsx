import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';
import { cn } from '@/lib/cn';

/**
 * RunStatusBadge — small pill in the top bar reporting the active TDS
 * run's lifecycle + connection status.
 *
 * Visibility: renders nothing when there's no active run. Once a run is
 * registered (``RunStream`` fired ``stream_start`` and called
 * ``runs.startRun``), the pill appears and updates as the lifecycle
 * advances.
 *
 * State precedence (highest to lowest):
 *
 * 1. Connection ``"reconnecting"`` (regardless of run state) → "Reconnecting…"
 * 2. Connection ``"lagged"`` (cap-evicted active run) → "Lagged"
 * 3. Run state ``"error"`` → "Error"
 * 4. Run state ``"aborted"`` → "Aborted at t={tCurrent}"
 * 5. Run state ``"done"`` + ``converged === false`` → "Halted at t={tCurrent}"
 *    (warning tone — the solver gave up before tf, e.g. numerical
 *    instability; the tooltip carries the reason when available).
 * 6. Run state ``"done"`` (converged) → "Done at t={tCurrent}"
 * 7. Run state ``"streaming"`` → "Streaming…"
 * 8. Run state ``"starting"`` → "Starting…"
 *
 * The connection states win over the run state because a "streaming"
 * label while the WS is reconnecting would mislead the user about what's
 * happening on the wire.
 */

export interface RunStatusBadgeProps {
  className?: string;
}

interface BadgeAppearance {
  label: string;
  /** Tailwind classes for background + text + border. */
  tone: string;
  /** Show a pulsing dot to signal an in-flight state. */
  pulse: boolean;
  /** Optional hover tooltip (e.g. the halt reason). */
  title?: string;
}

function pickAppearance(run: RunRecord): BadgeAppearance {
  if (run.connection === 'reconnecting') {
    return {
      label: 'Reconnecting…',
      tone: 'border-warning/40 bg-warning/10 text-foreground',
      pulse: true,
    };
  }
  if (run.connection === 'lagged') {
    return {
      label: 'Lagged',
      tone: 'border-warning/40 bg-warning/10 text-foreground',
      pulse: false,
    };
  }
  if (run.connection === 'disconnected') {
    return {
      label: 'Disconnected',
      tone: 'border-danger/40 bg-danger/10 text-foreground',
      pulse: false,
    };
  }
  switch (run.state) {
    case 'error':
      return {
        label: `Error at t=${run.tCurrent.toFixed(2)}`,
        tone: 'border-danger/40 bg-danger/10 text-foreground',
        pulse: false,
        title: run.errorReason ?? undefined,
      };
    case 'aborted':
      return {
        label: `Aborted at t=${run.tCurrent.toFixed(2)}`,
        tone: 'border-warning/40 bg-warning/10 text-foreground',
        pulse: false,
      };
    case 'done':
      // A run can finish on the wire without finishing the simulation:
      // ``done`` with ``converged === false`` means the solver halted
      // early (e.g. numerical instability at t=6.34 of a 10 s run).
      // Telling the user "Done" there is a lie — call it out as halted
      // with a warning tone + the reason in the tooltip when we have it.
      if (run.converged === false) {
        return {
          label: `Halted at t=${run.tCurrent.toFixed(2)}`,
          tone: 'border-warning/40 bg-warning/10 text-foreground',
          pulse: false,
          title:
            run.errorReason ??
            `Simulation halted before tf=${run.tf} — the solver did not converge.`,
        };
      }
      return {
        label: `Done at t=${run.tCurrent.toFixed(2)}`,
        tone: 'border-success/40 bg-success/10 text-foreground',
        pulse: false,
      };
    case 'streaming':
      return {
        label: `Streaming… t=${run.tCurrent.toFixed(2)}`,
        tone: 'border-primary/40 bg-primary/10 text-foreground',
        pulse: true,
      };
    case 'starting':
    default:
      return {
        label: 'Starting…',
        tone: 'border-primary/40 bg-primary/10 text-foreground',
        pulse: true,
      };
  }
}

export function RunStatusBadge({ className }: RunStatusBadgeProps) {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const run = useRunsStore((s) => (activeRunId === null ? null : (s.runs[activeRunId] ?? null)));

  if (run === null) return null;

  const appearance = pickAppearance(run);

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="tds-run-status-badge"
      data-state={run.state}
      data-connection={run.connection}
      title={appearance.title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        appearance.tone,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          'bg-current',
          appearance.pulse ? 'animate-pulse' : '',
        )}
      />
      <span>{appearance.label}</span>
    </span>
  );
}
