/**
 * Reset run, as the top bar's run button and the bar above a table do it: the
 * case is reloaded, and a toast says what became of the run that was released
 * and of the edits a case file's reload loses. One hook, so the same click
 * says the same thing wherever it is made.
 */
import { useCallback } from 'react';
import { useResetRun } from '@/api/queries';
import { describeError } from '@/lib/describeError';
import { runLabel } from '@/lib/runLabel';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';

/** What a reload of a case file costs a session that has edited it, and the way round it. */
export const EDITS_DISCARDED =
  'The reload reads the case from its file again, so the elements you added, changed or deleted since it was opened are gone. To keep such edits, save the system first.';

/**
 * Whether a reload now loses edits. A case file's reload is the file again, so
 * what was added, changed or deleted since it was opened goes with it (the
 * topology names the newest such edit as `undo`). A system built from scratch
 * has no file and keeps its edits through a reload.
 */
export function useReloadDiscardsEdits(): boolean {
  return useCaseStore((s) => s.topology?.undo != null && s.selection?.blank !== true);
}

export interface ResetRunOptions {
  /** The title of the toast when the reload fails. */
  errorTitle: string;
  /**
   * Say that the run was reset even when there is no run to point to in History
   * and no edit was lost: for a button that is gone once the reset is done, where
   * nothing else answers the click.
   */
  confirm?: boolean;
}

export interface ResetRunAction {
  reset: () => void;
  isPending: boolean;
}

export function useResetRunAction({
  errorTitle,
  confirm = false,
}: ResetRunOptions): ResetRunAction {
  const sessionId = useSessionStore((s) => s.sessionId);
  const activeRun = useRunsStore((s) =>
    s.activeRunId === null ? null : (s.runs[s.activeRunId] ?? null),
  );
  const reloadDiscardsEdits = useReloadDiscardsEdits();
  const resetRun = useResetRun();
  const { mutate } = resetRun;

  const reset = useCallback(() => {
    if (!sessionId) return;
    // "Reset" reads as a delete, so say where the run it releases went.
    const kept = activeRun === null ? null : runLabel(activeRun);
    // As the topology says before the reload answers with a new one.
    const discarded = reloadDiscardsEdits;
    mutate(sessionId, {
      onSuccess: () => {
        if (discarded) {
          toast.warning('Edits discarded', { description: EDITS_DISCARDED, duration: 10000 });
        }
        if (kept !== null) {
          toast.info(`${kept} stays in History`, {
            description: 'Run again, then pin both runs in History to overlay them.',
          });
        } else if (confirm && !discarded) {
          toast.info('Run reset', {
            description: 'The results are cleared and the values can be changed again.',
          });
        }
      },
      onError: (err) => {
        toast.error(errorTitle, { description: `Could not reset: ${describeError(err)}` });
      },
    });
  }, [sessionId, activeRun, reloadDiscardsEdits, mutate, confirm, errorTitle]);

  return { reset, isPending: resetRun.isPending };
}
