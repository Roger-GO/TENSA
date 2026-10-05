/**
 * Messages slice. What ANDES said while the session's commands ran, as the
 * server's log holds it (`GET /sessions/{id}/messages`), plus what the Messages
 * tab is set to show of it.
 *
 * The slice holds the messages of ONE session, `sessionId`. The sync hook
 * (`api/useSessionMessages.ts`) reads on from `cursor`, the server's own number
 * for "everything up to here", so each read brings only what is new; `receive`
 * folds a page in and drops what the server no longer holds (it keeps the latest
 * 2000, and a clear on another tab empties it). A page that belongs to another
 * session starts the slice over. A message that repeats the newest one is not kept
 * twice: the server adds the repeat to it and numbers it again, so a page that
 * brings it again replaces the one held, count and all.
 *
 * Not persisted: the messages describe the live server session, which a reload
 * replaces. The level and text filters are in-memory too, so they last as long as
 * the tab does and not across a reload, like the grid filters.
 */
import { create } from 'zustand';
import type { MessageLevel, SessionMessage, SessionMessages } from '@/api/types';

/** The most messages kept here; the server keeps the same number. */
export const MAX_MESSAGES = 2000;

/**
 * Whether `later` is `held` again with a larger repeat count. The server keeps a
 * message that repeats the newest one as a single message, so a held message and
 * a newer one that say the same thing are the same message at two moments.
 */
function isLaterCountOf(later: SessionMessage, held: SessionMessage): boolean {
  return (
    later.repeat > held.repeat &&
    later.level === held.level &&
    later.logger === held.logger &&
    later.source === held.source &&
    later.text === held.text
  );
}

/** Warnings and errors show at first; the information messages are how each run went. */
export const DEFAULT_SHOWN_LEVELS: Readonly<Record<MessageLevel, boolean>> = {
  info: false,
  warning: true,
  error: true,
};

export interface MessagesState {
  /** The session the messages belong to, or null before the first read. */
  sessionId: string | null;
  /** Oldest first. */
  messages: readonly SessionMessage[];
  /** The `after` of the next read: the server's `next_after` of the last one. */
  cursor: number;
  /** Messages the server lost to its caps over the session. */
  dropped: number;
  /**
   * How many times the messages were cleared here. A read that began before a clear
   * brings messages the clear removed, so `pullMessages` compares it before and after.
   */
  clears: number;
  /** Which levels the tab lists. */
  shownLevels: Readonly<Record<MessageLevel, boolean>>;
  /** The words the tab's filter box holds. */
  query: string;

  /** Fold a page the server returned for `sessionId` into the slice. */
  receive: (sessionId: string, page: SessionMessages) => void;
  /** Forget the messages held, keeping the place the next read goes on from, and count the clear. */
  clearMessages: () => void;
  /** Forget everything, for a session that is gone. */
  reset: () => void;
  setLevelShown: (level: MessageLevel, shown: boolean) => void;
  setQuery: (query: string) => void;
}

export const useMessagesStore = create<MessagesState>((set) => ({
  sessionId: null,
  messages: [],
  cursor: 0,
  dropped: 0,
  clears: 0,
  shownLevels: DEFAULT_SHOWN_LEVELS,
  query: '',

  receive: (sessionId, page) =>
    set((state) => {
      const held = state.sessionId === sessionId ? state.messages : [];
      const lastHeld = held.length > 0 ? held[held.length - 1]!.seq : 0;
      // Two reads that overlap bring the same message twice; keep it once.
      const fresh = page.messages.filter((m) => m.seq > lastHeld);
      const kept = held.filter((m) => m.seq >= page.first_seq);
      // The newest message, said again with a larger count, comes back under a new number.
      const newest = kept[kept.length - 1];
      const again = fresh[0];
      if (newest !== undefined && again !== undefined && isLaterCountOf(again, newest)) kept.pop();
      const merged = [...kept, ...fresh];
      return {
        sessionId,
        messages:
          merged.length > MAX_MESSAGES ? merged.slice(merged.length - MAX_MESSAGES) : merged,
        cursor: page.next_after,
        dropped: page.dropped,
      };
    }),

  clearMessages: () => set((state) => ({ messages: [], clears: state.clears + 1 })),

  reset: () => set({ sessionId: null, messages: [], cursor: 0, dropped: 0 }),

  setLevelShown: (level, shown) =>
    set((state) => ({ shownLevels: { ...state.shownLevels, [level]: shown } })),

  setQuery: (query) => set({ query }),
}));
