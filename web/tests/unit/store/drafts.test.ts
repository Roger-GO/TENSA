/**
 * Tests for the drafts slice: the elements that were placed on the diagram
 * and are not in the system yet. They are kept by the case file they were made
 * on, in this browser (localStorage), so they are there again after a reload
 * of the page; the drafts of a system built from scratch are kept in memory
 * and go with that system; and a storage that is missing, broken or holding
 * something else leaves the drafts working for the tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspacePath } from '@/api/types';

const KEY = 'tensa:sld-drafts-v1';
const CASE = 'ieee14.raw';

/** An in-memory `localStorage` whose methods a test can replace. */
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    getItem: (key) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
}

function stored(): unknown {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}

async function load() {
  const drafts = await import('@/store/drafts');
  const { useCaseStore } = await import('@/store/case');
  return { ...drafts, useCaseStore };
}

describe('drafts store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('places a draft with an id of its own, where it was dropped', async () => {
    const { useDraftsStore } = await load();
    const first = useDraftsStore.getState().add(CASE, 'PV', { x: 10, y: 20 });
    const second = useDraftsStore.getState().add(CASE, 'Bus', { x: 30, y: 40 }, { Vn: '69' });
    expect(first).toEqual({ id: 'draft-1', kind: 'PV', position: { x: 10, y: 20 }, values: {} });
    expect(second).toEqual({
      id: 'draft-2',
      kind: 'Bus',
      position: { x: 30, y: 40 },
      values: { Vn: '69' },
    });
    expect(useDraftsStore.getState().byCase[CASE]).toEqual([first, second]);
  });

  it('never gives an id out twice, also after a draft was deleted', async () => {
    const { useDraftsStore } = await load();
    const { add, remove } = useDraftsStore.getState();
    add(CASE, 'PV', { x: 0, y: 0 });
    add(CASE, 'PQ', { x: 0, y: 0 });
    remove(CASE, 'draft-1');
    expect(add(CASE, 'Bus', { x: 0, y: 0 })?.id).toBe('draft-3');
  });

  it('keeps the fields that are set, and lets go of one set to null', async () => {
    const { useDraftsStore } = await load();
    const { add, setValues } = useDraftsStore.getState();
    add(CASE, 'ESD1', { x: 0, y: 0 });
    setValues(CASE, 'draft-1', { bus: '4', gen: 'PV_1' });
    setValues(CASE, 'draft-1', { gen: null, Sn: '' });
    // An empty value is one the user left empty; `null` is a field nobody set.
    expect(useDraftsStore.getState().byCase[CASE]?.[0]?.values).toEqual({ bus: '4', Sn: '' });
  });

  it('counts each value the diagram gives a draft, so a form that is open on it can be opened afresh', async () => {
    const { useDraftsStore, useCaseStore } = await load();
    const { add, connect, setValues } = useDraftsStore.getState();
    add(CASE, 'PQ', { x: 0, y: 0 });
    // What the form sets itself is not counted: it holds that already.
    setValues(CASE, 'draft-1', { p0: '0.2' });
    expect(useDraftsStore.getState().connected).toEqual({});
    connect(CASE, 'draft-1', { bus: '4' });
    expect(useDraftsStore.getState().byCase[CASE]?.[0]?.values).toEqual({ p0: '0.2', bus: '4' });
    expect(useDraftsStore.getState().connected).toEqual({ 'draft-1': 1 });
    connect(CASE, 'draft-1', { bus: '5' });
    expect(useDraftsStore.getState().connected).toEqual({ 'draft-1': 2 });
    expect(stored()).toEqual({
      [CASE]: [expect.objectContaining({ values: { p0: '0.2', bus: '5' } })],
    });
    // A draft the case does not hold is given nothing, and nothing is counted for it.
    connect(CASE, 'draft-9', { bus: '4' });
    expect(useDraftsStore.getState().connected).toEqual({ 'draft-1': 2 });
    // The count is the diagram's: the drafts of the next case go by the same ids.
    useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath('other.raw'), addfiles: [] });
    expect(useDraftsStore.getState().connected).toEqual({});
  });

  it('moves the drafts that are named, and leaves the state alone when none moved', async () => {
    const { useDraftsStore } = await load();
    const { add, move } = useDraftsStore.getState();
    add(CASE, 'PV', { x: 1, y: 2 });
    add(CASE, 'PQ', { x: 3, y: 4 });
    move(CASE, { 'draft-2': { x: 30, y: 40 }, 'draft-9': { x: 0, y: 0 } });
    const moved = useDraftsStore.getState().byCase;
    expect(moved[CASE]?.map((d) => d.position)).toEqual([
      { x: 1, y: 2 },
      { x: 30, y: 40 },
    ]);
    move(CASE, { 'draft-2': { x: 30, y: 40 } });
    expect(useDraftsStore.getState().byCase).toBe(moved);
  });

  it('writes the drafts of a case file to localStorage, and reads them at start', async () => {
    const first = await load();
    first.useDraftsStore.getState().add(CASE, 'PV', { x: 10, y: 20 }, { bus: '3' });
    expect(stored()).toEqual({
      [CASE]: [{ id: 'draft-1', kind: 'PV', position: { x: 10, y: 20 }, values: { bus: '3' } }],
    });
    // A reload of the page: the modules are evaluated again.
    vi.resetModules();
    const second = await load();
    expect(second.useDraftsStore.getState().byCase[CASE]).toEqual([
      { id: 'draft-1', kind: 'PV', position: { x: 10, y: 20 }, values: { bus: '3' } },
    ]);
  });

  it('removes the entry from localStorage with the last draft', async () => {
    const { useDraftsStore } = await load();
    useDraftsStore.getState().add(CASE, 'PV', { x: 0, y: 0 });
    useDraftsStore.getState().remove(CASE, 'draft-1');
    expect(stored()).toBeNull();
    expect(useDraftsStore.getState().byCase[CASE]).toBeUndefined();
  });

  it('keeps the drafts of a system built from scratch in memory only', async () => {
    const { useDraftsStore, BLANK_CASE_KEY } = await load();
    useDraftsStore.getState().add(BLANK_CASE_KEY, 'Bus', { x: 0, y: 0 });
    expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toHaveLength(1);
    expect(stored()).toBeNull();
  });

  it('drops what a broken or foreign storage holds', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        [CASE]: [
          { id: 'draft-1', kind: 'PV', position: { x: 1, y: 2 }, values: {} },
          // The same id again, no position, an id of another form, a value that is no value.
          { id: 'draft-1', kind: 'PQ', position: { x: 1, y: 2 }, values: {} },
          { id: 'draft-2', kind: 'PQ', values: {} },
          { id: 'node-3', kind: 'PQ', position: { x: 1, y: 2 }, values: {} },
          { id: 'draft-4', kind: 'PQ', position: { x: 1, y: 2 }, values: { bus: { idx: 1 } } },
        ],
        'other.raw': 'not a list',
        ':blank': [{ id: 'draft-1', kind: 'Bus', position: { x: 0, y: 0 }, values: {} }],
      }),
    );
    const { useDraftsStore } = await load();
    expect(useDraftsStore.getState().byCase).toEqual({
      [CASE]: [{ id: 'draft-1', kind: 'PV', position: { x: 1, y: 2 }, values: {} }],
    });
  });

  it('reads nothing from a storage that is not JSON, and still takes drafts', async () => {
    window.localStorage.setItem(KEY, '{ not json');
    const { useDraftsStore } = await load();
    expect(useDraftsStore.getState().byCase).toEqual({});
    expect(useDraftsStore.getState().add(CASE, 'PV', { x: 0, y: 0 })).not.toBeNull();
  });

  it('keeps working when storage refuses a write', async () => {
    const { useDraftsStore } = await load();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(useDraftsStore.getState().add(CASE, 'PV', { x: 0, y: 0 })?.id).toBe('draft-1');
    expect(useDraftsStore.getState().byCase[CASE]).toHaveLength(1);
  });

  it('refuses a draft over the cap of a case', async () => {
    const { useDraftsStore, MAX_DRAFTS_PER_CASE } = await load();
    const { add } = useDraftsStore.getState();
    for (let i = 0; i < MAX_DRAFTS_PER_CASE; i += 1) add(CASE, 'PQ', { x: i, y: 0 });
    expect(add(CASE, 'PQ', { x: 0, y: 0 })).toBeNull();
    expect(useDraftsStore.getState().byCase[CASE]).toHaveLength(MAX_DRAFTS_PER_CASE);
  });

  it('gives a copy of the system that is saved under another name the drafts as well', async () => {
    const { useDraftsStore, BLANK_CASE_KEY } = await load();
    const { add, copy, setValues } = useDraftsStore.getState();
    add(BLANK_CASE_KEY, 'Bus', { x: 1, y: 2 }, { Vn: '110' });
    add(BLANK_CASE_KEY, 'PQ', { x: 3, y: 4 });
    add('saved.xlsx', 'Shunt', { x: 0, y: 0 });
    copy(BLANK_CASE_KEY, 'saved.xlsx');
    // In the place of what the file had, and kept with it in this browser.
    expect(useDraftsStore.getState().byCase['saved.xlsx']).toEqual(
      useDraftsStore.getState().byCase[BLANK_CASE_KEY],
    );
    expect(stored()).toMatchObject({ 'saved.xlsx': [{ kind: 'Bus' }, { kind: 'PQ' }] });
    // Each is its own from there on.
    setValues('saved.xlsx', 'draft-1', { Vn: '230' });
    expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]?.[0]?.values).toEqual({ Vn: '110' });
  });

  it('copies nothing onto the case itself, and nothing from a case that has no drafts', async () => {
    const { useDraftsStore } = await load();
    const { add, copy } = useDraftsStore.getState();
    add(CASE, 'PV', { x: 0, y: 0 });
    const before = useDraftsStore.getState().byCase;
    copy(CASE, CASE);
    copy('none.raw', 'other.raw');
    expect(useDraftsStore.getState().byCase).toBe(before);
    // A copy from a case with none takes the drafts of the file it replaces away.
    copy('none.raw', CASE);
    expect(useDraftsStore.getState().byCase[CASE]).toBeUndefined();
  });

  it('names the drafts of the open case by its file, and of a blank system by one key', async () => {
    const { draftCaseKey, BLANK_CASE_KEY } = await load();
    expect(draftCaseKey(null)).toBeNull();
    expect(draftCaseKey({ primaryPath: parseWorkspacePath(CASE), addfiles: [] })).toBe(CASE);
    expect(draftCaseKey({ primaryPath: null, addfiles: [], blank: true })).toBe(BLANK_CASE_KEY);
  });

  it('lets the drafts of a blank system go with it, and keeps those of a case file', async () => {
    const { useDraftsStore, useCaseStore, BLANK_CASE_KEY } = await load();
    useCaseStore.getState().setCase({ primaryPath: null, addfiles: [], blank: true });
    useDraftsStore.getState().add(BLANK_CASE_KEY, 'Bus', { x: 0, y: 0 });
    useDraftsStore.getState().add(CASE, 'PV', { x: 0, y: 0 });
    useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(CASE), addfiles: [] });
    expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toBeUndefined();
    expect(useDraftsStore.getState().byCase[CASE]).toHaveLength(1);
    // Closing the case file leaves its drafts for the next time it is opened.
    useCaseStore.getState().clearCase();
    expect(useDraftsStore.getState().byCase[CASE]).toHaveLength(1);
  });

  it('keeps the place of an added element until it is taken over or the case goes', async () => {
    const { useDraftsStore, useCaseStore } = await load();
    useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(CASE), addfiles: [] });
    const { place, forgetPlacements } = useDraftsStore.getState();
    place('generator-6', { x: 5, y: 6 });
    place('15', { x: 7, y: 8 });
    forgetPlacements(['generator-6', 'load-1']);
    expect(useDraftsStore.getState().placements).toEqual({ '15': { x: 7, y: 8 } });
    useCaseStore.getState().clearCase();
    expect(useDraftsStore.getState().placements).toEqual({});
  });
});
