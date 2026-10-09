/**
 * Adding a component by kind, for the controls that are not the Add element form's
 * own picker: a row of the Components palette (clicked, or dropped on the empty canvas).
 *
 * `add(kind)` opens the Add element panel on that kind, which is what a click on a
 * row does. `place(kind)` puts a draft of that kind on the diagram, which is what a
 * row dropped where no diagram is drawn yet does (a drop on a diagram is the
 * canvas's own, since only it knows where the pointer was let go). With no case
 * open either first starts a blank system. `blockedReason` says why a row can do
 * neither right now, in a sentence the palette shows, so a row that does nothing is
 * never a mystery.
 */
import { ProblemDetailsError } from '@/api/client';
import { useBlankSystem, useCurrentTopology } from '@/api/queries';
import { runLockNotice } from '@/lib/runLock';
import { toast } from '@/lib/toast';
import { useReloadDiscardsEdits } from '@/lib/useResetRunAction';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useReloadedCaseStore } from '@/store/reloadedCase';
import { useSessionStore } from '@/store/session';

/** Why nothing can be added while the case a reload interrupted is being opened again. */
const REOPENING = 'The case this page had open is being opened again.';

export interface AddComponent {
  /** Why nothing can be added now, or `null` when it can. */
  blockedReason: string | null;
  /** Whether that reason is a run that has fixed the system, which Reset run undoes. */
  lockedByRun: boolean;
  /**
   * Open the Add element panel on `kind` (starting a blank system first when no case is
   * open). Does nothing while `blockedReason` is set. A failure to start the blank
   * system goes to `onError` (a toast by default).
   */
  add: (kind: string, onError?: (message: string) => void) => void;
  /**
   * Place a draft of `kind` on the diagram (starting a blank system first when no
   * case is open), picked, so the Inspector opens on its form. Does nothing while
   * `blockedReason` is set; a failure goes to `onError` as for `add`.
   */
  place: (kind: string, onError?: (message: string) => void) => void;
}

export function useAddComponent(): AddComponent {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const setCase = useCaseStore((s) => s.setCase);
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  const topology = useCurrentTopology();
  const pfRunning = usePflowStore((s) => s.isRunning);
  const blank = useBlankSystem();
  const discardsEdits = useReloadDiscardsEdits();
  const reopening = useReloadedCaseStore((s) => s.closed !== null);

  let blockedReason: string | null = null;
  let lockedByRun = false;
  if (sessionId === null) blockedReason = 'The server session is not ready yet.';
  else if (blank.isPending) blockedReason = 'Starting a new system.';
  // After a reload of the page: a blank system started now would be in the
  // way of the case that is on its way back (`useReopenAfterReload`).
  else if (selection === null && reopening) blockedReason = REOPENING;
  else if (selection !== null && topology === null) blockedReason = 'The case is still loading.';
  else if (topology?.state === 'committed') {
    blockedReason = runLockNotice(discardsEdits);
    lockedByRun = true;
  } else if (pfRunning) blockedReason = 'Wait for the power flow to finish.';

  // Start a blank system, then do `then` with it open.
  const onBlankSystem = (then: () => void, onError?: (message: string) => void) => {
    if (sessionId === null) return;
    const fail = onError ?? ((message: string) => toast.error(message));
    blank.mutate(sessionId, {
      onSuccess: () => {
        setCase({ primaryPath: null, addfiles: [], blank: true });
        then();
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

  const add = (kind: string, onError?: (message: string) => void) => {
    if (blockedReason !== null || sessionId === null) return;
    if (selection !== null) openAddPanel(kind);
    else onBlankSystem(() => openAddPanel(kind), onError);
  };

  const place = (kind: string, onError?: (message: string) => void) => {
    if (blockedReason !== null || sessionId === null) return;
    // The drafts are the diagram's, whose code is not on the first screen: it
    // is fetched here, for the one drop that comes before a diagram is drawn.
    const placeDraft = () => {
      import('@/components/sld/draftActions').then(
        (drafts) => drafts.placeDraftOffCanvas(kind),
        () => (onError ?? toast.error)('The draft could not be placed. Try the drop again.'),
      );
    };
    if (selection !== null) placeDraft();
    else onBlankSystem(placeDraft, onError);
  };

  return { blockedReason, lockedByRun, add, place };
}
