/**
 * The layout history (`store/layoutHistory.ts`): the arrangements Undo and
 * Redo step through, and which of the two histories a press acts on, this
 * one or the edits the substrate keeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';
import type { JournalEntry, JournalOp } from '@/store/editJournal';
import {
  MAX_LAYOUT_STEPS,
  NUDGE_COALESCE_MS,
  liveEditRevisions,
  redoTarget,
  undoTarget,
  useLayoutHistoryStore,
  type LayoutSnapshot,
} from '@/store/layoutHistory';
import { parseWorkspacePath } from '@/api/types';

/** An arrangement with one bus at `x`. */
function at(x: number): LayoutSnapshot {
  return { positions: { '1': { x, y: 0 } }, routes: { 'line-L': null } };
}

const history = () => useLayoutHistoryStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  useEditJournalStore.getState().reset();
  history().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the two stacks', () => {
  it('records the arrangement a change replaces, and hands it back on undo', () => {
    history().record('move bus 1', at(0));
    history().record('tidy diagram', at(10));
    expect(history().past.map((step) => step.label)).toEqual(['move bus 1', 'tidy diagram']);

    // The diagram is at 20 now: the tidy is taken back to 10.
    const undone = history().undo(at(20));
    expect(undone?.label).toBe('tidy diagram');
    expect(undone?.snapshot).toEqual(at(10));
    expect(history().past.map((step) => step.label)).toEqual(['move bus 1']);
    // What it was taken back from is kept for Redo, under the same name.
    expect(history().future).toHaveLength(1);
    expect(history().future[0]).toMatchObject({ label: 'tidy diagram', snapshot: at(20) });
  });

  it('puts a change back on redo, and can take it back again', () => {
    history().record('tidy diagram', at(10));
    history().undo(at(20));
    const redone = history().redo(at(10));
    expect(redone).toMatchObject({ label: 'tidy diagram', snapshot: at(20) });
    expect(history().future).toEqual([]);
    expect(history().past).toHaveLength(1);
    expect(history().undo(at(20))).toMatchObject({ label: 'tidy diagram', snapshot: at(10) });
  });

  it('has nothing to hand back when a stack is empty', () => {
    expect(history().undo(at(0))).toBeNull();
    expect(history().redo(at(0))).toBeNull();
  });

  it('leaves nothing to redo once a new change is made', () => {
    history().record('move bus 1', at(0));
    history().undo(at(10));
    expect(history().future).toHaveLength(1);
    history().record('align left (2 elements)', at(0));
    expect(history().future).toEqual([]);
  });

  it('keeps the newest arrangements when there are more than it holds', () => {
    for (let i = 0; i < MAX_LAYOUT_STEPS + 5; i += 1) history().record(`move ${i}`, at(i));
    expect(history().past).toHaveLength(MAX_LAYOUT_STEPS);
    expect(history().past[0]?.label).toBe('move 5');
  });

  it('drops an entry that was taken back some other way, while it is the newest', () => {
    const first = history().record('move bus 1', at(0));
    const second = history().record('reset to auto-layout', at(10));
    history().discard(first);
    expect(history().past).toHaveLength(2);
    history().discard(second);
    expect(history().past.map((step) => step.label)).toEqual(['move bus 1']);
  });

  it('gives each change an id of its own', () => {
    const first = history().record('move bus 1', at(0));
    const second = history().record('move bus 1', at(5));
    expect(second).not.toBe(first);
  });
});

describe('drafts that were deleted', () => {
  const draft = (id: string) => ({
    id,
    kind: 'PQ',
    position: { x: 1, y: 2 },
    values: { bus: '4' },
  });
  const NOTHING: LayoutSnapshot = { positions: {}, routes: {} };

  it('are one step of the history, which hands them back on undo and again on redo', () => {
    history().record('move bus 1', at(0));
    history().record('delete draft PQ load PQ_12', NOTHING, null, {
      caseKey: 'ieee14.raw',
      deleted: [draft('draft-1')],
    });
    const back = history().undo(at(10));
    expect(back).toMatchObject({
      label: 'delete draft PQ load PQ_12',
      drafts: { caseKey: 'ieee14.raw', deleted: [draft('draft-1')] },
    });
    // The step Redo takes carries them too: it deletes them again.
    expect(history().future.at(-1)?.drafts).toEqual(back?.drafts);
    expect(history().redo(at(10))?.drafts).toEqual(back?.drafts);
    // A move has none.
    history().undo(at(10));
    expect(history().undo(at(10))?.drafts).toBeUndefined();
  });

  it('are deleted again by Redo under the ids they came back with', () => {
    history().record('delete draft PQ load PQ_12', NOTHING, null, {
      caseKey: 'ieee14.raw',
      deleted: [draft('draft-1')],
    });
    history().undo(NOTHING);
    // A draft placed since had taken the id: it is back as another.
    history().redoDeletes([draft('draft-2')]);
    expect(history().redo(NOTHING)?.drafts?.deleted).toEqual([draft('draft-2')]);
    // With no such step waiting, nothing is changed.
    history().record('move bus 1', at(0));
    history().undo(at(5));
    const before = history().future;
    history().redoDeletes([draft('draft-9')]);
    expect(history().future).toBe(before);
  });

  it('leave no step once the notice of the delete has put them back, wherever the step is', () => {
    const deleted = history().record('delete draft PQ load PQ_12', NOTHING, null, {
      caseKey: 'ieee14.raw',
      deleted: [draft('draft-1')],
    });
    history().record('move bus 1', at(0));
    // Not the newest any more, which is all `discard` drops.
    history().discard(deleted);
    expect(history().past).toHaveLength(2);
    history().forget(deleted);
    expect(history().past.map((step) => step.label)).toEqual(['move bus 1']);
    // One that is not there is no change.
    const before = history().past;
    history().forget(deleted);
    expect(history().past).toBe(before);
  });
});

describe('moves by the arrow keys', () => {
  it('takes presses on the same nodes in quick succession for one move', () => {
    const first = history().record('move bus 1', at(0), 'nudge:1');
    vi.advanceTimersByTime(NUDGE_COALESCE_MS - 1);
    const second = history().record('move bus 1', at(5), 'nudge:1');
    expect(second).toBe(first);
    expect(history().past).toHaveLength(1);
    // What Undo goes back to is where the first press started from.
    expect(history().past[0]?.snapshot).toEqual(at(0));
    // Each press keeps the move open for the next.
    vi.advanceTimersByTime(NUDGE_COALESCE_MS - 1);
    history().record('move bus 1', at(10), 'nudge:1');
    expect(history().past).toHaveLength(1);
  });

  it('starts a new move after a pause, on other nodes, and after a drag', () => {
    history().record('move bus 1', at(0), 'nudge:1');
    vi.advanceTimersByTime(NUDGE_COALESCE_MS + 1);
    history().record('move bus 1', at(5), 'nudge:1');
    expect(history().past).toHaveLength(2);
    history().record('move bus 2', at(5), 'nudge:2');
    expect(history().past).toHaveLength(3);
    // A drag is never part of another move, and no press is part of a drag.
    history().record('move bus 2', at(5));
    history().record('move bus 2', at(5), 'nudge:2');
    expect(history().past).toHaveLength(5);
  });
});

describe('when the history is emptied', () => {
  it('starts afresh with another case', () => {
    history().record('move bus 1', at(0));
    history().undo(at(5));
    history().record('move bus 1', at(0));
    useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath('other.raw'), addfiles: [] });
    expect(history().past).toEqual([]);
    expect(history().future).toEqual([]);
    useCaseStore.getState().clearCase();
  });

  it('leaves nothing to redo once the system is edited', () => {
    history().record('move bus 1', at(0));
    history().undo(at(5));
    expect(history().future).toHaveLength(1);
    // Taking an edit back, or a save, is no new change.
    useEditJournalStore.getState().record({ op: 'undo' });
    useEditJournalStore.getState().markSaved();
    expect(history().future).toHaveLength(1);
    useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: {} });
    expect(history().future).toEqual([]);
  });
});

/** Journal entries for `ops`, numbered from 1. */
function entries(...ops: JournalOp[]): JournalEntry[] {
  return ops.map((op, i) => ({ ...op, rev: i + 1 }));
}

const add: JournalOp = { op: 'add', model: 'Bus', params: {} };
const edit: JournalOp = { op: 'edit', model: 'Bus', idx: '1', params: {} };
const cloneEdit: JournalOp = { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 1 };

describe('liveEditRevisions', () => {
  it('names the newest edit that is still in effect', () => {
    expect(liveEditRevisions([])).toEqual({ undoable: 0, redoable: 0 });
    expect(liveEditRevisions(entries(add, edit))).toEqual({ undoable: 2, redoable: 0 });
  });

  it('follows an undo back to the edit before, and a redo forward again', () => {
    // add (1), edit (2), undo (3): the add is the newest left, undone at 3.
    expect(liveEditRevisions(entries(add, edit, { op: 'undo' }))).toEqual({
      undoable: 1,
      redoable: 3,
    });
    // The redo (4) puts the edit back: it is the newest change again.
    expect(liveEditRevisions(entries(add, edit, { op: 'undo' }, { op: 'redo' }))).toEqual({
      undoable: 4,
      redoable: 0,
    });
  });

  it('has nothing left to redo after a new edit', () => {
    expect(liveEditRevisions(entries(add, { op: 'undo' }, edit))).toEqual({
      undoable: 3,
      redoable: 0,
    });
  });

  it('keeps the controller parameter edits apart, and takes the newer of the two histories', () => {
    expect(liveEditRevisions(entries(add, cloneEdit))).toEqual({ undoable: 2, redoable: 0 });
    expect(liveEditRevisions(entries(add, cloneEdit, { op: 'clone-undo' }))).toEqual({
      undoable: 1,
      redoable: 3,
    });
    expect(liveEditRevisions(entries(cloneEdit, { op: 'clone-reset' }))).toEqual({
      undoable: 0,
      redoable: 0,
    });
  });

  it('ignores an undo with nothing before it in the journal', () => {
    expect(liveEditRevisions(entries({ op: 'undo' }, { op: 'redo' }))).toEqual({
      undoable: 0,
      redoable: 0,
    });
  });
});

describe('undoTarget and redoTarget', () => {
  const step = (editRevision: number) => ({
    id: 1,
    label: 'move bus 1',
    snapshot: at(0),
    editRevision,
    coalesce: null,
    at: 0,
  });
  const clock = (list: JournalEntry[], replayable = true) => ({
    entries: list,
    revision: list.length,
    replayable,
  });

  it('acts on the one history that has something', () => {
    expect(undoTarget(null, false, clock([]))).toBeNull();
    expect(undoTarget(null, true, clock(entries(add)))).toBe('edit');
    expect(undoTarget(step(0), false, clock([]))).toBe('layout');
    expect(redoTarget(null, false, clock([]))).toBeNull();
    expect(redoTarget(null, true, clock([]))).toBe('edit');
    expect(redoTarget(step(0), false, clock([]))).toBe('layout');
  });

  it('takes back whichever was changed last', () => {
    // A move made after the add (revision 1): the move goes first.
    expect(undoTarget(step(1), true, clock(entries(add)))).toBe('layout');
    // A move made before it: the add goes first.
    expect(undoTarget(step(0), true, clock(entries(add)))).toBe('edit');
  });

  it('goes back to an earlier move once the edits made after it are taken back', () => {
    // add (1), the move, edit (2), undo (3): the edit is gone, and the add
    // was made before the move.
    const list = entries(add, edit, { op: 'undo' });
    expect(undoTarget(step(1), true, clock(list))).toBe('layout');
    // With the move made before the add, the add is still the newer.
    expect(undoTarget(step(0), true, clock(list))).toBe('edit');
  });

  it('puts back whichever was taken back last', () => {
    // An edit undone at revision 2, then a move undone (it carries revision 2).
    const list = entries(add, { op: 'undo' });
    expect(redoTarget(step(2), true, clock(list))).toBe('layout');
    // A move undone before that edit was undone.
    expect(redoTarget(step(1), true, clock(list))).toBe('edit');
  });

  it('goes by the count of changes where the journal no longer lists the edits', () => {
    const opaque = { entries: [], revision: 7, replayable: false };
    expect(undoTarget(step(7), true, opaque)).toBe('layout');
    expect(undoTarget(step(6), true, opaque)).toBe('edit');
    expect(redoTarget(step(7), true, opaque)).toBe('layout');
    expect(redoTarget(step(6), true, opaque)).toBe('edit');
  });
});

describe('what an entry carries', () => {
  it('notes the revision of the edit journal when it is recorded, and when it is taken back', () => {
    useEditJournalStore.getState().record(add);
    history().record('move bus 1', at(0));
    expect(history().past[0]?.editRevision).toBe(1);
    useEditJournalStore.getState().record(edit);
    history().undo(at(5));
    expect(history().future[0]?.editRevision).toBe(2);
  });
});
