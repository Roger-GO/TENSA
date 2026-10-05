/**
 * The messages slice: how pages from the server are folded in, and what a session
 * change, a clear and the cap do to what it holds.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionMessage, SessionMessages } from '@/api/types';
import { DEFAULT_SHOWN_LEVELS, MAX_MESSAGES, useMessagesStore } from '@/store/messages';

function message(seq: number, text = `message ${seq}`): SessionMessage {
  return {
    seq,
    time: 1_700_000_000 + seq,
    level: 'info',
    logger: 'andes.test',
    source: 'run_pflow',
    text,
    repeat: 1,
  };
}

function page(
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

const seqs = () => useMessagesStore.getState().messages.map((m) => m.seq);

beforeEach(() => {
  useMessagesStore.getState().reset();
  useMessagesStore.setState({ shownLevels: DEFAULT_SHOWN_LEVELS, query: '' });
});

describe('useMessagesStore', () => {
  it('starts empty, listing warnings and errors but not information', () => {
    const state = useMessagesStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.sessionId).toBeNull();
    expect(state.cursor).toBe(0);
    expect(state.shownLevels).toEqual({ info: false, warning: true, error: true });
  });

  it('adds what a page brings, after what it holds, and remembers where to read on from', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1), message(2)]));
    receive('s1', page([message(3)], { first_seq: 1 }));

    expect(seqs()).toEqual([1, 2, 3]);
    expect(useMessagesStore.getState().cursor).toBe(3);
    expect(useMessagesStore.getState().sessionId).toBe('s1');
  });

  it('keeps a message once when two reads brought it', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1), message(2)]));
    receive('s1', page([message(2), message(3)], { first_seq: 1 }));
    expect(seqs()).toEqual([1, 2, 3]);
  });

  it('replaces the newest message when the server brings it again with a larger count', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1), message(2, 'Time step reduced')]));
    // The server added a repeat to its newest message and numbered it again.
    receive('s1', page([{ ...message(3, 'Time step reduced'), repeat: 40 }], { first_seq: 1 }));

    const held = useMessagesStore.getState().messages;
    expect(held.map((m) => [m.seq, m.repeat])).toEqual([
      [1, 1],
      [3, 40],
    ]);
    expect(useMessagesStore.getState().cursor).toBe(3);
  });

  it('replaces a message that is the only one the server holds, whose number moved past it', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1, 'Time step reduced')]));
    receive('s1', page([{ ...message(2, 'Time step reduced'), repeat: 6 }]));
    expect(useMessagesStore.getState().messages.map((m) => [m.seq, m.repeat])).toEqual([[2, 6]]);
  });

  it('keeps both when a newer message only looks like the newest one held', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1, 'same'), message(2, 'same text, other message')]));
    // Same words but not the newest one held, a count that did not grow, or another command.
    receive('s1', page([message(3, 'same')], { first_seq: 1 }));
    receive('s1', page([message(4, 'same')], { first_seq: 1 }));
    receive(
      's1',
      page([{ ...message(5, 'same'), source: 'run_tds', repeat: 9 }], { first_seq: 1 }),
    );
    expect(seqs()).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops the messages the server no longer holds', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1), message(2), message(3)]));
    receive('s1', page([message(4)], { first_seq: 3, dropped: 2 }));
    expect(seqs()).toEqual([3, 4]);
    expect(useMessagesStore.getState().dropped).toBe(2);
  });

  it('empties what it holds when the server was cleared from elsewhere', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1), message(2)]));
    // Cleared on another tab: nothing held, the next message to come is 3.
    receive('s1', page([], { first_seq: 3, last_seq: 2, next_after: 2 }));
    expect(seqs()).toEqual([]);
    receive('s1', page([message(3)], { first_seq: 3 }));
    expect(seqs()).toEqual([3]);
  });

  it('starts over for another session', () => {
    const { receive } = useMessagesStore.getState();
    receive('s1', page([message(1), message(2)]));
    receive('s2', page([message(1, 'from the second session')]));

    expect(useMessagesStore.getState().sessionId).toBe('s2');
    expect(useMessagesStore.getState().messages.map((m) => m.text)).toEqual([
      'from the second session',
    ]);
    expect(useMessagesStore.getState().cursor).toBe(1);
  });

  it('keeps only the latest messages past the cap', () => {
    const many = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => message(i + 1));
    useMessagesStore.getState().receive('s1', page(many, { first_seq: 1 }));
    const held = useMessagesStore.getState().messages;
    expect(held).toHaveLength(MAX_MESSAGES);
    expect(held[0]!.seq).toBe(6);
    expect(held[held.length - 1]!.seq).toBe(MAX_MESSAGES + 5);
  });

  it('clearing forgets the messages but not the place to read on from', () => {
    const { receive, clearMessages } = useMessagesStore.getState();
    receive('s1', page([message(1), message(2)]));
    clearMessages();

    expect(useMessagesStore.getState().messages).toEqual([]);
    expect(useMessagesStore.getState().cursor).toBe(2);
    expect(useMessagesStore.getState().sessionId).toBe('s1');
    expect(useMessagesStore.getState().clears).toBe(1);
    // A read from the old place brings only what is new.
    useMessagesStore.getState().receive('s1', page([message(3)], { first_seq: 3 }));
    expect(seqs()).toEqual([3]);
  });

  it('reset forgets everything for a session that is gone', () => {
    useMessagesStore.getState().receive('s1', page([message(1)], { dropped: 4 }));
    useMessagesStore.getState().reset();
    const state = useMessagesStore.getState();
    expect([state.sessionId, state.messages, state.cursor, state.dropped]).toEqual([
      null,
      [],
      0,
      0,
    ]);
  });

  it('keeps the level and filter choices through a reset, which is about the session', () => {
    const { setLevelShown, setQuery } = useMessagesStore.getState();
    setLevelShown('info', true);
    setQuery('power');
    useMessagesStore.getState().reset();
    expect(useMessagesStore.getState().shownLevels.info).toBe(true);
    expect(useMessagesStore.getState().query).toBe('power');
  });

  it('turns a level on and off without touching the others', () => {
    useMessagesStore.getState().setLevelShown('info', true);
    useMessagesStore.getState().setLevelShown('error', false);
    expect(useMessagesStore.getState().shownLevels).toEqual({
      info: true,
      warning: true,
      error: false,
    });
  });
});
