/**
 * Adding a component by kind, for the controls that are not the Add element form's
 * own picker: a row of the Components palette (clicked, or dropped on the empty canvas).
 *
 * `add(kind)` opens the Add element panel on that kind. With no case open it first
 * starts a blank system, which is what a row dropped on the "No case loaded" canvas
 * has always done. `blockedReason` says why a row can do neither right now, in a
 * sentence the palette shows, so a row that does nothing is never a mystery.
 */
import { ProblemDetailsError } from '@/api/client';
import { useBlankSystem, useCurrentTopology } from '@/api/queries';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';

export interface AddComponent {
  /** Why nothing can be added now, or `null` when it can. */
  blockedReason: string | null;
  /**
   * Open the Add element panel on `kind` (starting a blank system first when no case is
   * open). Does nothing while `blockedReason` is set. A failure to start the blank
   * system goes to `onError` (a toast by default).
   */
  add: (kind: string, onError?: (message: string) => void) => void;
}

export function useAddComponent(): AddComponent {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const setCase = useCaseStore((s) => s.setCase);
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  const topology = useCurrentTopology();
  const pfRunning = usePflowStore((s) => s.isRunning);
  const blank = useBlankSystem();

  let blockedReason: string | null = null;
  if (sessionId === null) blockedReason = 'The server session is not ready yet.';
  else if (blank.isPending) blockedReason = 'Starting a new system.';
  else if (selection !== null && topology === null) blockedReason = 'The case is still loading.';
  else if (topology?.state === 'committed')
    blockedReason =
      'A run has locked the system. Select an element and use Reset run in the Inspector to add elements again.';
  else if (pfRunning) blockedReason = 'Wait for the power flow to finish.';

  const add = (kind: string, onError?: (message: string) => void) => {
    if (blockedReason !== null || sessionId === null) return;
    if (selection !== null) {
      openAddPanel(kind);
      return;
    }
    const fail = onError ?? ((message: string) => toast.error(message));
    blank.mutate(sessionId, {
      onSuccess: () => {
        setCase({ primaryPath: null, addfiles: [], blank: true });
        openAddPanel(kind);
      },
      onError: (err) => {
        if (err instanceof ProblemDetailsError && err.status === 409) {
          fail('A system is already loaded; discard it first or open a fresh tab.');
        } else if (err instanceof Error) {
          fail(err.message);
        }
      },
    });
  };

  return { blockedReason, add };
}
