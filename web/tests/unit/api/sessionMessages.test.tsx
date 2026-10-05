/**
 * Keeping the messages store current with the server's log.
 *
 * ``pullMessages`` reads what the store lacks (page by page), ``clearSessionMessages``
 * empties the log, and ``useSessionMessagesSync`` decides when to read: at a new
 * session, whenever a job starts or ends, and on a timer while one is in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  MESSAGES_PAGE_SIZE,
  MESSAGES_POLL_MS,
  clearSessionMessages,
  jobsActivityKey,
  pullMessages,
  useSessionMessagesSync,
} from '@/api/useSessionMessages';
import { parseSessionId, type SessionMessage, type SessionMessages } from '@/api/types';
import { useJobsStore } from '@/store/jobs';
import { DEFAULT_SHOWN_LEVELS, useMessagesStore } from '@/store/messages';
import { useSessionStore } from '@/store/session';

function message(seq: number, level: SessionMessage['level'] = 'info'): SessionMessage {
  return {
    seq,
    time: 1_700_000_000 + seq,
    level,
    logger: 'andes.test',
    source: 'run_pflow',
    text: `message ${seq}`,
    repeat: 1,
  };
}

function pageOf(
  messages: SessionMessage[],
  overrides: Partial<SessionMessages> = {},
): SessionMessages {
  const last = messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
  return {
    messages,
    first_seq: messages.length > 0 ? messages[0]!.seq : 1,
    last_seq: last,
    next_after: last,
    dropped: 0,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The read URLs the fetch spy has seen, in order. */
function reads(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes('/messages?'))
    .map((url) => url.slice(url.indexOf('/api')));
}

const SESSION = 'sess-abc';

function resetStores(): void {
  useSessionStore.setState({ sessionId: null });
  useJobsStore.getState().clearJobs();
  useMessagesStore.getState().reset();
  useMessagesStore.setState({ shownLevels: DEFAULT_SHOWN_LEVELS, query: '' });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStores();
  fetchSpy = vi
    .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
    .mockImplementation(async () => json(pageOf([]))) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  vi.useRealTimers();
  resetStores();
});

describe('pullMessages', () => {
  it('reads from the start the first time and puts what came into the store', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    fetchSpy.mockImplementation(async () => json(pageOf([message(1), message(2, 'warning')])));

    await pullMessages(SESSION);

    expect(reads(fetchSpy)).toEqual([
      `/api/sessions/${SESSION}/messages?after=0&limit=${MESSAGES_PAGE_SIZE}`,
    ]);
    expect(useMessagesStore.getState().messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(useMessagesStore.getState().sessionId).toBe(SESSION);
  });

  it('reads on from the last number it has, so a read brings only what is new', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    useMessagesStore.getState().receive(SESSION, pageOf([message(1), message(2)]));
    fetchSpy.mockImplementation(async () => json(pageOf([message(3)], { first_seq: 1 })));

    await pullMessages(SESSION);

    expect(reads(fetchSpy)).toEqual([
      `/api/sessions/${SESSION}/messages?after=2&limit=${MESSAGES_PAGE_SIZE}`,
    ]);
    expect(useMessagesStore.getState().messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('keeps reading while a read was cut at its limit, and stops once it has caught up', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    const answers = [
      pageOf([message(1), message(2)], { last_seq: 5, next_after: 2 }),
      pageOf([message(3), message(4)], { first_seq: 1, last_seq: 5, next_after: 4 }),
      pageOf([message(5)], { first_seq: 1, last_seq: 5, next_after: 5 }),
    ];
    fetchSpy.mockImplementation(async () => json(answers.shift() ?? pageOf([])));

    await pullMessages(SESSION);

    expect(reads(fetchSpy).map((url) => /after=(\d+)/.exec(url)?.[1])).toEqual(['0', '2', '4']);
    expect(useMessagesStore.getState().messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts from the beginning again for a different session than the store holds', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-new') });
    useMessagesStore.getState().receive(SESSION, pageOf([message(1), message(2)]));

    await pullMessages('sess-new');

    expect(reads(fetchSpy)[0]).toContain('/sess-new/messages?after=0&');
  });

  it('puts nothing in the store when the session changed while it was reading', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    fetchSpy.mockImplementation(async () => {
      useSessionStore.setState({ sessionId: parseSessionId('sess-next') });
      return json(pageOf([message(1)]));
    });

    await pullMessages(SESSION);

    expect(useMessagesStore.getState().messages).toEqual([]);
  });

  it('gives up quietly on an error, a missing session included', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    fetchSpy.mockImplementation(async () =>
      json({ title: 'Not Found', status: 404, detail: 'session is not active' }, 404),
    );

    await expect(pullMessages(SESSION)).resolves.toBeUndefined();

    expect(useMessagesStore.getState().messages).toEqual([]);
    // A 404 here is not a recovery trigger: the heartbeat owns finding out a session is gone.
    expect(useSessionStore.getState().recoveryInProgress).toBe(false);
  });
});

describe('clearSessionMessages', () => {
  it('empties the server’s log and then what the store holds', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    useMessagesStore.getState().receive(SESSION, pageOf([message(1), message(2)]));
    fetchSpy.mockImplementation(async () => json(null, 204));

    await expect(clearSessionMessages(SESSION)).resolves.toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/sessions/${SESSION}/messages`);
    expect(init.method).toBe('DELETE');
    expect(useMessagesStore.getState().messages).toEqual([]);
    expect(useMessagesStore.getState().cursor).toBe(2);
  });

  it('leaves the messages on screen when the server could not clear them', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    useMessagesStore.getState().receive(SESSION, pageOf([message(1)]));
    fetchSpy.mockImplementation(async () => json({ title: 'boom', status: 500 }, 500));

    await expect(clearSessionMessages(SESSION)).resolves.toBe(false);

    expect(useMessagesStore.getState().messages).toHaveLength(1);
  });
});

describe('jobsActivityKey', () => {
  it('changes when a job is added and when it ends, and not otherwise', () => {
    const store = useJobsStore.getState();
    const empty = jobsActivityKey(useJobsStore.getState().jobs);

    const id = store.addJob({ kind: 'pflow', status: 'running' });
    const started = jobsActivityKey(useJobsStore.getState().jobs);
    expect(started).not.toBe(empty);
    expect(jobsActivityKey(useJobsStore.getState().jobs)).toBe(started);

    store.updateJob(id, { status: 'done', updated_at: Date.now() / 1000 + 5 });
    expect(jobsActivityKey(useJobsStore.getState().jobs)).not.toBe(started);
  });
});

describe('useSessionMessagesSync', () => {
  async function settle(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await vi.advanceTimersByTimeAsync(5);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('reads nothing while there is no session', async () => {
    renderHook(() => useSessionMessagesSync());
    await settle(MESSAGES_POLL_MS * 3);
    expect(reads(fetchSpy)).toEqual([]);
  });

  it('reads at once when a session exists, and then waits for a job to do it again', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    renderHook(() => useSessionMessagesSync());

    await settle();
    expect(reads(fetchSpy)).toHaveLength(1);

    // Nothing is running, so time passing reads nothing.
    await settle(MESSAGES_POLL_MS * 5);
    expect(reads(fetchSpy)).toHaveLength(1);
  });

  it('reads when a job starts and again when it ends, which is when its messages are in', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    renderHook(() => useSessionMessagesSync());
    await settle();
    expect(reads(fetchSpy)).toHaveLength(1);

    let id = '';
    act(() => {
      id = useJobsStore.getState().addJob({ kind: 'pflow', status: 'running' });
    });
    await settle();
    expect(reads(fetchSpy)).toHaveLength(2);

    fetchSpy.mockImplementation(async () => json(pageOf([message(1, 'warning')])));
    act(() => {
      useJobsStore.getState().updateJob(id, { status: 'done' });
    });
    await settle();
    expect(reads(fetchSpy)).toHaveLength(3);
    expect(useMessagesStore.getState().messages.map((m) => m.text)).toEqual(['message 1']);
  });

  it('reads every interval while a job is in flight and stops when it is over', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    renderHook(() => useSessionMessagesSync());
    await settle();

    let id = '';
    act(() => {
      id = useJobsStore.getState().addJob({ kind: 'tds-stream', status: 'running' });
    });
    await settle();
    const afterStart = reads(fetchSpy).length;

    await settle(MESSAGES_POLL_MS);
    await settle(MESSAGES_POLL_MS);
    expect(reads(fetchSpy).length).toBe(afterStart + 2);

    act(() => {
      useJobsStore.getState().updateJob(id, { status: 'done' });
    });
    await settle();
    const afterEnd = reads(fetchSpy).length;
    await settle(MESSAGES_POLL_MS * 4);
    expect(reads(fetchSpy).length).toBe(afterEnd);
  });

  it('does not start a second read while one is in progress, and asks again when it ends', async () => {
    useSessionStore.setState({ sessionId: parseSessionId(SESSION) });
    let release: () => void = () => undefined;
    let first = true;
    fetchSpy.mockImplementation(async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return json(pageOf([]));
    });
    renderHook(() => useSessionMessagesSync());
    await settle();
    expect(reads(fetchSpy)).toHaveLength(1);

    // Two cues while the first read is out: still one read in flight.
    act(() => {
      useJobsStore.getState().addJob({ kind: 'pflow', status: 'running' });
    });
    act(() => {
      useJobsStore.getState().addJob({ kind: 'eig', status: 'running' });
    });
    await settle();
    expect(reads(fetchSpy)).toHaveLength(1);

    release();
    await settle();
    // The cues are answered by one more read, not two.
    expect(reads(fetchSpy)).toHaveLength(2);
  });
});
