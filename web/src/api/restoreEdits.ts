/**
 * The pieces ``useSessionRecovery`` uses to rebuild a lost session's edits in its
 * replacement: recreate a blank system, replay the edit journal, and fold the
 * result into the stores and the query cache. The journal and the replay are
 * documented in ``store/editJournal.ts`` and ``replayJournal.ts``.
 */
import type { QueryClient } from '@tanstack/react-query';
import { andesClient, ProblemDetailsError, TIMEOUTS } from './client';
import { queryKeys } from './queries';
import { replayJournal, retryWhileBusy } from './replayJournal';
import type { ReplayOutcome } from './replayJournal';
import type { BlankSystemResponse, SessionId } from './types';
import { useCaseStore } from '@/store/case';
import { isWorkOp, useEditJournalStore } from '@/store/editJournal';
import type { JournalEntry } from '@/store/editJournal';
import { toast } from '@/lib/toast';

/**
 * ``POST /sessions/{id}/blank`` into the replacement session, seeding the topology
 * cache with the empty system the way the New system button does. Throws when the
 * substrate refuses.
 */
export async function recreateBlankSystem(
  sessionId: SessionId,
  queryClient: QueryClient,
): Promise<void> {
  const response = await retryWhileBusy(() =>
    andesClient.post<BlankSystemResponse>(`/sessions/${encodeURIComponent(sessionId)}/blank`, {
      body: {},
      timeoutMs: TIMEOUTS.workspace,
    }),
  );
  queryClient.setQueryData(queryKeys.topology(sessionId), response.topology);
  useCaseStore.getState().setTopology(response.topology);
}

/**
 * Replay ``entries`` into the replacement session, then bring the client in line
 * with what the session now holds: the journal is cut back to the entries that
 * were applied (a refused one ends the replay, and later entries would build on a
 * session that lacks it), the clone-on-write flags and stack depths come from the
 * last clone response, and the topology and clone-diff queries are refetched.
 */
export async function replayEditsInto(
  sessionId: SessionId,
  queryClient: QueryClient,
  entries: readonly JournalEntry[],
): Promise<ReplayOutcome> {
  const outcome = await replayJournal(sessionId, entries);
  if (outcome.error !== null) {
    useEditJournalStore.getState().truncateAfter(outcome.appliedThroughRev ?? 0);
  }
  const clone = outcome.clone;
  useCaseStore.setState({
    cloneInitialized: clone?.initialized ?? false,
    cloneUndoDepth: clone?.undoDepth ?? 0,
    cloneRedoDepth: clone?.redoDepth ?? 0,
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
  void queryClient.invalidateQueries({ queryKey: ['clone-diff', sessionId] });
  return outcome;
}

/** What the substrate said when it refused a replayed request, for a toast. */
function describeReplayError(err: unknown): string {
  if (err instanceof ProblemDetailsError) return err.detail ?? err.title;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

/** "1 change", "12 changes". */
function changeCount(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}

/**
 * Tell the user how the replay went. Only the user's own work is counted (a reload
 * or Edit mode being switched on is not a change), and a replay with none says
 * nothing: the user lost nothing, so there is nothing to report.
 *
 * ``target`` completes "replayed onto ...".
 */
export function reportReplay(
  outcome: ReplayOutcome,
  entries: readonly JournalEntry[],
  target: string,
): void {
  const total = entries.filter(isWorkOp).length;
  if (outcome.error === null) {
    if (total === 0) return;
    toast.success('Edits restored', {
      description: `The session expired. ${changeCount(total)} replayed onto ${target}.`,
    });
    return;
  }
  const done = entries.slice(0, outcome.applied).filter(isWorkOp).length;
  toast.warning('Some edits could not be restored', {
    description: `Restored ${done} of ${changeCount(total)} onto ${target} before the server refused one: ${describeReplayError(outcome.error)}. The changes after it are gone.`,
  });
}
