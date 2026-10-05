/**
 * Keeps `useMessagesStore` current with the server's log of what ANDES said.
 *
 * The server keeps the messages (`GET /sessions/{id}/messages`) and numbers them,
 * so a read asks only for what came after the last one it has. A command's
 * messages are in the log by the time the command answers, and a streamed run's
 * arrive as it goes, so this reads when:
 *
 * - the session changes, or any job starts or ends (the jobs store changes: every
 *   command the UI sends is a job), and
 * - every `MESSAGES_POLL_MS` while a job is in flight, which is what shows a
 *   long run's events before it ends. The log answers while the worker is busy.
 *
 * It is a plain read, not a TanStack query, on purpose: a failed read is not worth
 * a retry (the next job change reads again), and a 404 here must not start a
 * session recovery. `useSessionHeartbeat` owns finding out that a session is gone.
 *
 * Mounted once from `App.tsx`, beside `useJobEventsStream`.
 */
import { useCallback, useEffect, useRef } from 'react';
import { andesClient, TIMEOUTS } from './client';
import type { SessionMessages } from './types';
import { useJobsStore, type JobRecord } from '@/store/jobs';
import { useMessagesStore } from '@/store/messages';
import { useSessionStore } from '@/store/session';

/** How often the log is read while a job is in flight. */
export const MESSAGES_POLL_MS = 1500;

/** The most messages one read asks for; a read that is cut goes on at once. */
export const MESSAGES_PAGE_SIZE = 500;

/** A bound on the reads of one catch-up, so a log that never stops growing cannot hold this forever. */
const MAX_PAGES_PER_PULL = 20;

/**
 * Read what the session's log holds that the store does not, page by page until
 * the store has caught up. Gives up quietly on an error and when the active
 * session is no longer `sessionId`, so a late answer never writes into the store
 * of the session that replaced it.
 */
export async function pullMessages(sessionId: string): Promise<void> {
  for (let page = 0; page < MAX_PAGES_PER_PULL; page += 1) {
    const held = useMessagesStore.getState();
    const after = held.sessionId === sessionId ? held.cursor : 0;
    let result: SessionMessages;
    try {
      result = await andesClient.get<SessionMessages>(
        `/sessions/${encodeURIComponent(sessionId)}/messages?after=${after}&limit=${MESSAGES_PAGE_SIZE}`,
        { timeoutMs: TIMEOUTS.sessionLifecycle },
      );
    } catch {
      return;
    }
    if (useSessionStore.getState().sessionId !== sessionId) return;
    useMessagesStore.getState().receive(sessionId, result);
    if (result.next_after >= result.last_seq) return;
  }
}

/**
 * Empty the session's log on the server and what the store holds. Resolves
 * `true` when the server did it; on a failure nothing is forgotten here either,
 * so what the tab shows is still what the server has.
 */
export async function clearSessionMessages(sessionId: string): Promise<boolean> {
  try {
    await andesClient.delete(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      timeoutMs: TIMEOUTS.sessionLifecycle,
    });
  } catch {
    return false;
  }
  if (useSessionStore.getState().sessionId === sessionId) {
    useMessagesStore.getState().clearMessages();
  }
  return true;
}

function isInFlight(job: JobRecord): boolean {
  return job.status === 'pending' || job.status === 'running';
}

/**
 * A string that changes whenever a job is added, moves from one state to
 * another or leaves the store: the count, the newest update and how many are in
 * flight. A change is the cue to read.
 */
export function jobsActivityKey(jobs: Readonly<Record<string, JobRecord>>): string {
  let count = 0;
  let inFlight = 0;
  let newest = 0;
  for (const job of Object.values(jobs)) {
    count += 1;
    if (isInFlight(job)) inFlight += 1;
    if (job.updated_at > newest) newest = job.updated_at;
  }
  return `${count}:${inFlight}:${newest}`;
}

export function useSessionMessagesSync(): void {
  const sessionId = useSessionStore((s) => s.sessionId);
  const activity = useJobsStore((s) => jobsActivityKey(s.jobs));
  const inFlight = useJobsStore((s) => Object.values(s.jobs).some(isInFlight));

  // One read at a time: a cue that arrives during a read asks for another when it
  // ends. The session is read from the store each time round, so a cue for a new
  // session that arrives during the old one's read is not lost to it.
  const reading = useRef(false);
  const again = useRef(false);
  const read = useCallback(async () => {
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        again.current = false;
        const current = useSessionStore.getState().sessionId;
        if (current !== null) await pullMessages(current);
      } while (again.current);
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read, sessionId, activity]);

  useEffect(() => {
    if (!inFlight || sessionId === null) return;
    const timer = setInterval(() => void read(), MESSAGES_POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, sessionId, read]);
}
