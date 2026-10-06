/**
 * Re-send a session's recorded edits to a fresh session.
 *
 * ``useSessionRecovery`` calls this after it has loaded the case (or created the
 * blank system) into the replacement session, with the entries the edit journal
 * (``store/editJournal.ts``) holds. Each entry becomes the request that made it,
 * sent one at a time and in order: the substrate answers an add, an undo, a redo
 * or a reload the way it did the first time, so the rebuilt session ends up where
 * the lost one was without this module knowing what any operation does.
 *
 * It stops at the first request the substrate refuses (a model it no longer
 * accepts, a session that vanished again), after retrying one that found the session
 * busy. The result says how far it got, so the
 * caller can tell the user and cut the journal back to what the session now holds.
 *
 * The calls go straight through ``andesClient`` rather than the mutation hooks:
 * the hooks would record each one in the journal again, and a replay must not
 * change what it is replaying.
 */
import { andesClient, ProblemDetailsError, TIMEOUTS } from './client';
import type { CloneEditResponse, SessionId } from './types';
import type { JournalEntry } from '@/store/editJournal';

/** Where the clone-on-write state stands after the replay, from its last response. */
export interface ReplayedCloneState {
  initialized: boolean;
  undoDepth: number;
  redoDepth: number;
}

export interface ReplayOutcome {
  /** How many entries were applied: all of them unless ``error`` is set. */
  applied: number;
  total: number;
  /** What stopped the replay, or ``null`` when every entry went through. */
  error: unknown;
  /** ``rev`` of the last entry applied, or ``null`` when none was. */
  appliedThroughRev: number | null;
  /** The clone-on-write state, or ``null`` when no clone operation was replayed. */
  clone: ReplayedCloneState | null;
}

/** How long to wait before each retry of a request the substrate found the session busy for. */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

/**
 * Run ``request``, trying again while the substrate answers 409 "session is busy".
 *
 * A session serves one operation at a time and refuses the rest at once, so a read
 * the UI happens to send (a list refreshing, a panel opening) can make a replayed
 * edit fail for no reason of its own. That clears in moments, so the edit is sent
 * again after each delay in ``delaysMs`` before it counts as refused. Any other error
 * ends it at once.
 */
export async function retryWhileBusy<T>(
  request: () => Promise<T>,
  delaysMs: readonly number[] = BUSY_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (err) {
      const busy =
        err instanceof ProblemDetailsError &&
        err.status === 409 &&
        err.recovery?.kind === 'wait-for-job';
      const delay = delaysMs[attempt];
      if (!busy || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function send(sessionId: SessionId, entry: JournalEntry): Promise<unknown> {
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  const element = (model: string, idx: string) =>
    `${base}/elements/${encodeURIComponent(model)}/${encodeURIComponent(idx)}`;
  switch (entry.op) {
    case 'add':
      return await andesClient.post(`${base}/elements`, {
        body: { model: entry.model, params: entry.params },
        timeoutMs: TIMEOUTS.workspace,
      });
    case 'edit':
      return await andesClient.put(element(entry.model, entry.idx), {
        body: { params: entry.params },
        timeoutMs: TIMEOUTS.workspace,
      });
    case 'delete':
      // A delete, an undo and a redo each build the system again from the
      // case file, as a reload does.
      return await andesClient.delete(element(entry.model, entry.idx), {
        timeoutMs: TIMEOUTS.caseLoad,
        query: entry.cascade === true ? { cascade: 'true' } : undefined,
      });
    case 'undo':
      return await andesClient.post(`${base}/undo-last-edit`, {
        body: {},
        timeoutMs: TIMEOUTS.caseLoad,
      });
    case 'redo':
      return await andesClient.post(`${base}/redo-edit`, {
        body: {},
        timeoutMs: TIMEOUTS.caseLoad,
      });
    case 'reload':
      return await andesClient.post(`${base}/reload`, { body: {}, timeoutMs: TIMEOUTS.caseLoad });
    case 'clone-init':
      return await andesClient.post(`${base}/case/clone`, {
        body: {},
        timeoutMs: TIMEOUTS.caseLoad,
      });
    case 'clone-edit':
      return await andesClient.put<CloneEditResponse>(
        `${base}/case/clone/params/${encodeURIComponent(entry.model)}/${encodeURIComponent(entry.idx)}/${encodeURIComponent(entry.param)}`,
        { body: { value: entry.value }, timeoutMs: TIMEOUTS.caseLoad },
      );
    case 'clone-undo':
      return await andesClient.post<CloneEditResponse>(`${base}/case/clone/undo`, {
        body: {},
        timeoutMs: TIMEOUTS.caseLoad,
      });
    case 'clone-redo':
      return await andesClient.post<CloneEditResponse>(`${base}/case/clone/redo`, {
        body: {},
        timeoutMs: TIMEOUTS.caseLoad,
      });
    case 'clone-reset':
      return await andesClient.post(`${base}/case/clone/reset`, {
        body: {},
        timeoutMs: TIMEOUTS.caseLoad,
      });
  }
}

/**
 * Apply ``entries`` to ``sessionId`` in order. Never throws: a refused request
 * ends the replay and comes back as ``error``.
 */
export async function replayJournal(
  sessionId: SessionId,
  entries: readonly JournalEntry[],
  busyRetryDelaysMs: readonly number[] = BUSY_RETRY_DELAYS_MS,
): Promise<ReplayOutcome> {
  const outcome: ReplayOutcome = {
    applied: 0,
    total: entries.length,
    error: null,
    appliedThroughRev: null,
    clone: null,
  };
  for (const entry of entries) {
    let response: unknown;
    try {
      response = await retryWhileBusy(() => send(sessionId, entry), busyRetryDelaysMs);
    } catch (err) {
      outcome.error = err;
      return outcome;
    }
    outcome.applied += 1;
    outcome.appliedThroughRev = entry.rev;
    if (entry.op === 'clone-init') {
      outcome.clone = { undoDepth: 0, redoDepth: 0, ...outcome.clone, initialized: true };
    } else if (entry.op === 'clone-reset') {
      outcome.clone = { initialized: false, undoDepth: 0, redoDepth: 0 };
    } else if (
      entry.op === 'clone-edit' ||
      entry.op === 'clone-undo' ||
      entry.op === 'clone-redo'
    ) {
      const depths = response as CloneEditResponse;
      outcome.clone = {
        initialized: true,
        undoDepth: depths.undo_depth,
        redoDepth: depths.redo_depth,
      };
    }
  }
  return outcome;
}
