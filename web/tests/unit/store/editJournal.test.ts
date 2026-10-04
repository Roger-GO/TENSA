/**
 * The edit journal: what it records, what it drops as pointless to replay, and
 * what it counts as unsaved work.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_JOURNAL_ENTRIES,
  compactJournal,
  hasEditsNotInFile,
  hasUnsavedEdits,
  useEditJournalStore,
} from '@/store/editJournal';
import type { JournalEntry, JournalOp } from '@/store/editJournal';
import { useCaseStore } from '@/store/case';
import { parseWorkspacePath } from '@/api/types';

const FILE_CASE = { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] };
const BLANK_CASE = { primaryPath: null, addfiles: [], blank: true };

const addBus = (idx: number): JournalOp => ({ op: 'add', model: 'Bus', params: { idx, Vn: 110 } });

function ops(): string[] {
  return useEditJournalStore.getState().entries.map((e) => e.op);
}

function record(...list: JournalOp[]): void {
  for (const op of list) useEditJournalStore.getState().record(op);
}

function entry(op: JournalOp, rev: number): JournalEntry {
  return { ...op, rev };
}

beforeEach(() => {
  useCaseStore.setState({ selection: FILE_CASE });
  useEditJournalStore.getState().reset();
});

afterEach(() => {
  useCaseStore.setState({ selection: null });
  useEditJournalStore.getState().reset();
});

describe('record', () => {
  it('keeps operations in the order they happened, each with a newer revision', () => {
    record(addBus(1), addBus(2), { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } });

    const { entries } = useEditJournalStore.getState();
    expect(entries.map((e) => e.op)).toEqual(['add', 'add', 'edit']);
    expect(entries.map((e) => e.rev)).toEqual([1, 2, 3]);
  });

  it('merges back-to-back edits to one element, later values winning', () => {
    record(
      { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230, v0: 1.0 } },
      { op: 'edit', model: 'Bus', idx: '1', params: { v0: 1.02 } },
    );

    const { entries } = useEditJournalStore.getState();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: 'edit', params: { Vn: 230, v0: 1.02 }, rev: 2 });
  });

  it('does not merge edits to different elements, or edits with something between them', () => {
    record(
      { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } },
      { op: 'edit', model: 'Bus', idx: '2', params: { Vn: 230 } },
      addBus(3),
      { op: 'edit', model: 'Bus', idx: '2', params: { Vn: 110 } },
    );

    expect(ops()).toEqual(['edit', 'edit', 'add', 'edit']);
  });

  it('gives up past the cap: nothing to replay, but the unsaved work is still known', () => {
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 1; i += 1) record(addBus(i));

    const state = useEditJournalStore.getState();
    expect(state.replayable).toBe(false);
    expect(state.entries).toEqual([]);
    expect(hasUnsavedEdits()).toBe(true);
  });
});

describe('compactJournal', () => {
  it('drops a clone reset and everything before it on a file-backed case', () => {
    const entries = [
      entry(addBus(1), 1),
      entry({ op: 'clone-init' }, 2),
      entry({ op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 50 }, 3),
      entry({ op: 'clone-reset' }, 4),
    ];

    expect(compactJournal(entries, true)).toEqual([]);
  });

  it('drops the non-clone entries before a reload on a file-backed case, keeping the clone ones', () => {
    const entries = [
      entry(addBus(1), 1),
      entry({ op: 'clone-init' }, 2),
      entry({ op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 50 }, 3),
      entry({ op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } }, 4),
      entry({ op: 'reload' }, 5),
    ];

    expect(compactJournal(entries, true).map((e) => e.op)).toEqual([
      'clone-init',
      'clone-edit',
      'reload',
    ]);
  });

  it('drops a reload that has nothing left before it, since a fresh load is that', () => {
    const entries = [entry(addBus(1), 1), entry({ op: 'reload' }, 2)];

    expect(compactJournal(entries, true)).toEqual([]);
  });

  it('keeps a blank system adds across a reload, since the substrate replays them', () => {
    const entries = [
      entry(addBus(1), 1),
      entry({ op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } }, 2),
      entry({ op: 'reload' }, 3),
    ];

    expect(compactJournal(entries, false).map((e) => e.op)).toEqual(['add', 'edit', 'reload']);
  });

  it('collapses a run of reloads to the last', () => {
    const entries = [
      entry(addBus(1), 1),
      entry({ op: 'reload' }, 2),
      entry({ op: 'reload' }, 3),
      entry({ op: 'reload' }, 4),
    ];

    const out = compactJournal(entries, false);

    expect(out.map((e) => e.op)).toEqual(['add', 'reload']);
    expect(out[1]?.rev).toBe(4);
  });

  it('is applied as the user records: edit, run, reset, edit, run, reset leaves no re-parses', () => {
    for (let round = 0; round < 3; round += 1) {
      record({ op: 'edit', model: 'Bus', idx: '1', params: { Vn: 100 + round } }, { op: 'reload' });
    }

    expect(ops()).toEqual([]);
  });

  it('keeps a blank build whole through a run and a reset', () => {
    useCaseStore.setState({ selection: BLANK_CASE });
    record(addBus(1), addBus(2), { op: 'reload' }, addBus(3), { op: 'reload' });

    expect(ops()).toEqual(['add', 'add', 'reload', 'add', 'reload']);
  });
});

describe('unsaved work', () => {
  it('is none for a journal that only holds bookkeeping', () => {
    record({ op: 'clone-init' }, { op: 'reload' });

    expect(hasUnsavedEdits()).toBe(false);
  });

  it.each<[string, JournalOp]>([
    ['an add', addBus(1)],
    ['an edit', { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } }],
    ['a delete', { op: 'delete', model: 'Bus', idx: '1' }],
    ['an undo', { op: 'undo' }],
    ['a clone edit', { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 50 }],
  ])('counts %s', (_label, op) => {
    record(op);

    expect(hasUnsavedEdits()).toBe(true);
  });

  it('is cleared by a save, and returns with the next edit', () => {
    record(addBus(1));
    useEditJournalStore.getState().markSaved();
    expect(hasUnsavedEdits()).toBe(false);

    record({ op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } });
    expect(hasUnsavedEdits()).toBe(true);
  });

  it('counts an edit merged into one that a save already covered', () => {
    record({ op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } });
    useEditJournalStore.getState().markSaved();

    record({ op: 'edit', model: 'Bus', idx: '1', params: { v0: 1.02 } });

    expect(hasUnsavedEdits()).toBe(true);
  });

  it('counts work the journal cannot replay, until a save', () => {
    useEditJournalStore.getState().markOpaque();
    expect(hasUnsavedEdits()).toBe(true);
    expect(useEditJournalStore.getState().replayable).toBe(false);

    useEditJournalStore.getState().markSaved();
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('after a replacement (restore, import) starts clean but cannot be replayed', () => {
    record(addBus(1));

    useEditJournalStore.getState().markReplaced();

    const state = useEditJournalStore.getState();
    expect(state.replayable).toBe(false);
    expect(state.entries).toEqual([]);
    expect(hasUnsavedEdits()).toBe(false);

    record(addBus(2));
    expect(hasUnsavedEdits()).toBe(true);
  });
});

describe('a save over the open case file', () => {
  it('drops the entries the file now holds, so a recovery does not apply them twice', () => {
    record(addBus(1), { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } }, addBus(2));

    useEditJournalStore.getState().markSavedInPlace();

    expect(ops()).toEqual([]);
    expect(hasUnsavedEdits()).toBe(false);
    expect(hasEditsNotInFile()).toBe(false);
  });

  it('keeps what came after it, and the clone operations, which are not in the file', () => {
    record(
      addBus(1),
      { op: 'clone-init' },
      { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 50 },
    );
    useEditJournalStore.getState().markSavedInPlace();
    record(addBus(2));

    expect(ops()).toEqual(['clone-init', 'clone-edit', 'add']);
    expect(hasEditsNotInFile()).toBe(true);
    expect(useEditJournalStore.getState().entries.at(-1)).toMatchObject({
      params: { idx: 2 },
    });
  });

  it('does not merge the first edit after it into one the file already holds', () => {
    record({ op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } });
    useEditJournalStore.getState().markSavedInPlace();
    record({ op: 'edit', model: 'Bus', idx: '1', params: { v0: 1.02 } });

    expect(useEditJournalStore.getState().entries).toMatchObject([
      { op: 'edit', params: { v0: 1.02 } },
    ]);
  });

  it('counts work the journal could not record as saved, once it is in the file', () => {
    useEditJournalStore.getState().markOpaque();
    expect(hasEditsNotInFile()).toBe(true);

    useEditJournalStore.getState().markSavedInPlace();

    expect(hasEditsNotInFile()).toBe(false);
    expect(hasUnsavedEdits()).toBe(false);
  });
});

describe('edits not in the open file', () => {
  it('are not settled by a save under another name, which settles the unsaved work', () => {
    record(addBus(1));

    useEditJournalStore.getState().markSaved();

    expect(hasUnsavedEdits()).toBe(false);
    expect(hasEditsNotInFile()).toBe(true);
  });

  it('are none for a journal that only holds bookkeeping, or after a reload', () => {
    record({ op: 'clone-init' });
    expect(hasEditsNotInFile()).toBe(false);

    record(addBus(1), { op: 'reload' });
    expect(hasEditsNotInFile()).toBe(false);
  });

  it('start over with the journal when another case is chosen', () => {
    record(addBus(1));
    useEditJournalStore.getState().markSavedInPlace();
    record(addBus(2));

    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('b.raw'), addfiles: [] },
    });

    expect(useEditJournalStore.getState().fileSavedRevision).toBe(0);
    expect(hasEditsNotInFile()).toBe(false);
  });
});

describe('replaced', () => {
  it('is set by a replacement, so a save knows the system is not the open file any more', () => {
    expect(useEditJournalStore.getState().replaced).toBe(false);

    useEditJournalStore.getState().markReplaced();

    expect(useEditJournalStore.getState().replaced).toBe(true);
    // Edits on top of the replacement do not bring the file back.
    record(addBus(2));
    expect(useEditJournalStore.getState().replaced).toBe(true);
  });

  it('is cleared by a reload, which puts the open case file back', () => {
    useEditJournalStore.getState().markReplaced();

    record({ op: 'reload' });

    expect(useEditJournalStore.getState().replaced).toBe(false);
  });

  it('is cleared by choosing another case', () => {
    useEditJournalStore.getState().markReplaced();

    useCaseStore
      .getState()
      .setCase({ primaryPath: parseWorkspacePath('kundur.xlsx'), addfiles: [] });

    expect(useEditJournalStore.getState().replaced).toBe(false);
  });

  it('is not set by a save, a plain edit or an undo', () => {
    record(addBus(1), { op: 'undo' });
    useEditJournalStore.getState().markSaved();

    expect(useEditJournalStore.getState().replaced).toBe(false);
  });
});

describe('truncateAfter', () => {
  it('keeps the entries up to and including a revision', () => {
    record(addBus(1), addBus(2), addBus(3));

    useEditJournalStore.getState().truncateAfter(2);

    expect(useEditJournalStore.getState().entries.map((e) => e.rev)).toEqual([1, 2]);
  });

  it('with revision 0 empties it', () => {
    record(addBus(1));

    useEditJournalStore.getState().truncateAfter(0);

    expect(ops()).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('starts over when the case selection changes', () => {
    record(addBus(1));
    useEditJournalStore.getState().markOpaque();

    useCaseStore
      .getState()
      .setCase({ primaryPath: parseWorkspacePath('kundur.xlsx'), addfiles: [] });

    const state = useEditJournalStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.replayable).toBe(true);
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('starts over when the case is cleared', () => {
    record(addBus(1));

    useCaseStore.getState().clearCase();

    expect(ops()).toEqual([]);
  });

  it('survives a change that leaves the selection alone, which is what a recovery does', () => {
    record(addBus(1));

    useCaseStore.setState({ topology: null, cloneInitialized: false });

    expect(ops()).toEqual(['add']);
  });
});
