/**
 * Edit journal slice. Remembers, in order, the edits the user has made to the
 * loaded system, so a session the substrate has lost (reaped while the tab slept,
 * or gone with a server restart) can be rebuilt instead of reloaded from the file.
 *
 * Recovery used to re-load the case file into the fresh session. That brings back a
 * file-backed case as it was on disk and nothing else: the elements and parameter
 * edits made since are gone, and a system built from scratch has no file at all.
 * The journal records every successful topology mutation (add, edit, delete,
 * undo, redo, the clone-on-write controller edits, and the reloads that revert them), and
 * ``replayJournal`` re-sends them to the new session in the same order. Replaying
 * the operations through the same endpoints, rather than modelling their result,
 * is what keeps the rebuilt session the same as the lost one whatever the
 * substrate does with an operation.
 *
 * What it keeps small:
 *
 * - A reload on a file-backed case throws away everything before it that was not a
 *   clone edit (the substrate re-parses the file and empties its edit log), and
 *   a clone reset throws away everything, so ``compactJournal`` drops those entries
 *   instead of replaying work the substrate would undo. A long session of
 *   "edit, run, reset" therefore does not turn into a long replay of re-parses.
 * - Past ``MAX_JOURNAL_ENTRIES`` the journal gives up and keeps only a flag.
 *
 * It keeps one entry per request, and does not fold two edits of one element into
 * one: the substrate takes back one request per undo, so an undo replayed after a
 * folded edit would take back both.
 *
 * What it cannot replay: PMU and profile placements, a snapshot restore and a bundle
 * import. They mark the journal not ``replayable``, and recovery falls back to
 * reloading the file as before (it still tells the user what was lost).
 *
 * The journal also answers "is there unsaved work": an entry newer than the last
 * save (``markSaved``, called when the system or the clone is written to the
 * workspace) counts, which the unload guard reads. Save asks a narrower question,
 * whether the open case's own file lacks an edit, which a write to some other file
 * does not settle (``fileSavedRevision``). A write over the open file also makes
 * that file the base the substrate rebuilds from (``markSavedInPlace``).
 *
 * Lifecycle: in memory only, like the session it belongs to. It is cleared when the
 * case selection changes (a new case, a discarded one). A session recovery keeps
 * the selection, so the journal survives it for ``replayJournal`` to read.
 */
import { create } from 'zustand';
import type { ParamValue } from '@/api/types';
import { useCaseStore } from './case';

/** One recorded operation, in the terms of the endpoint that performed it. */
export type JournalOp =
  | { op: 'add'; model: string; params: Record<string, ParamValue> }
  | { op: 'edit'; model: string; idx: string; params: Record<string, ParamValue> }
  /** ``cascade``: the delete took with it what depended on the element. */
  | { op: 'delete'; model: string; idx: string; cascade?: boolean }
  /** ``POST /undo-last-edit``: takes back the newest add, edit or delete. */
  | { op: 'undo' }
  /** ``POST /redo-edit``: puts back what the last undo took back. */
  | { op: 'redo' }
  /** ``POST /reload``: back to the pre-setup system. */
  | { op: 'reload' }
  | { op: 'clone-init' }
  | { op: 'clone-edit'; model: string; idx: string; param: string; value: ParamValue }
  | { op: 'clone-undo' }
  | { op: 'clone-redo' }
  | { op: 'clone-reset' };

/** An operation with the revision that recorded it. */
export type JournalEntry = JournalOp & { rev: number };

/**
 * The most operations the journal keeps. A build of the largest case in the
 * examples, element by element, is a few hundred; this leaves room for a long
 * session of edits and reloads on top.
 */
export const MAX_JOURNAL_ENTRIES = 2000;

const CLONE_OPS: ReadonlySet<JournalOp['op']> = new Set([
  'clone-init',
  'clone-edit',
  'clone-undo',
  'clone-redo',
]);

/**
 * Operations that are the user's own work. A reload, a clone init (Edit mode
 * switched on), and a clone reset (edits discarded) are not: they add nothing to
 * lose.
 */
const WORK_OPS: ReadonlySet<JournalOp['op']> = new Set([
  'add',
  'edit',
  'delete',
  'undo',
  'redo',
  'clone-edit',
  'clone-undo',
  'clone-redo',
]);

/**
 * Drop the entries the substrate's own behaviour makes pointless to replay. Pure.
 *
 * ``fileBacked`` is whether the case came from a file (``true``) or was built
 * blank (``false``). The rules apply to the newest entry, so ``record`` runs this
 * after pushing a reload or a clone reset:
 *
 * - A clone reset on a file-backed case reloads the originals and clears the
 *   clone: everything before it, and the reset itself, is gone.
 * - A reload on a file-backed case re-parses the file: every entry before it that
 *   is not a clone operation is gone (the clone's files and stacks outlive a
 *   reload), and so is the reload when no clone operation is left before it, since
 *   a fresh load is already what it would produce.
 * - A reload that follows a reload adds nothing.
 *
 * A blank system keeps its adds across a reload (the substrate replays them), so
 * only the repeated reload goes.
 */
export function compactJournal(
  entries: readonly JournalEntry[],
  fileBacked: boolean,
): JournalEntry[] {
  const last = entries[entries.length - 1];
  if (last === undefined) return [];
  let out = [...entries];
  if (fileBacked && last.op === 'clone-reset') return [];
  if (fileBacked && last.op === 'reload') {
    const kept = out.slice(0, -1).filter((e) => CLONE_OPS.has(e.op));
    out = kept.length === 0 ? [] : [...kept, last];
  }
  // Collapse a run of reloads into its newest.
  return out.filter((e, i) => !(e.op === 'reload' && out[i + 1]?.op === 'reload'));
}

/** True when ``op`` is the user's own work rather than bookkeeping. */
export function isWorkOp(op: JournalOp): boolean {
  return WORK_OPS.has(op.op);
}

export interface EditJournalState {
  /** Recorded operations, oldest first, already compacted. */
  entries: JournalEntry[];
  /** Counts every change, so an entry's ``rev`` orders it against a save. */
  revision: number;
  /** ``revision`` when the system or clone was last written to the workspace. */
  savedRevision: number;
  /**
   * ``revision`` when the system was last written over the open case's own file, or
   * 0 for the file as it was opened. A save under another name moves
   * ``savedRevision`` and not this.
   */
  fileSavedRevision: number;
  /**
   * False once something the journal cannot replay has happened (see the file
   * comment) or it outgrew ``MAX_JOURNAL_ENTRIES``. Recovery then reloads the file
   * instead. ``entries`` stops growing; ``opaqueRevision`` keeps the "unsaved work"
   * answer.
   */
  replayable: boolean;
  /** ``revision`` of the latest work the journal could not record, or 0. */
  opaqueRevision: number;
  /**
   * True after a snapshot restore or a bundle import replaced the system, until a
   * reload puts the open case's file back or another case is chosen. The system is
   * then not the open file plus the user's edits, so a save must not write it over
   * that file.
   */
  replaced: boolean;
  /** Record one successful operation. */
  record: (op: JournalOp) => void;
  /**
   * Note work the journal cannot replay (a PMU or profile placement): recovery
   * can no longer rebuild this session, and there is something to lose.
   */
  markOpaque: () => void;
  /**
   * Note that the system was replaced wholesale by a snapshot restore or a bundle
   * import. The old entries are meaningless, there is nothing unsaved yet, and
   * recovery cannot rebuild what the new system became.
   */
  markReplaced: () => void;
  /** The system (or the clone) was just written to the workspace, as another file. */
  markSaved: () => void;
  /**
   * The system was just written over the open case's own file. The file holds every
   * edit up to now, so the substrate (which empties its edit log for the same
   * reason) and a session recovery start from it: the entries are dropped as a
   * file-backed reload drops them, and replaying them onto the file would apply each
   * twice. A clone's operations stay, since its files and stacks are not in the file.
   */
  markSavedInPlace: () => void;
  /** Keep only the entries recorded up to and including revision ``rev``. */
  truncateAfter: (rev: number) => void;
  reset: () => void;
}

const INITIAL = {
  entries: [] as JournalEntry[],
  revision: 0,
  savedRevision: 0,
  fileSavedRevision: 0,
  replayable: true,
  opaqueRevision: 0,
  replaced: false,
};

export const useEditJournalStore = create<EditJournalState>((set, get) => ({
  ...INITIAL,
  record: (op) => {
    const state = get();
    const rev = state.revision + 1;
    // A reload is the open file again, whatever replaced the system before it.
    const replaced = op.op === 'reload' ? false : state.replaced;
    if (!state.replayable) {
      // Nothing to replay any more; keep only whether there is unsaved work.
      set({
        revision: rev,
        opaqueRevision: isWorkOp(op) ? rev : state.opaqueRevision,
        replaced,
      });
      return;
    }
    let entries = [...state.entries, { ...op, rev }];
    if (op.op === 'reload' || op.op === 'clone-reset') {
      const selection = useCaseStore.getState().selection;
      entries = compactJournal(entries, selection !== null && selection.primaryPath !== null);
    }
    if (entries.length > MAX_JOURNAL_ENTRIES) {
      set({ entries: [], revision: rev, replayable: false, opaqueRevision: rev, replaced });
      return;
    }
    set({ entries, revision: rev, replaced });
  },
  markOpaque: () => {
    const rev = get().revision + 1;
    set({ entries: [], revision: rev, replayable: false, opaqueRevision: rev });
  },
  markReplaced: () => {
    const rev = get().revision + 1;
    set({
      entries: [],
      revision: rev,
      savedRevision: rev,
      replayable: false,
      opaqueRevision: 0,
      replaced: true,
    });
  },
  markSaved: () => set((s) => ({ savedRevision: s.revision })),
  markSavedInPlace: () =>
    set((s) => {
      const rev = s.revision + 1;
      return {
        entries: s.entries.filter((e) => CLONE_OPS.has(e.op)),
        revision: rev,
        savedRevision: rev,
        fileSavedRevision: rev,
      };
    }),
  truncateAfter: (rev) => set((s) => ({ entries: s.entries.filter((e) => e.rev <= rev) })),
  reset: () => set({ ...INITIAL, entries: [] }),
}));

/**
 * True when the user has made changes that no save has written out and that a
 * lost session would take with it: an edit newer than the last save, or work the
 * journal could not record.
 */
export function hasUnsavedEdits(): boolean {
  return hasWorkAfter(useEditJournalStore.getState().savedRevision);
}

/**
 * True when the open case's own file lacks work the user has done: an edit newer than
 * the last write over that file, or work the journal could not record. A save under
 * another name does not count, because the open file is not what it wrote.
 */
export function hasEditsNotInFile(): boolean {
  return hasWorkAfter(useEditJournalStore.getState().fileSavedRevision);
}

function hasWorkAfter(revision: number): boolean {
  const { entries, opaqueRevision } = useEditJournalStore.getState();
  return opaqueRevision > revision || entries.some((e) => isWorkOp(e) && e.rev > revision);
}

// A different case (or none) starts a fresh journal. Wired here, not in the store
// cascade, so it holds wherever the journal is in use. A session recovery leaves the
// selection alone, so the journal outlives it.
let wiredSelection: unknown = useCaseStore.getState().selection;
useCaseStore.subscribe((state) => {
  if (state.selection !== wiredSelection) {
    wiredSelection = state.selection;
    useEditJournalStore.getState().reset();
  }
});
