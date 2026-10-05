/**
 * MessagesPanel.
 *
 * Bottom-drawer "Messages" tab: what ANDES said while the session's commands ran.
 * A power flow that stopped short of its limit, a device whose initialisation
 * failed, a limit ANDES did not adjust, a fault applied at t = 2 s: ANDES logs
 * them all, and until this tab nothing showed them. Each message carries its
 * level (error, warning or information), the command that was running and the
 * time; a table ANDES logged keeps its lines.
 *
 * Warnings and errors show at first. The information messages are how each run
 * went (iteration counts, the case file read), and a button on each level's count
 * adds them. A filter box narrows the list to the messages that hold every word
 * typed (in the text, the command or the ANDES module). Copy puts the messages on
 * show on the clipboard as text; Clear empties the server's log as well as the
 * tab. The list stays at the newest message while it is scrolled to the end and
 * leaves the reader's place alone otherwise.
 *
 * The messages come from `useMessagesStore`, kept current by
 * `useSessionMessagesSync` (mounted once at the app root).
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { clearSessionMessages, pullMessages } from '@/api/useSessionMessages';
import type { MessageLevel, SessionMessage } from '@/api/types';
import { Button } from '@/components/ui/button';
import { EmptyState, InboxIcon } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import {
  LEVEL_LABEL,
  MESSAGE_LEVELS,
  countByLevel,
  formatMessageTime,
  messagesToText,
  sourceLabel,
  visibleMessages,
} from '@/lib/messages';
import { toast } from '@/lib/toast';
import { useMessagesStore } from '@/store/messages';
import { useSessionStore } from '@/store/session';

/** How close to the end the list must be scrolled for new messages to keep it there. */
const STICK_TO_END_PX = 24;

/** What a level's toggle says: the plural, which is what its count counts. */
const LEVEL_TOGGLE_LABEL: Record<MessageLevel, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};

const LEVEL_PILL: Record<MessageLevel, string> = {
  info: 'bg-muted text-muted-foreground',
  warning: 'bg-warning/20 text-foreground',
  error: 'bg-danger/15 text-danger',
};

const LEVEL_ROW: Record<MessageLevel, string> = {
  info: '',
  warning: 'bg-warning/5',
  error: 'bg-danger/5',
};

const LEVEL_DOT: Record<MessageLevel, string> = {
  info: 'bg-muted-foreground/60',
  warning: 'bg-warning',
  error: 'bg-danger',
};

function messageCount(n: number): string {
  return `${n} message${n === 1 ? '' : 's'}`;
}

function MessageRow({ message }: { message: SessionMessage }) {
  const source = sourceLabel(message.source);
  return (
    <div
      data-testid="message-row"
      data-level={message.level}
      data-seq={message.seq}
      className={cn(
        'border-border grid grid-cols-[4.25rem_4.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b px-2 py-1',
        'sm:grid-cols-[4.25rem_4.5rem_7rem_minmax(0,1fr)]',
        LEVEL_ROW[message.level],
      )}
    >
      <span
        className="text-muted-foreground tabular-nums"
        title={new Date(message.time * 1000).toLocaleString()}
      >
        {formatMessageTime(message.time)}
      </span>
      <span>
        <span
          className={cn(
            'inline-block rounded-[var(--radius-sm)] px-1.5 font-sans text-[10px] leading-4 font-medium',
            LEVEL_PILL[message.level],
          )}
        >
          {LEVEL_LABEL[message.level]}
        </span>
      </span>
      <span
        className="text-muted-foreground hidden truncate sm:block"
        title={message.logger}
        data-testid="message-source"
      >
        {source}
      </span>
      <div className="min-w-0 break-words whitespace-pre-wrap" data-testid="message-text">
        {message.text}
        {message.repeat > 1 ? (
          <span
            className="text-muted-foreground ml-1.5 font-sans text-[10px]"
            data-testid="message-repeat"
            title={`ANDES said this ${message.repeat} times in a row`}
          >
            ×{message.repeat}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LevelToggle({
  level,
  count,
  shown,
  onToggle,
}: {
  level: MessageLevel;
  count: number;
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={shown}
      onClick={onToggle}
      data-testid={`messages-level-${level}`}
      title={`${shown ? 'Hide' : 'Show'} the ${LEVEL_TOGGLE_LABEL[level].toLowerCase()}`}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-xs',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        shown ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60',
      )}
    >
      <span aria-hidden="true" className={cn('size-2 rounded-full', LEVEL_DOT[level])} />
      <span>{LEVEL_TOGGLE_LABEL[level]}</span>
      <span className="tabular-nums" data-testid={`messages-level-${level}-count`}>
        {count}
      </span>
    </button>
  );
}

export function MessagesPanel() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const messages = useMessagesStore((s) => s.messages);
  const dropped = useMessagesStore((s) => s.dropped);
  const shown = useMessagesStore((s) => s.shownLevels);
  const query = useMessagesStore((s) => s.query);
  const setLevelShown = useMessagesStore((s) => s.setLevelShown);
  const setQuery = useMessagesStore((s) => s.setQuery);

  const counts = useMemo(() => countByLevel(messages), [messages]);
  const visible = useMemo(() => visibleMessages(messages, shown, query), [messages, shown, query]);

  // Read the log when the tab opens, whatever the sync hook has done meanwhile.
  useEffect(() => {
    if (sessionId !== null) void pullMessages(sessionId);
  }, [sessionId]);

  const listRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const onScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_END_PX;
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el !== null && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(messagesToText(visible));
      toast.success(`Copied ${messageCount(visible.length)}.`);
    } catch {
      toast.error('The browser did not let the messages be copied.');
    }
  };

  const onClear = async () => {
    if (sessionId === null) return;
    if (!(await clearSessionMessages(sessionId))) {
      toast.error('The messages could not be cleared.');
    }
  };

  const hiddenInfo = shown.info ? 0 : counts.info;
  const emptyList = (() => {
    if (sessionId === null) {
      return (
        <EmptyState
          icon={<InboxIcon className="size-8" />}
          title="No session yet"
          description="What ANDES says while it loads and runs a case shows up here."
          emptyStateKey="messages-no-session"
        />
      );
    }
    if (messages.length === 0) {
      return (
        <EmptyState
          icon={<InboxIcon className="size-8" />}
          title="ANDES has not said anything yet"
          description="Load a case or run something: its warnings and errors appear here."
          emptyStateKey="messages-none"
        />
      );
    }
    if (query.trim() !== '') {
      return (
        <EmptyState
          title="No message matches the filter"
          description="Every word typed has to be in the message, the command or the ANDES module."
          emptyStateKey="messages-no-match"
        />
      );
    }
    if (hiddenInfo > 0 && counts.warning + counts.error === 0) {
      return (
        <EmptyState
          icon={<InboxIcon className="size-8" />}
          title="No warnings or errors"
          description={`${hiddenInfo} information message${hiddenInfo === 1 ? ' is' : 's are'} hidden.`}
          action={{
            label: 'Show information messages',
            onClick: () => setLevelShown('info', true),
          }}
          emptyStateKey="messages-only-info"
        />
      );
    }
    return (
      <EmptyState
        title="Nothing at the levels shown"
        description="Turn a level on above to list its messages."
        emptyStateKey="messages-none-shown"
      />
    );
  })();

  return (
    <div data-testid="messages-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="border-border bg-muted/20 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-1">
        <div role="group" aria-label="Levels shown" className="flex items-center gap-0.5 py-0.5">
          {[...MESSAGE_LEVELS].reverse().map((level) => (
            <LevelToggle
              key={level}
              level={level}
              count={counts[level]}
              shown={shown[level]}
              onToggle={() => setLevelShown(level, !shown[level])}
            />
          ))}
        </div>
        {messages.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            <Input
              type="text"
              value={query}
              onChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query !== '') {
                  e.preventDefault();
                  setQuery('');
                }
              }}
              placeholder="Filter messages"
              aria-label="Filter messages"
              data-testid="messages-filter"
              className="my-0.5 h-6 w-40 px-1.5 py-0 text-xs"
            />
            {query !== '' ? (
              <>
                <span
                  data-testid="messages-filter-count"
                  className="text-muted-foreground text-[11px] whitespace-nowrap"
                >
                  {visible.length} shown
                </span>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear the filter"
                  data-testid="messages-filter-clear"
                  className="text-muted-foreground hover:text-foreground rounded px-1 text-xs focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none"
                >
                  ×
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <p
          data-testid="messages-hint"
          className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-[11px]"
          title={
            dropped > 0
              ? `${dropped} older messages were dropped: the server keeps the latest ones.`
              : undefined
          }
        >
          {dropped > 0 ? `${dropped} older messages were dropped.` : ''}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={visible.length === 0}
          onClick={() => void onCopy()}
          title="Copy the messages on show as text"
          data-testid="messages-copy"
          className="h-6 px-2"
        >
          Copy
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={messages.length === 0 || sessionId === null}
          onClick={() => void onClear()}
          title="Forget every message, including the ones filtered out"
          data-testid="messages-clear"
          className="h-6 px-2"
        >
          Clear
        </Button>
      </div>
      {visible.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">{emptyList}</div>
      ) : (
        <div
          ref={listRef}
          onScroll={onScroll}
          role="log"
          aria-live="off"
          aria-label="Messages from ANDES"
          data-testid="messages-list"
          className="min-h-0 flex-1 overflow-auto font-mono text-xs"
        >
          {visible.map((m) => (
            <MessageRow key={m.seq} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}
