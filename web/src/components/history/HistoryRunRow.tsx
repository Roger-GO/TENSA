/**
 * HistoryRunRow (Unit 9 of the v2.0 plan).
 *
 * Single row in the history drawer: shows the run id (short prefix +
 * tf), state badge (streaming / done / error / aborted), the wall-clock
 * timestamp it started at, and per-row actions:
 *
 * - "Pin to overlay" / "Unpin" — toggles ``overlayRunIds`` membership.
 * - "Reset" — drops the run from the runs slice (frees its buffers).
 *
 * The row is visually distinct for the active run (bolder border).
 * Sweep progress (Unit 18) extends this row with a progress bar.
 */
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';
import { Button } from '@/components/ui/button';
import { runIdToStrokeStyle } from '@/lib/runIdToColor';
import { cn } from '@/lib/cn';

export interface HistoryRunRowProps {
  run: RunRecord;
  /** True when this row's run is the active anchor (SLD overlay etc.). */
  isActive: boolean;
  /** True when this run is in the overlay set. */
  isOverlayPinned: boolean;
  /** Callback fired after the user pins/unpins the run. */
  onTogglePin?: (runId: string, willBePinned: boolean) => void;
  /** Callback fired after the user resets the run. */
  onReset?: (runId: string) => void;
  className?: string;
}

/** Format a wall-clock timestamp as ``HH:MM:SS`` for the row timestamp. */
function formatTime(epochMs: number): string {
  try {
    const d = new Date(epochMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '—';
  }
}

const STATE_LABEL: Record<RunRecord['state'], string> = {
  starting: 'starting',
  streaming: 'streaming',
  done: 'done',
  error: 'error',
  aborted: 'aborted',
};

const STATE_CLASS: Record<RunRecord['state'], string> = {
  starting: 'bg-muted text-muted-foreground',
  streaming: 'bg-primary/15 text-foreground',
  done: 'bg-success/15 text-foreground',
  error: 'bg-danger/15 text-foreground',
  aborted: 'bg-muted text-muted-foreground',
};

function shortRunId(runId: string): string {
  return runId.length > 12 ? runId.slice(0, 12) : runId;
}

export function HistoryRunRow({
  run,
  isActive,
  isOverlayPinned,
  onTogglePin,
  onReset,
  className,
}: HistoryRunRowProps) {
  const addOverlayRun = useRunsStore((s) => s.addOverlayRun);
  const removeOverlayRun = useRunsStore((s) => s.removeOverlayRun);
  const resetRun = useRunsStore((s) => s.resetRun);

  const style = runIdToStrokeStyle(run.runId);

  const handleTogglePin = () => {
    const willBePinned = !isOverlayPinned;
    if (willBePinned) addOverlayRun(run.runId);
    else removeOverlayRun(run.runId);
    onTogglePin?.(run.runId, willBePinned);
  };

  const handleReset = () => {
    resetRun(run.runId);
    onReset?.(run.runId);
  };

  return (
    <div
      data-testid={`history-run-row-${run.runId}`}
      data-run-id={run.runId}
      data-active={isActive ? 'true' : 'false'}
      data-pinned={isOverlayPinned ? 'true' : 'false'}
      className={cn(
        'border-border flex items-center gap-2 rounded border px-2 py-1.5',
        isActive ? 'border-primary/40' : '',
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-testid={`history-run-row-swatch-${run.runId}`}
        className="inline-block h-3 w-3 shrink-0 rounded-sm"
        style={{ background: style.color }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate font-mono text-xs">
            {shortRunId(run.runId)}
          </span>
          {isActive ? (
            <span
              data-testid={`history-run-row-active-badge-${run.runId}`}
              className="text-primary text-[10px] font-medium"
            >
              active
            </span>
          ) : null}
          <span
            data-testid={`history-run-row-state-${run.runId}`}
            className={cn(
              'rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px]',
              STATE_CLASS[run.state],
            )}
          >
            {STATE_LABEL[run.state]}
          </span>
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
          <span data-testid={`history-run-row-timestamp-${run.runId}`}>
            {formatTime(run.startedAt)}
          </span>
          <span>tf={run.tf}s</span>
          <span>{run.seqCount} rows</span>
        </div>
      </div>
      <Button
        type="button"
        variant={isOverlayPinned ? 'secondary' : 'outline'}
        size="sm"
        onClick={handleTogglePin}
        data-testid={`history-run-row-pin-${run.runId}`}
        aria-pressed={isOverlayPinned}
      >
        {isOverlayPinned ? 'Unpin' : 'Pin'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleReset}
        data-testid={`history-run-row-reset-${run.runId}`}
        title="Drop this run from history"
      >
        Reset
      </Button>
    </div>
  );
}
