/**
 * What a time-domain run can record and command: the ANDES variables and the
 * controllers' devices of the loaded case. Both are refused with a 409 while a run
 * streams, and asked for again until it ends.
 */
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { andesClient, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import type { DaeVariableList, TdsControllerCatalogue } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';

/** A read the substrate refused because something else holds the session. */
function isSessionBusy(error: unknown): boolean {
  return error instanceof ProblemDetailsError && error.status === 409;
}

// How many times a refused list is asked for again at once, and how long it
// then waits between two tries.
const BUSY_QUICK_TRIES = 3;
const BUSY_WAIT_MS = 2_000;

/**
 * Query options for a list the substrate answers in milliseconds but refuses
 * (409) while anything else holds the session. Two such lists asked for in the
 * same moment, as the TDS tab does when it opens, collide: the one that loses
 * asks again a few times, a little later each time. While a run holds the
 * session the refusal stands, and the list is then asked for once every two
 * seconds until it comes back, so it is there again when the run ends.
 *
 * All of it is one fetch that keeps trying, so the query is never an error in
 * between and never starts over: what a caller sees for the whole of a run is
 * one state, which ``isWaitingForSession`` reads.
 */
const BUSY_READ = {
  retry: (failureCount: number, error: Error) =>
    isSessionBusy(error) || (!(error instanceof ProblemDetailsError) && failureCount < 1),
  retryDelay: (attempt: number, error: Error) =>
    isSessionBusy(error) && attempt >= BUSY_QUICK_TRIES ? BUSY_WAIT_MS : 150 * 2 ** attempt,
} as const;

/**
 * Whether a list read with ``BUSY_READ`` is being kept from its caller by
 * something that holds the session, which after the quick tries is a run. The
 * first refusals say nothing yet: another list asked for in the same moment
 * is the usual reason, and that one is over before a message could be read.
 */
export function isWaitingForSession(
  list: Pick<
    UseQueryResult<unknown, Error>,
    'isError' | 'error' | 'failureReason' | 'failureCount'
  >,
): boolean {
  // A fetch that was given up with nobody left to wait for it ends as an error.
  if (list.isError) return isSessionBusy(list.error);
  return isSessionBusy(list.failureReason) && list.failureCount > BUSY_QUICK_TRIES;
}

/**
 * `GET /sessions/{id}/dae-variables`: one page of the ANDES variables of the
 * loaded case that a TDS run can record, the ones whose names hold every word
 * of ``q``. Reads the models' own definitions, so it needs no run and does not
 * close the case to disturbances. Disabled without a session or a case; with no
 * ``q`` it lists the first ``limit`` variables.
 *
 * The session is busy while a run streams, so asking then is refused with a 409:
 * the caller shows that as a message (``isWaitingForSession``) and the list
 * comes back once the run ends (see ``BUSY_READ``).
 */
export function useDaeVariables(q: string, limit: number): UseQueryResult<DaeVariableList, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const enabled = sessionId !== null && selection !== null;
  // A blank system has no file; its list is still its own.
  const casePath = selection?.primaryPath ?? 'blank';
  return useQuery({
    queryKey: enabled
      ? queryKeys.daeVariables(sessionId, casePath, q, limit)
      : ['dae-variables', 'noop'],
    enabled,
    // What is loaded can change under the same case path (an element added or
    // deleted), so a list a few seconds old is the most to rely on.
    staleTime: 5_000,
    ...BUSY_READ,
    queryFn: async () => {
      if (!sessionId) throw new Error('useDaeVariables enabled without a session');
      return await andesClient.get<DaeVariableList>(
        `/sessions/${encodeURIComponent(sessionId)}/dae-variables`,
        {
          query: { limit: String(limit), ...(q.trim() === '' ? {} : { q: q.trim() }) },
          timeoutMs: TIMEOUTS.topology,
        },
      );
    },
  });
}

/**
 * `GET /sessions/{id}/tds/controllers`: the kinds of controller a TDS run takes
 * and the devices of the loaded case they can command (batteries and other
 * distributed generation), each with its limit and the ANDES variables that
 * show a controller at work on it. Needs no run and does not close the case to
 * disturbances. Disabled without a session or a case.
 *
 * Refused with a 409 while a run streams, as the variable list is, and asked
 * for again the same way (``BUSY_READ``).
 */
export function useTdsControllers(): UseQueryResult<TdsControllerCatalogue, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  // The batteries the element builder adds are in the topology's controllers.
  const devices = useCaseStore((s) => s.topology?.controllers?.length ?? 0);
  const enabled = sessionId !== null && selection !== null;
  const casePath = selection?.primaryPath ?? 'blank';
  return useQuery({
    queryKey: enabled
      ? queryKeys.tdsControllers(sessionId, casePath, devices)
      : ['tds-controllers', 'noop'],
    enabled,
    // A battery added in the meantime is a device to list: do not rely on an
    // old answer for long.
    staleTime: 5_000,
    ...BUSY_READ,
    queryFn: async () => {
      if (!sessionId) throw new Error('useTdsControllers enabled without a session');
      return await andesClient.get<TdsControllerCatalogue>(
        `/sessions/${encodeURIComponent(sessionId)}/tds/controllers`,
        { timeoutMs: TIMEOUTS.topology },
      );
    },
  });
}
