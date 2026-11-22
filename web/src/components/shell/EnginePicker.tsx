/**
 * EnginePicker. The top-bar control that shows the engine of the session and
 * switches it. It is a `TopBarMenu` like the menus beside it, so it has their
 * keyboard handling (arrow keys, Home, End, Enter, Escape, focus back on the
 * trigger) and their way of showing an entry that cannot be used now: in the
 * menu, dimmed, with the reason under it and given as its description. The
 * menu lists every engine the server knows (`GET /engines`, mirrored into the
 * session store by `useEnginesSync`) with its routines, and for an engine that
 * is not available, the server's reason.
 *
 * The switch owns no session lifecycle: `startSessionOver`
 * (`useSessionRecovery.ts`) closes the session and sets the engine, and the
 * recovery driver creates the next session. A session belongs to one engine,
 * so the switch closes the case; with a case open the user confirms first
 * (`SwitchEngineConfirmDialog`, loaded on first open). While a power flow runs, a switch is held
 * back with the words Change case uses; a time-domain run or a sweep under
 * way is stopped by it, as by Change case, and the confirm says so.
 *
 * The control stays in the bar at every width: the engine is not a command the
 * More menu could stand in for. So it is drawn as short as it can be, the
 * engine's label with no chevron (a trigger of about 63 px for "ANDES", the
 * longest label `engineLabel` knows), and `topBarLayout.ts` counts it in the
 * widths at which the other controls hand over to More.
 */
import { useRef, useState } from 'react';
import { TopBarMenu, TopBarMenuItem, TopBarMenuLabel } from '@/components/shell/TopBarMenu';
import { LazyMount } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';
import { startSessionOver } from '@/api/useSessionRecovery';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSweepStore } from '@/store/sweep';
import { hasUnsavedEdits, useEditJournalStore } from '@/store/editJournal';
import { DEFAULT_ENGINE, engineLabel, engineVersionsLine } from '@/lib/engines';
import { toast } from '@/lib/toast';

// The confirm is its own chunk, fetched the first time a switch asks for it:
// the picker is on the first screen, the confirm is not.
const SwitchEngineConfirmDialog = lazyNamed(
  () => import('@/components/shell/SwitchEngineConfirmDialog'),
  'SwitchEngineConfirmDialog',
  'overlay',
);

/** Why no engine can be chosen now, or null when one can. */
function switchBlockedReason(args: {
  switching: boolean;
  live: boolean;
  pflowRunning: boolean;
}): string | null {
  if (args.switching) return 'Switching engine. Wait for the new session.';
  if (!args.live) return 'Waiting for a session to start.';
  if (args.pflowRunning) return 'Wait for power flow to finish.';
  return null;
}

export function EnginePicker() {
  const engines = useSessionStore((s) => s.engines);
  const engine = useSessionStore((s) => s.engine);
  const live = useSessionStore(
    (s) => s.sessionId !== null && !s.recoveryInProgress && !s.recoveryFailed,
  );
  const awaitingSession = useSessionStore((s) => s.previousEngine !== null);
  const pflowRunning = usePflowStore((s) => s.isRunning);
  // What the confirm says. The edits are the ones a session recovery calls
  // unsaved (`hadPendingEdits` in `useSessionRecovery.ts`): the clone's
  // undo / redo depth, or a journal with work no save has written.
  const cloneEdits = useCaseStore((s) => s.cloneUndoDepth > 0 || s.cloneRedoDepth > 0);
  const journalEdits = useEditJournalStore(() => hasUnsavedEdits());
  const runStreaming = useRunsStore((s) =>
    Object.values(s.runs).some((r) => r.state === 'starting' || r.state === 'streaming'),
  );
  const sweepRunning = useSweepStore((s) =>
    Object.values(s.sweeps).some((w) => w.state === 'pending' || w.state === 'running'),
  );

  // The engine waiting on the confirm, or null when the confirm is closed.
  const [pending, setPending] = useState<string | null>(null);
  // True while the old session's release is out.
  const [releasing, setReleasing] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  const current = engine ?? DEFAULT_ENGINE;
  const currentLabel = engineLabel(current);
  const blocked = switchBlockedReason({
    switching: releasing || awaitingSession,
    live,
    pflowRunning,
  });

  const release = (name: string) => {
    setReleasing(true);
    void startSessionOver(name).finally(() => setReleasing(false));
  };

  /** Whether `name` can be switched to now; says why not when it cannot. */
  const stillAvailable = (name: string): boolean => {
    const entry = useSessionStore.getState().engines?.engines.find((e) => e.name === name);
    if (entry !== undefined && entry.available) return true;
    toast.error(`Could not switch to ${engineLabel(name)}`, {
      description: entry?.unavailable_reason ?? 'The server no longer lists this engine.',
    });
    return false;
  };

  const choose = (name: string) => {
    if (name === current || blocked !== null) return;
    if (!stillAvailable(name)) return;
    if (useCaseStore.getState().selection !== null) {
      setPending(name);
      return;
    }
    release(name);
  };

  const confirm = () => {
    const name = pending;
    setPending(null);
    // The list may have changed while the confirm was open.
    if (name === null || !stillAvailable(name)) return;
    release(name);
  };

  // The confirm hands the focus back to the trigger, which `TopBarMenu` keeps
  // to itself; this box (no box of its own on the page) is how it is found.
  const returnFocus = () => {
    anchor.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus();
  };

  return (
    <span ref={anchor} className="contents">
      <TopBarMenu
        label={currentLabel}
        triggerAriaLabel={`Engine: ${currentLabel}`}
        menuLabel="Engine"
        testId="engine-picker"
        chevron={false}
        alignEnd
      >
        <TopBarMenuLabel>Engine</TopBarMenuLabel>
        {engines === null ? (
          <p
            data-testid="engine-picker-no-list"
            className="text-muted-foreground px-2 py-1.5 text-xs"
          >
            The list of engines is not available. The session runs on {currentLabel}.
          </p>
        ) : (
          engines.engines.map((entry) => {
            const isCurrent = entry.name === current;
            const reason = !entry.available
              ? (entry.unavailable_reason ?? 'Not available on this server.')
              : isCurrent
                ? undefined
                : (blocked ?? undefined);
            // The versions go on a second line under the routines, inside the
            // opened list only: the trigger and the top bar width do not
            // change. An engine that reports none renders exactly as before.
            const versionsLine = engineVersionsLine(entry.versions);
            return (
              <TopBarMenuItem
                key={entry.name}
                testId={`engine-picker-option-${entry.name}`}
                checked={isCurrent}
                aria-current={isCurrent ? 'true' : undefined}
                unavailableReason={reason}
                note={entry.routines.length > 0 ? entry.routines.join(', ') : 'No routines'}
                detail={versionsLine ?? undefined}
                onClick={() => choose(entry.name)}
              >
                {engineLabel(entry.name)}
              </TopBarMenuItem>
            );
          })
        )}
      </TopBarMenu>
      <LazyMount when={pending !== null} onLoadFailed={() => setPending(null)}>
        <SwitchEngineConfirmDialog
          engine={pending}
          unsavedEdits={cloneEdits || journalEdits}
          runUnderWay={runStreaming || sweepRunning}
          onCancel={() => setPending(null)}
          onConfirm={confirm}
          returnFocus={returnFocus}
        />
      </LazyMount>
    </span>
  );
}
