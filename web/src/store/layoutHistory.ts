/**
 * Layout history slice. Remembers, in order, how the diagram was arranged
 * before each change the user made to its arrangement, so the change can be
 * taken back: a drag, a move by the arrow keys, Tidy diagram, an alignment, a
 * reset to the automatic layout.
 *
 * An entry is the whole arrangement, not what changed: where every bus and
 * device stood and how every branch was routed (`LayoutSnapshot`). Putting one
 * back is then the same whatever happened since: the canvas applies the
 * positions as drags and the routes as chosen routes (`dragOverrides` and
 * `routeOverrides` in the case store), which sit on top of whatever the saved
 * layout holds, and writes the result beside the case as it does after a
 * drag. The canvas alone records and applies, because it alone knows the
 * diagram as drawn; this slice is the two stacks and what the commands need
 * to read of them.
 *
 * Undo and Redo are one pair of commands for this history and for the edits
 * the substrate keeps (elements added, changed and deleted, and controller
 * parameter edits). `undoTarget` and `redoTarget` say which of the two a
 * press acts on: the one that holds the newest change. An entry here carries
 * the revision the edit journal had when it was recorded (`editRevision`),
 * and the journal says at which revision the newest edit that is still in
 * effect was made (`liveEditRevisions`).
 *
 * A draft that is deleted is taken back the same way, though deleting it
 * arranges nothing: its entry holds the drafts that went (`LayoutStep.drafts`)
 * and no arrangement that counts, and the canvas puts the drafts back, or
 * deletes them again for Redo, where it would apply an arrangement.
 *
 * Lifecycle: in memory only. Cleared when the case selection changes, and
 * when a snapshot restore replaces the arrangement wholesale. A new edit to
 * the system empties the redo stack, as a new arrangement does.
 */
import { create } from 'zustand';
import { useCaseStore } from './case';
import type { DragOverrides, RouteOverrides } from './case';
import { useEditJournalStore } from './editJournal';
import type { JournalEntry } from './editJournal';
import type { DraftElement } from './drafts';

/** The arrangement of a diagram: enough to draw it again as it was. */
export interface LayoutSnapshot {
  /** Where every bus and device stood, by node id. */
  positions: DragOverrides;
  /** How every branch was routed, by edge id; `null` for one routed from where its buses stood. */
  routes: RouteOverrides;
  /**
   * Which generating units had their control chain drawn out, by unit idx.
   * Only in the entries of a change that folds the chains away (a reset):
   * a move leaves them as they are, and so does taking it back.
   */
  units?: Record<string, boolean>;
}

/** One entry of the history: an arrangement, and the change it is the other side of. */
export interface LayoutStep {
  id: number;
  /** What the change was, as the commands name it: `move Bus 3`, `tidy diagram`. */
  label: string;
  /** The arrangement to put back. */
  snapshot: LayoutSnapshot;
  /** The edit journal's revision when the entry was recorded. */
  editRevision: number;
  /** Set on a change that the next one of the same key, made soon after, is part of. */
  coalesce: string | null;
  /**
   * Set on the entry of drafts that were deleted: the case they were of and
   * the drafts as they were. Taking the entry back puts them back, putting it
   * back deletes them again, and its `snapshot` is not applied either way.
   */
  drafts?: { caseKey: string; deleted: DraftElement[] };
  /** When it was recorded (ms). */
  at: number;
}

/** The most arrangements kept. A snapshot is every position and route, so the stack is bounded. */
export const MAX_LAYOUT_STEPS = 100;

/**
 * How long after a move by the arrow keys the next press on the same nodes
 * still counts as the same move, so that a nudge of ten presses is one step
 * to take back.
 */
export const NUDGE_COALESCE_MS = 1500;

export interface LayoutHistoryState {
  /** The arrangements Undo goes back through, oldest first. */
  past: LayoutStep[];
  /** The arrangements Redo goes forward through; the next one is last. */
  future: LayoutStep[];
  /**
   * Record a change that is about to be made: `before` is the arrangement it
   * replaces. `coalesce` names a change that repeats (a move of the same
   * nodes by the arrow keys); one recorded within `NUDGE_COALESCE_MS` of an
   * entry of the same name is taken to be part of it. Returns the id of the
   * entry that now stands for the change.
   */
  record: (
    label: string,
    before: LayoutSnapshot,
    coalesce?: string | null,
    drafts?: LayoutStep['drafts'],
  ) => number;
  /**
   * Take the newest change back: hands out the entry to apply, and keeps
   * `current`, the arrangement as it is now, for Redo. `null` when there is
   * nothing to take back.
   */
  undo: (current: LayoutSnapshot) => LayoutStep | null;
  /** Put back the change last taken back; the mirror of `undo`. */
  redo: (current: LayoutSnapshot) => LayoutStep | null;
  /** Drop the entry `id` when it is the newest: its change was taken back some other way. */
  discard: (id: number) => void;
  /** Drop the entry `id` wherever it is among the ones Undo goes back through. */
  forget: (id: number) => void;
  /**
   * Say which drafts the entry Redo would put back next stands for: the ones
   * an Undo has just brought back, which may have come back under other ids
   * than they were deleted with.
   */
  redoDeletes: (drafts: DraftElement[]) => void;
  clear: () => void;
}

let nextId = 1;

export const useLayoutHistoryStore = create<LayoutHistoryState>((set, get) => ({
  past: [],
  future: [],
  record: (label, before, coalesce = null, drafts) => {
    const { past } = get();
    const now = Date.now();
    const last = past[past.length - 1];
    if (
      coalesce !== null &&
      last !== undefined &&
      last.coalesce === coalesce &&
      now - last.at <= NUDGE_COALESCE_MS
    ) {
      // Part of the move before it: that one's arrangement is what to go back to.
      set({ past: [...past.slice(0, -1), { ...last, at: now }], future: [] });
      return last.id;
    }
    const step: LayoutStep = {
      id: nextId,
      label,
      snapshot: before,
      editRevision: useEditJournalStore.getState().revision,
      coalesce,
      at: now,
      ...(drafts === undefined ? {} : { drafts }),
    };
    nextId += 1;
    set({ past: [...past, step].slice(-MAX_LAYOUT_STEPS), future: [] });
    return step.id;
  },
  undo: (current) => {
    const { past, future } = get();
    const step = past[past.length - 1];
    if (step === undefined) return null;
    const back: LayoutStep = {
      ...step,
      snapshot: current,
      editRevision: useEditJournalStore.getState().revision,
      coalesce: null,
    };
    set({ past: past.slice(0, -1), future: [...future, back] });
    return step;
  },
  redo: (current) => {
    const { past, future } = get();
    const step = future[future.length - 1];
    if (step === undefined) return null;
    const forth: LayoutStep = {
      ...step,
      snapshot: current,
      editRevision: useEditJournalStore.getState().revision,
      coalesce: null,
    };
    set({ past: [...past, forth], future: future.slice(0, -1) });
    return step;
  },
  discard: (id) => {
    const { past } = get();
    if (past[past.length - 1]?.id === id) set({ past: past.slice(0, -1) });
  },
  redoDeletes: (drafts) => {
    const { future } = get();
    const next = future[future.length - 1];
    if (next?.drafts === undefined) return;
    set({
      future: [...future.slice(0, -1), { ...next, drafts: { ...next.drafts, deleted: drafts } }],
    });
  },
  forget: (id) => {
    const { past } = get();
    if (past.some((step) => step.id === id)) set({ past: past.filter((step) => step.id !== id) });
  },
  clear: () => set({ past: [], future: [] }),
}));

/**
 * The revisions at which the newest edit still in effect was made, and at
 * which the edit last taken back was taken back; 0 for none. Read off the
 * journal by following what each entry does to the substrate's two histories
 * (the element edits before a run, and the controller parameter edits after
 * one): an undo takes the newest entry off the first stack and puts it on the
 * second, a redo the other way, a new edit empties the second.
 */
export function liveEditRevisions(entries: readonly JournalEntry[]): {
  undoable: number;
  redoable: number;
} {
  const done: Record<'element' | 'clone', number[]> = { element: [], clone: [] };
  const undone: Record<'element' | 'clone', number[]> = { element: [], clone: [] };
  const back = (kind: 'element' | 'clone', rev: number): void => {
    if (done[kind].pop() !== undefined) undone[kind].push(rev);
  };
  const forth = (kind: 'element' | 'clone', rev: number): void => {
    if (undone[kind].pop() !== undefined) done[kind].push(rev);
  };
  for (const entry of entries) {
    switch (entry.op) {
      case 'add':
      case 'edit':
      case 'delete':
        done.element.push(entry.rev);
        undone.element = [];
        break;
      case 'undo':
        back('element', entry.rev);
        break;
      case 'redo':
        forth('element', entry.rev);
        break;
      case 'clone-edit':
        done.clone.push(entry.rev);
        undone.clone = [];
        break;
      case 'clone-undo':
        back('clone', entry.rev);
        break;
      case 'clone-redo':
        forth('clone', entry.rev);
        break;
      case 'clone-reset':
        done.clone = [];
        undone.clone = [];
        break;
      default:
        break;
    }
  }
  const top = (stack: number[]): number => stack[stack.length - 1] ?? 0;
  return {
    undoable: Math.max(top(done.element), top(done.clone)),
    redoable: Math.max(top(undone.element), top(undone.clone)),
  };
}

/** What `undoTarget` and `redoTarget` read of the edit journal. */
export interface EditClock {
  entries: readonly JournalEntry[];
  revision: number;
  replayable: boolean;
}

/**
 * Whether a press of Undo takes back the newest change to the arrangement
 * (`layout`) or the newest edit to the system (`edit`); `null` with neither
 * to take back. `step` is the newest entry of the layout history, or `null`
 * when it is empty or the diagram is not on screen to apply one to;
 * `editAvailable` is whether the substrate has an edit to take back.
 *
 * The arrangement goes first when it was changed after the newest edit that
 * is still in effect. Where the journal no longer lists the edits, an edit
 * made since the entry was recorded goes first, and otherwise the entry.
 */
export function undoTarget(
  step: LayoutStep | null,
  editAvailable: boolean,
  clock: EditClock,
): 'layout' | 'edit' | null {
  if (step === null) return editAvailable ? 'edit' : null;
  if (!editAvailable) return 'layout';
  const newestEdit = clock.replayable ? liveEditRevisions(clock.entries).undoable : clock.revision;
  return step.editRevision >= newestEdit ? 'layout' : 'edit';
}

/** The same for Redo: the arrangement goes first when its change was the one taken back last. */
export function redoTarget(
  step: LayoutStep | null,
  editAvailable: boolean,
  clock: EditClock,
): 'layout' | 'edit' | null {
  if (step === null) return editAvailable ? 'edit' : null;
  if (!editAvailable) return 'layout';
  const newestUndo = clock.replayable ? liveEditRevisions(clock.entries).redoable : clock.revision;
  return step.editRevision >= newestUndo ? 'layout' : 'edit';
}

// Another case (or none) starts a fresh history, and a new edit to the
// system leaves nothing to redo. Wired here, as the journal wires its own
// reset, so it holds wherever the history is in use.
let wiredSelection: unknown = useCaseStore.getState().selection;
useCaseStore.subscribe((state) => {
  if (state.selection !== wiredSelection) {
    wiredSelection = state.selection;
    useLayoutHistoryStore.getState().clear();
  }
});

const NEW_EDITS: ReadonlySet<JournalEntry['op']> = new Set(['add', 'edit', 'delete', 'clone-edit']);
useEditJournalStore.subscribe((state, previous) => {
  if (state.revision === previous.revision) return;
  const newest = state.entries[state.entries.length - 1];
  if (newest === undefined || newest.rev !== state.revision || !NEW_EDITS.has(newest.op)) return;
  if (useLayoutHistoryStore.getState().future.length > 0) {
    useLayoutHistoryStore.setState({ future: [] });
  }
});
