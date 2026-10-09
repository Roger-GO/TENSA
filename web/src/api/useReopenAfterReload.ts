/**
 * Opens the case again that a reload of the page interrupted.
 *
 * A reload gives the session back (`useSessionRelease`) and the page starts
 * with a new, empty one. What the tab had open is in its `sessionStorage`:
 * the case (`store/reloadedCase.ts`) and the edits made to it since it was
 * opened or last saved (`journalBeforeReload` in `store/editJournal.ts`). Once
 * the new session is there this hook puts both back, the way
 * `useSessionRecovery` does for a session the server lost:
 *
 * - a case file is loaded again, with the dynamic files it was opened with,
 *   and the edits are replayed onto it;
 * - a system built from scratch is a new blank system with its build
 *   replayed into it.
 *
 * The drafts of the diagram and its layout are kept by the case, in the
 * browser and beside the file, so they come back with it; the drafts of a
 * system built from scratch are kept in the tab (`store/drafts.ts`). The
 * arrangement of such a system is not: no file holds it, and it is laid
 * out afresh. The results the
 * browser kept come back on their own (`store/resultsPersistence.ts`). What
 * a reload does lose is said: edits the journal could not record (a PMU or
 * profile placement, a snapshot restore, a bundle import), and a run that
 * was under way.
 *
 * A file the workspace no longer holds, or a load the server refuses, leaves
 * the page as on a first visit, with a notice that says which case it could
 * not open. A case the user opens before the reopening has started wins: the
 * mark is answered and nothing is opened over it.
 *
 * A request that ends without an answer is no refusal, and what the tab keeps
 * is left as it is for the next reload. That is above all a second reload
 * while the case is still on its way back: the browser ends the requests of
 * the page that goes, which is no reason to give the case up
 * (`lib/pageLeaving.ts`). A server that stopped answering is told apart from
 * one that refused in the same way, and the notice then says that a reload
 * tries again.
 *
 * Mounted once from `App.tsx`, beside `useSessionRecovery`.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ProblemDetailsError } from './client';
import { useLoadCase } from './queries';
import { retryWhileBusy } from './replayJournal';
import { recreateBlankSystem, replayEditsInto, reportReplay } from './restoreEdits';
import { parseWorkspacePath } from './types';
import type { WorkspacePath } from './types';
import { describeError } from '@/lib/describeError';
import { pageIsLeaving } from '@/lib/pageLeaving';
import { baseName } from '@/lib/paths';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { isWorkOp, journalBeforeReload, useEditJournalStore } from '@/store/editJournal';
import type { KeptJournal } from '@/store/editJournal';
import { isOnFile, useReloadedCaseStore } from '@/store/reloadedCase';
import { useSessionStore } from '@/store/session';

/** What the notices of a reopening start with: why anything was opened at all. */
const RELOADED = 'The page was reloaded.';

/**
 * Take a reopening that failed with `err`, and say why in the words of its
 * notice. A refusal of the server ends it: the mark is dropped, and the page is
 * as on a first visit. A request that got no answer (the connection, a timeout)
 * says nothing about the case: the page stops waiting, and the mark, the edits
 * and the drafts the tab keeps stay for the next reload.
 */
function giveUp(err: unknown): { why: string; kept: boolean } {
  if (err instanceof ProblemDetailsError) {
    useReloadedCaseStore.getState().forget();
    return { why: describeError(err), kept: false };
  }
  useReloadedCaseStore.getState().postpone();
  // The error of a request that failed names its address, which says nothing here.
  return { why: 'The server did not answer.', kept: true };
}

/** Whether `journal` holds work that no save had written out. */
function hadUnsavedWork(journal: KeptJournal): boolean {
  return (
    journal.opaqueRevision > journal.savedRevision ||
    journal.entries.some((e) => isWorkOp(e) && e.rev > journal.savedRevision)
  );
}

export function useReopenAfterReload(): void {
  const closed = useReloadedCaseStore((s) => s.closed);
  const sessionId = useSessionStore((s) => s.sessionId);
  const recoveryFailed = useSessionStore((s) => s.recoveryFailed);
  const loadCase = useLoadCase();
  const queryClient = useQueryClient();
  const started = useRef(false);

  // Until the session is there the page says what it is about to do, where it
  // says "No case loaded" on a first visit.
  useEffect(() => {
    if (closed === null || started.current) return;
    const cases = useCaseStore.getState();
    if (cases.selection !== null) return;
    if (recoveryFailed) {
      // No server to open it on: the page says that, and not that it is loading.
      if (cases.loadingPath !== null) cases.setLoadingPath(null);
      return;
    }
    if (cases.loadingPath === null && isOnFile(closed)) cases.setLoadingPath(closed.primaryPath);
  }, [closed, recoveryFailed]);

  useEffect(() => {
    if (closed === null || sessionId === null || started.current) return;
    started.current = true;
    if (useCaseStore.getState().selection !== null) return;
    const journal = journalBeforeReload();
    const entries = journal !== null && journal.replayable ? journal.entries : [];
    // What the journal could not record cannot be replayed: said once the case is open.
    const lost =
      journal !== null && !journal.replayable && (journal.replaced || hadUnsavedWork(journal));
    // Put the journal back as the tab kept it, and its edits into the session.
    const restoreEdits = async (target: string): Promise<void> => {
      if (journal === null || entries.length === 0) return;
      useEditJournalStore.setState({ ...journal, entries: [...entries] });
      const outcome = await replayEditsInto(sessionId, queryClient, entries);
      reportReplay(outcome, entries, target, RELOADED);
    };

    void (async () => {
      if (!isOnFile(closed)) {
        try {
          await recreateBlankSystem(sessionId, queryClient);
        } catch (err) {
          // Ended by the page going away: what the tab keeps is for the next page.
          if (pageIsLeaving()) return;
          const { why, kept } = giveUp(err);
          toast.error('The system you were building could not be opened again', {
            description: `${RELOADED} ${why}${kept ? ' Reload the page to try again.' : ''}`,
            duration: 12_000,
          });
          return;
        }
        // Opening it resets the journal (a new selection), so the edits go in after.
        useCaseStore.getState().setCase({ primaryPath: null, addfiles: [], blank: true });
        if (lost) {
          toast.warning('The system was not rebuilt', {
            description: `${RELOADED} It held changes that cannot be replayed (a PMU or profile placement, a snapshot restore or a bundle import), so a new, empty system was started.`,
            duration: 12_000,
          });
          return;
        }
        await restoreEdits('a new blank system');
        return;
      }

      const name = baseName(closed.primaryPath);
      let primary: WorkspacePath;
      let addfiles: WorkspacePath[];
      try {
        primary = parseWorkspacePath(closed.primaryPath);
        addfiles = closed.addfiles.map(parseWorkspacePath);
      } catch (err) {
        // A mark that names no file of a workspace: no reload can open it.
        useCaseStore.getState().setLoadingPath(null);
        useReloadedCaseStore.getState().forget();
        toast.error(`Could not reopen ${name}`, {
          description: `${RELOADED} ${describeError(err)}. Pick a case in the Project tab of the left sidebar.`,
          duration: 12_000,
        });
        return;
      }
      try {
        await retryWhileBusy(() =>
          loadCase.mutateAsync({
            sessionId,
            request: { primary_path: primary, addfiles: addfiles.length > 0 ? addfiles : null },
          }),
        );
        useCaseStore.getState().setCase({ primaryPath: primary, addfiles });
      } catch (err) {
        // Ended by the page going away: what the tab keeps is for the next page.
        if (pageIsLeaving()) return;
        useCaseStore.getState().setLoadingPath(null);
        const { why, kept } = giveUp(err);
        toast.error(`Could not reopen ${name}`, {
          description: `${RELOADED} ${why} ${kept ? 'Reload the page to try again, or pick' : 'Pick'} a case in the Project tab of the left sidebar.`,
          duration: 12_000,
        });
        return;
      }
      if (lost) {
        toast.warning(`${name} was reopened from its file`, {
          description: `${RELOADED} Changes that cannot be replayed were made before it (a PMU or profile placement, a snapshot restore or a bundle import), so the case is as its file has it.`,
          duration: 12_000,
        });
        return;
      }
      await restoreEdits('a fresh copy of the case');
    })();
    // ``loadCase`` is left out: the mutation object is new at every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, sessionId, queryClient]);
}
