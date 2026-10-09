/**
 * What is done to a draft from more than one place: picking it, placing one
 * where no diagram is drawn yet, and deleting one or all of them, with a
 * notice that puts them back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspacePath } from '@/api/types';
import {
  deleteAllDrafts,
  deleteDraft,
  deselectDraft,
  placeDraftOffCanvas,
  selectDraft,
} from '@/components/sld/draftActions';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import {
  BLANK_CASE_KEY,
  DRAFT_NODE_SIZE,
  MAX_DRAFTS_PER_CASE,
  useDraftsStore,
} from '@/store/drafts';
import { useLayoutHistoryStore } from '@/store/layoutHistory';
import { useSldStore } from '@/store/sld';

const CASE = 'ieee14.raw';
const drafts = () => useDraftsStore.getState().byCase;

beforeEach(() => {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath(CASE), addfiles: [] },
    selectedElement: null,
  });
  useDraftsStore.setState({ byCase: {}, placements: {} });
  useSldStore.getState().clearSelectedNodeId();
});

afterEach(() => {
  vi.restoreAllMocks();
  useCaseStore.setState({ selection: null, selectedElement: null });
  useDraftsStore.setState({ byCase: {}, placements: {} });
  useSldStore.getState().clearSelectedNodeId();
});

describe('picking a draft', () => {
  it('lets go of the element that was inspected, and marks the draft on the diagram', () => {
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '4' } });
    selectDraft('draft-2');
    expect(useCaseStore.getState().selectedElement).toBeNull();
    expect(useSldStore.getState()).toMatchObject({
      selectedNodeId: 'draft-2',
      selectedOnDiagram: false,
    });
    // A pick on the diagram itself says so, which keeps the zoom.
    selectDraft('draft-2', 'diagram');
    expect(useSldStore.getState().selectedOnDiagram).toBe(true);
  });

  it('is let go of only if that draft is the one that is picked', () => {
    selectDraft('draft-2');
    deselectDraft('draft-1');
    expect(useSldStore.getState().selectedNodeId).toBe('draft-2');
    deselectDraft('draft-2');
    expect(useSldStore.getState().selectedNodeId).toBeNull();
  });
});

describe('placing a draft where no diagram is drawn yet', () => {
  it('puts it at the middle of the diagram that is drawn for it, and picks it', () => {
    const draft = placeDraftOffCanvas('Bus');
    expect(draft).toEqual({
      id: 'draft-1',
      kind: 'Bus',
      position: { x: -DRAFT_NODE_SIZE.width / 2, y: -DRAFT_NODE_SIZE.height / 2 },
      values: {},
    });
    expect(drafts()[CASE]).toEqual([draft]);
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
  });

  it('goes under the key of a system built from scratch for one', () => {
    useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
    placeDraftOffCanvas('Bus');
    expect(drafts()[BLANK_CASE_KEY]).toHaveLength(1);
  });

  it('does nothing with no case open', () => {
    useCaseStore.setState({ selection: null });
    expect(placeDraftOffCanvas('Bus')).toBeNull();
    expect(drafts()).toEqual({});
  });

  it('says so when the diagram holds as many drafts as it can', () => {
    const error = vi.spyOn(toast, 'error');
    const { add } = useDraftsStore.getState();
    for (let i = 0; i < MAX_DRAFTS_PER_CASE; i += 1) add(CASE, 'PQ', { x: i, y: 0 });
    expect(placeDraftOffCanvas('Bus')).toBeNull();
    expect(error).toHaveBeenCalledWith(
      'This diagram holds as many drafts as it can.',
      expect.objectContaining({ description: expect.stringContaining('delete') }),
    );
  });
});

describe('deleting drafts', () => {
  it('deletes one, lets go of it, and offers to put it back with what it held', () => {
    const info = vi.spyOn(toast, 'info');
    const { add } = useDraftsStore.getState();
    add(CASE, 'PV', { x: 1, y: 2 }, { bus: '4' });
    add(CASE, 'PQ', { x: 3, y: 4 });
    selectDraft('draft-1');
    deleteDraft(CASE, 'draft-1', 'PV generator 6');
    expect(drafts()[CASE]?.map((d) => d.id)).toEqual(['draft-2']);
    expect(useSldStore.getState().selectedNodeId).toBeNull();
    const [title, options] = info.mock.calls[0]!;
    expect(title).toBe('Draft deleted: PV generator 6');
    // Long enough to read and reach, and it names the way back that stays.
    expect(options).toMatchObject({
      description:
        'It was never added to the system, so nothing else changed. Undo (Ctrl+Z or Edit > Undo) brings it back as well.',
      duration: 12_000,
      action: { label: 'Undo' },
    });
    // The delete is one step of the history Undo goes back through.
    const step = useLayoutHistoryStore.getState().past.at(-1);
    expect(step).toMatchObject({
      label: 'delete draft PV generator 6',
      drafts: { caseKey: CASE, deleted: [{ id: 'draft-1', kind: 'PV', values: { bus: '4' } }] },
    });
    (options as { action: { onClick: () => void } }).action.onClick();
    // Back as it was, under the id it had and in its place, and picked.
    expect(drafts()[CASE]).toEqual([
      { id: 'draft-1', kind: 'PV', position: { x: 1, y: 2 }, values: { bus: '4' } },
      { id: 'draft-2', kind: 'PQ', position: { x: 3, y: 4 }, values: {} },
    ]);
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    // Taken back by the notice: Undo has no step left for it.
    expect(useLayoutHistoryStore.getState().past).toEqual([]);
  });

  it('puts a deleted draft back under a free id when a draft placed since took its own', () => {
    const info = vi.spyOn(toast, 'info');
    const { add } = useDraftsStore.getState();
    add(CASE, 'PV', { x: 1, y: 2 }, { bus: '4' });
    deleteDraft(CASE, 'draft-1', 'PV generator 6');
    // The next drop gets the number that was just freed.
    expect(add(CASE, 'PQ', { x: 9, y: 9 })?.id).toBe('draft-1');
    const [, options] = info.mock.calls[0]!;
    (options as { action: { onClick: () => void } }).action.onClick();
    expect(drafts()[CASE]?.map((d) => [d.id, d.kind])).toEqual([
      ['draft-1', 'PQ'],
      ['draft-2', 'PV'],
    ]);
  });

  it('makes no second copy when Undo in the Edit menu brought the draft back before the Undo of the notice', () => {
    const info = vi.spyOn(toast, 'info');
    const { add } = useDraftsStore.getState();
    add(CASE, 'PV', { x: 1, y: 2 }, { bus: '4' });
    deleteDraft(CASE, 'draft-1', 'PV generator 6');
    // Ctrl+Z, as the canvas takes the step back: the draft is there again,
    // and its step waits for a Redo.
    const step = useLayoutHistoryStore.getState().undo({ positions: {}, routes: {} })!;
    useDraftsStore.getState().restore(CASE, step.drafts!.deleted);
    expect(drafts()[CASE]?.map((d) => d.id)).toEqual(['draft-1']);

    const [, options] = info.mock.calls[0]!;
    (options as { action: { onClick: () => void } }).action.onClick();
    expect(drafts()[CASE]).toEqual([
      { id: 'draft-1', kind: 'PV', position: { x: 1, y: 2 }, values: { bus: '4' } },
    ]);
    // The step is still there for a Redo.
    expect(useLayoutHistoryStore.getState().future.map((entry) => entry.id)).toEqual([step.id]);
  });

  it('says nothing of a draft that is not there', () => {
    const info = vi.spyOn(toast, 'info');
    deleteDraft(CASE, 'draft-9', 'nothing');
    expect(info).not.toHaveBeenCalled();
  });

  it('deletes them all, and puts them all back', () => {
    const info = vi.spyOn(toast, 'info');
    const { add } = useDraftsStore.getState();
    add(CASE, 'PV', { x: 1, y: 2 });
    add(CASE, 'PQ', { x: 3, y: 4 }, { bus: '9' });
    selectDraft('draft-2');
    deleteAllDrafts(CASE);
    expect(drafts()[CASE]).toBeUndefined();
    expect(useSldStore.getState().selectedNodeId).toBeNull();
    const [title, options] = info.mock.calls[0]!;
    expect(title).toBe('2 drafts deleted');
    (options as { action: { onClick: () => void } }).action.onClick();
    expect(drafts()[CASE]?.map((d) => [d.kind, d.values])).toEqual([
      ['PV', {}],
      ['PQ', { bus: '9' }],
    ]);
    // Nothing to delete, nothing said.
    info.mockClear();
    deleteAllDrafts('other.raw');
    expect(info).not.toHaveBeenCalled();
  });
});
