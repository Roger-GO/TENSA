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
    expect(options).toMatchObject({
      description: 'It was never added to the system, so nothing else changed.',
      action: { label: 'Undo' },
    });
    (options as { action: { onClick: () => void } }).action.onClick();
    // Back under an id of its own, picked.
    expect(drafts()[CASE]?.at(-1)).toMatchObject({
      kind: 'PV',
      position: { x: 1, y: 2 },
      values: { bus: '4' },
    });
    expect(useSldStore.getState().selectedNodeId).toBe(drafts()[CASE]?.at(-1)?.id);
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
