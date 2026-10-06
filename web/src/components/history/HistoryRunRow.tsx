/**
 * HistoryRunRow (Unit 9 of the v2.0 plan).
 *
 * Single row in the history drawer: shows the run's label ("TDS #3 -
 * fault bus 7"; the run id is on hover), state badge (streaming / done /
 * error / aborted), tf, when it started (the time, with the date in front for
 * a run kept from an earlier day), and per-row actions:
 *
 * - The pencil beside the label (or a double-click on the label) — renames the
 *   run. The name shows in the plot legend too; an empty name puts the default
 *   label back.
 * - "Pin to overlay" / "Unpin" — toggles ``overlayRunIds`` membership. The
 *   active run is plotted without it, so its button says what the pin keeps.
 * - "Delete" — drops the run from the runs slice (frees its buffers). Reset run
 *   in the top bar does not: it keeps the run, which then reads "earlier".
 *
 * The row is visually distinct for the active run (bolder border); every other
 * run is marked "earlier", the badge a run takes on once Reset run, a case
 * change, a reload of the page or a newer run has released it.
 * Sweep progress (Unit 18) extends this row with a progress bar.
 */
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';
import { useHistoryStore } from '@/store/history';
import { Button } from '@/components/ui/button';
import { RenameRunButton, RunRenameInput } from '@/components/plots/RunRename';
import { runIdToStrokeStyle } from '@/lib/runIdToColor';
import { autoRunLabel, runLabel } from '@/lib/runLabel';
import { formatTakenAt } from '@/lib/takenAt';
import { cn } from '@/lib/cn';

export interface HistoryRunRowProps {
  run: RunRecord;
  /** True when this row's run is the active anchor (SLD overlay etc.). */
  isActive: boolean;
  /** True when this run is in the overlay set. */
  isOverlayPinned: boolean;
  /** Callback fired after the user pins/unpins the run. */
  onTogglePin?: (runId: string, willBePinned: boolean) => void;
  /** Callback fired after the user deletes the run. */
  onDelete?: (runId: string) => void;
  /**
   * Callback fired after the user gives the run a new name. ``name`` is
   * ``undefined`` when the name was cleared, so the run has its default label
   * again. Not fired when the name did not change.
   */
  onRename?: (runId: string, name: string | undefined) => void;
  className?: string;
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

export function HistoryRunRow({
  run,
  isActive,
  isOverlayPinned,
  onTogglePin,
  onDelete,
  onRename,
  className,
}: HistoryRunRowProps) {
  const addOverlayRun = useRunsStore((s) => s.addOverlayRun);
  const removeOverlayRun = useRunsStore((s) => s.removeOverlayRun);
  const removeRun = useRunsStore((s) => s.removeRun);
  const setRunDisplayName = useRunsStore((s) => s.setRunDisplayName);
  // Which run is being renamed lives in the history slice, so the "Rename run"
  // command can open the field on a row it does not render.
  const renaming = useHistoryStore((s) => s.renamingRunId === run.runId);
  const startRenaming = useHistoryStore((s) => s.startRenaming);
  const stopRenaming = useHistoryStore((s) => s.stopRenaming);

  // Pick up Unit 20's per-run colour override so the history row swatch
  // matches the legend chip + plot stroke when the researcher has
  // customised the run's colour.
  const style = runIdToStrokeStyle(run.runId, run.colorOverride);

  const handleTogglePin = () => {
    const willBePinned = !isOverlayPinned;
    if (willBePinned) addOverlayRun(run.runId);
    else removeOverlayRun(run.runId);
    onTogglePin?.(run.runId, willBePinned);
  };

  const handleDelete = () => {
    removeRun(run.runId);
    onDelete?.(run.runId);
  };

  const label = runLabel(run);
  const defaultName = autoRunLabel(run);
  // A run that has ended and is no longer the active one.
  const isEarlier = !isActive && run.state !== 'starting' && run.state !== 'streaming';

  const handleRenameCommit = (next: string) => {
    stopRenaming();
    const trimmed = next.trim();
    // Leaving the field as it was (a blur, or Enter on the same name) is not a rename.
    if (trimmed === (run.displayName ?? '')) return;
    setRunDisplayName(run.runId, trimmed);
    onRename?.(run.runId, trimmed.length === 0 ? undefined : trimmed);
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
        {renaming ? (
          <>
            <RunRenameInput
              initialValue={run.displayName ?? ''}
              placeholder={defaultName}
              onCommit={handleRenameCommit}
              onCancel={stopRenaming}
              data-testid={`history-run-row-name-input-${run.runId}`}
              aria-label={`New name for ${label}`}
              className="w-full"
            />
            <span
              data-testid={`history-run-row-rename-hint-${run.runId}`}
              className="text-muted-foreground text-[10px]"
            >
              Enter saves, Esc cancels. Leave it empty to go back to {defaultName}.
            </span>
          </>
        ) : (
          // A name the researcher typed can be long, and it is the one thing on the
          // row they will read back, so it wraps instead of being cut off.
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              data-testid={`history-run-row-label-${run.runId}`}
              title={`Run id ${run.runId}`}
              onDoubleClick={() => startRenaming(run.runId)}
              className="text-foreground min-w-0 text-xs break-words"
            >
              {label}
            </span>
            <RenameRunButton
              aria-label={`Rename ${label}`}
              onClick={() => startRenaming(run.runId)}
              data-testid={`history-run-row-rename-${run.runId}`}
            />
            {isActive ? (
              <span
                data-testid={`history-run-row-active-badge-${run.runId}`}
                className="text-primary text-[10px] font-medium"
              >
                active
              </span>
            ) : isEarlier ? (
              <span
                data-testid={`history-run-row-earlier-badge-${run.runId}`}
                title="A newer run, Reset run, a case change or a reload of the page has released this run. Its results stay here until you delete them."
                className="text-muted-foreground text-[10px] font-medium"
              >
                earlier
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
        )}
        <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
          <span data-testid={`history-run-row-timestamp-${run.runId}`}>
            {formatTakenAt(run.startedAt)}
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
        // The active run is on the plot either way: its pin is what keeps it there.
        title={
          isActive
            ? isOverlayPinned
              ? 'Unpin this run. It stays on the plot while it is the active run.'
              : 'Keep this run on the plot after Reset run or the next run. The active run is plotted without a pin, beside the pinned runs.'
            : isOverlayPinned
              ? 'Take this run off the plot'
              : 'Plot this run. Pin more than one to compare them on the same plot.'
        }
      >
        {isOverlayPinned ? 'Unpin' : 'Pin'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        data-testid={`history-run-row-delete-${run.runId}`}
        title="Delete this run from history and free its memory"
      >
        Delete
      </Button>
    </div>
  );
}
