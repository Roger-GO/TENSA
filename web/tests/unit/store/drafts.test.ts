/**
 * Tests for the drafts slice: the elements that were placed on the diagram
 * and are not in the system yet. They are kept by the case file they were made
 * on, in this browser (localStorage), so they are there again after a reload
 * of the page; the drafts of a system built from scratch go with that system,
 * and are kept in the tab for a reload of it; and a storage that is missing, broken or holding
 * something else leaves the drafts working for the tab. How the lines ran
 * among the drafts of a case is kept with them, by the system it was drawn
 * for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspacePath } from '@/api/types';
import type { KeptDraftRoutes } from '@/store/drafts';

const KEY = 'tensa:sld-drafts-v1';
const ROUTES_KEY = 'tensa:sld-draft-routes-v1';
const CASE = 'ieee14.raw';

/** A way round a draft and the route of a draft line, as a diagram leaves them to be kept. */
function kept(stand: string): KeptDraftRoutes {
  const anchors = { source: { x: 0, y: 0 }, target: { x: 96, y: 144 } };
  return {
    stand,
    own: {
      'draft-line-draft-2': {
        points: [
          [16, 3],
          [16, 147],
        ],
        anchors,
      },
    },
    round: {
      'line-L1': {
        points: [
          [32, 3],
          [32, 64],
          [112, 64],
          [112, 147],
        ],
        anchors,
        from: '[[32,3],[32,147]]',
      },
    },
  };
}

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

function stored(key = KEY): unknown {
  const raw = window.localStorage.getItem(key);
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
    window.sessionStorage.clear();
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

  it('keeps the drafts of a system built from scratch out of what the browser keeps for a later visit', async () => {
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

  it('keeps the drafts of a case file by the workspace the server serves as well as by its name', async () => {
    // A file of the same name in another workspace, served on the same
    // address, is another case: its drafts are not these.
    const { draftCaseKey, draftKeyOfPath, useDraftsStore, BLANK_CASE_KEY } = await load();
    const { useSessionStore } = await import('@/store/session');
    const selection = { primaryPath: parseWorkspacePath(CASE), addfiles: [] };
    useSessionStore.getState().setWorkspaceId('0123456789abcdef');
    const here = draftCaseKey(selection)!;
    expect(here).toBe(`0123456789abcdef:${CASE}`);
    expect(draftKeyOfPath(CASE)).toBe(here);
    useDraftsStore.getState().add(here, 'PV', { x: 0, y: 0 });
    useSessionStore.getState().setWorkspaceId('fedcba9876543210');
    const there = draftCaseKey(selection)!;
    expect(there).not.toBe(here);
    expect(useDraftsStore.getState().byCase[there]).toBeUndefined();
    // A blank system is no file, in any workspace.
    expect(draftCaseKey({ primaryPath: null, addfiles: [], blank: true })).toBe(BLANK_CASE_KEY);
    useSessionStore.getState().setWorkspaceId(null);
  });

  it('puts deleted drafts back as they were, under the ids they had', async () => {
    const { useDraftsStore } = await load();
    const { add, remove, restore } = useDraftsStore.getState();
    const first = add(CASE, 'PV', { x: 1, y: 2 }, { bus: '4' })!;
    const second = add(CASE, 'PQ', { x: 3, y: 4 })!;
    remove(CASE, first.id);
    expect(restore(CASE, [first])).toEqual([first]);
    // In the order they were placed, and written like any other change.
    expect(useDraftsStore.getState().byCase[CASE]).toEqual([first, second]);
    expect(stored()).toEqual({ [CASE]: [first, second] });
  });

  it('puts a deleted draft back under the next free id when a draft placed since has its own', async () => {
    const { useDraftsStore } = await load();
    const { add, remove, restore } = useDraftsStore.getState();
    const first = add(CASE, 'PV', { x: 1, y: 2 }, { bus: '4' })!;
    remove(CASE, first.id);
    const since = add(CASE, 'PQ', { x: 9, y: 9 })!;
    expect(since.id).toBe(first.id);
    const back = restore(CASE, [first]);
    expect(back).toEqual([{ ...first, id: 'draft-2' }]);
    expect(useDraftsStore.getState().byCase[CASE]).toEqual([since, back[0]]);
  });

  it('puts back no more drafts than the case has room for, and says which', async () => {
    const { useDraftsStore, MAX_DRAFTS_PER_CASE } = await load();
    const { add, removeAll, restore } = useDraftsStore.getState();
    for (let i = 0; i < MAX_DRAFTS_PER_CASE; i += 1) add(CASE, 'Bus', { x: i, y: 0 });
    const all = [...useDraftsStore.getState().byCase[CASE]!];
    removeAll(CASE);
    add(CASE, 'PV', { x: 0, y: 0 });
    const back = restore(CASE, all);
    expect(back).toHaveLength(MAX_DRAFTS_PER_CASE - 1);
    expect(useDraftsStore.getState().byCase[CASE]).toHaveLength(MAX_DRAFTS_PER_CASE);
    expect(restore(CASE, all)).toEqual([]);
  });

  it('says once how many drafts of a case were kept from an earlier visit', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        [CASE]: [
          { id: 'draft-1', kind: 'PV', position: { x: 0, y: 0 }, values: {} },
          { id: 'draft-2', kind: 'PQ', position: { x: 0, y: 0 }, values: {} },
        ],
      }),
    );
    const { useDraftsStore } = await load();
    const { takeKept, remove, add } = useDraftsStore.getState();
    // One is gone by the time the case is opened: what is still there counts.
    remove(CASE, 'draft-2');
    expect(takeKept(CASE)).toBe(1);
    expect(takeKept(CASE)).toBe(0);
    // A case with none kept, and one whose drafts are of this visit.
    expect(takeKept('other.raw')).toBe(0);
    add('other.raw', 'PV', { x: 0, y: 0 });
    expect(takeKept('other.raw')).toBe(0);
  });

  it('does not call the drafts of the case a reload opens again kept from an earlier visit', async () => {
    // They were on screen a moment before the reload.
    window.sessionStorage.setItem(
      'tensa:open-case-v1',
      JSON.stringify({ primaryPath: CASE, addfiles: [] }),
    );
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        [CASE]: [{ id: 'draft-1', kind: 'PV', position: { x: 0, y: 0 }, values: {} }],
        'other.raw': [{ id: 'draft-1', kind: 'PQ', position: { x: 0, y: 0 }, values: {} }],
      }),
    );
    try {
      const { useDraftsStore } = await load();
      expect(useDraftsStore.getState().takeKept(CASE)).toBe(0);
      expect(useDraftsStore.getState().takeKept('other.raw')).toBe(1);
    } finally {
      window.sessionStorage.clear();
    }
  });

  it('holds the field of a draft the cursor is wanted in until it is there', async () => {
    const { useDraftsStore } = await load();
    expect(useDraftsStore.getState().fieldAsked).toBeNull();
    useDraftsStore.getState().askField({ id: 'draft-1', name: 'bus' });
    expect(useDraftsStore.getState().fieldAsked).toEqual({ id: 'draft-1', name: 'bus' });
    useDraftsStore.getState().askField(null);
    expect(useDraftsStore.getState().fieldAsked).toBeNull();
    // In memory only.
    expect(stored()).toBeNull();
  });

  describe('the drafts of a system built from scratch, over a reload of the page', () => {
    const BLANK_KEY = 'tensa:sld-drafts-blank-v1';
    const MARK = 'tensa:open-case-v1';
    const HELD = [{ id: 'draft-1', kind: 'Bus', position: { x: 4, y: 8 }, values: { Vn: '110' } }];

    afterEach(() => window.sessionStorage.clear());

    it('are kept in the tab, which ends with it, and in no later visit', async () => {
      const { useDraftsStore, useCaseStore, BLANK_CASE_KEY } = await load();
      useCaseStore.getState().setCase({ primaryPath: null, addfiles: [], blank: true });
      useDraftsStore.getState().add(BLANK_CASE_KEY, 'Bus', { x: 4, y: 8 }, { Vn: '110' });
      expect(JSON.parse(window.sessionStorage.getItem(BLANK_KEY)!)).toEqual(HELD);
      expect(stored()).toBeNull();
      // Gone from the tab with the last of them.
      useDraftsStore.getState().removeAll(BLANK_CASE_KEY);
      expect(window.sessionStorage.getItem(BLANK_KEY)).toBeNull();
    });

    it('are there again for the system a reload interrupted, and are not called kept from an earlier visit', async () => {
      window.sessionStorage.setItem(BLANK_KEY, JSON.stringify(HELD));
      window.sessionStorage.setItem(
        MARK,
        JSON.stringify({ primaryPath: null, addfiles: [], blank: true }),
      );
      const { useDraftsStore, useCaseStore, BLANK_CASE_KEY } = await load();
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toEqual(HELD);
      // The system is built again: its drafts stay.
      useCaseStore.getState().setCase({ primaryPath: null, addfiles: [], blank: true });
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toEqual(HELD);
      expect(useDraftsStore.getState().takeKept(BLANK_CASE_KEY)).toBe(0);
    });

    it('are not read for a tab that had a case file open, or none', async () => {
      window.sessionStorage.setItem(BLANK_KEY, JSON.stringify(HELD));
      window.sessionStorage.setItem(MARK, JSON.stringify({ primaryPath: CASE, addfiles: [] }));
      const { useDraftsStore, BLANK_CASE_KEY } = await load();
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toBeUndefined();
    });

    it('go when a case file is opened in the place of the system they were kept for', async () => {
      window.sessionStorage.setItem(BLANK_KEY, JSON.stringify(HELD));
      window.sessionStorage.setItem(
        MARK,
        JSON.stringify({ primaryPath: null, addfiles: [], blank: true }),
      );
      const { useDraftsStore, useCaseStore, BLANK_CASE_KEY } = await load();
      // The user opened a case before the system was built again.
      useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(CASE), addfiles: [] });
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toBeUndefined();
      expect(window.sessionStorage.getItem(BLANK_KEY)).toBeNull();
    });

    it('go when the system they were kept for could not be built again', async () => {
      window.sessionStorage.setItem(BLANK_KEY, JSON.stringify(HELD));
      window.sessionStorage.setItem(
        MARK,
        JSON.stringify({ primaryPath: null, addfiles: [], blank: true }),
      );
      const { useDraftsStore, BLANK_CASE_KEY } = await load();
      const { useReloadedCaseStore } = await import('@/store/reloadedCase');
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toEqual(HELD);
      useReloadedCaseStore.getState().forget();
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toBeUndefined();
      expect(window.sessionStorage.getItem(BLANK_KEY)).toBeNull();
    });

    it('stay, in the tab too, when the page only stopped waiting for the system', async () => {
      window.sessionStorage.setItem(BLANK_KEY, JSON.stringify(HELD));
      window.sessionStorage.setItem(
        MARK,
        JSON.stringify({ primaryPath: null, addfiles: [], blank: true }),
      );
      const { useDraftsStore, BLANK_CASE_KEY } = await load();
      const { useReloadedCaseStore } = await import('@/store/reloadedCase');
      // The server gave no answer: the next reload of the page asks again.
      useReloadedCaseStore.getState().postpone();
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toEqual(HELD);
      expect(JSON.parse(window.sessionStorage.getItem(BLANK_KEY)!)).toEqual(HELD);
    });

    it('drops what the tab holds that is no list of drafts', async () => {
      window.sessionStorage.setItem(BLANK_KEY, '{"not":"a list"}');
      window.sessionStorage.setItem(
        MARK,
        JSON.stringify({ primaryPath: null, addfiles: [], blank: true }),
      );
      const { useDraftsStore, BLANK_CASE_KEY } = await load();
      expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toBeUndefined();
    });
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

  it('keeps how the lines ran among the drafts of a case, and reads it at start', async () => {
    const first = await load();
    first.useDraftsStore.getState().add(CASE, 'PQ', { x: 10, y: 20 });
    first.useDraftsStore.getState().keepRoutes(CASE, 'b2-l1-abc', kept('draft-1@10,20'));
    expect(stored(ROUTES_KEY)).toEqual({ [CASE]: { 'b2-l1-abc': kept('draft-1@10,20') } });
    // The same again writes nothing.
    const held = first.useDraftsStore.getState().routes;
    first.useDraftsStore.getState().keepRoutes(CASE, 'b2-l1-abc', kept('draft-1@10,20'));
    expect(first.useDraftsStore.getState().routes).toBe(held);
    // A reload of the page: the modules are evaluated again.
    vi.resetModules();
    const second = await load();
    expect(second.useDraftsStore.getState().routes).toEqual({
      [CASE]: { 'b2-l1-abc': kept('draft-1@10,20') },
    });
    // With no line running any way for a draft, nothing is kept for that system.
    second.useDraftsStore.getState().keepRoutes(CASE, 'b2-l1-abc', null);
    expect(second.useDraftsStore.getState().routes).toEqual({});
    expect(stored(ROUTES_KEY)).toBeNull();
  });

  it('keeps them by the system that was drawn, the last drawn last, and for a few systems only', async () => {
    const { useDraftsStore, MAX_DRAFT_ROUTE_SYSTEMS } = await load();
    const { add, keepRoutes } = useDraftsStore.getState();
    const systems = () => Object.keys(useDraftsStore.getState().routes[CASE] ?? {});
    expect(MAX_DRAFT_ROUTE_SYSTEMS).toBe(3);
    add(CASE, 'PQ', { x: 0, y: 0 });
    keepRoutes(CASE, 'own', kept('a'));
    // Another system drawn under the name of the case leaves what the case keeps.
    keepRoutes(CASE, 'other', kept('b'));
    expect(useDraftsStore.getState().routes[CASE]?.own).toEqual(kept('a'));
    // Drawn again as it was kept, the system of the case is the last drawn again.
    keepRoutes(CASE, 'own', kept('a'));
    expect(systems()).toEqual(['other', 'own']);
    keepRoutes(CASE, 'third', kept('c'));
    keepRoutes(CASE, 'own', kept('a'));
    keepRoutes(CASE, 'fourth', kept('d'));
    // The one drawn longest ago went; the system of the case is still there.
    expect(systems()).toEqual(['third', 'own', 'fourth']);
    expect(Object.keys((stored(ROUTES_KEY) as Record<string, object>)[CASE]!)).toEqual(systems());
  });

  it('lets them go with the last draft of the case, and gives them to a copy of the system', async () => {
    const { useDraftsStore, BLANK_CASE_KEY } = await load();
    const { add, copy, keepRoutes, remove } = useDraftsStore.getState();
    add(CASE, 'PQ', { x: 0, y: 0 });
    add(CASE, 'Line', { x: 0, y: 0 });
    keepRoutes(CASE, 'own', kept('a'));
    add('saved.xlsx', 'Shunt', { x: 0, y: 0 });
    keepRoutes('saved.xlsx', 'old', kept('z'));
    copy(CASE, 'saved.xlsx');
    expect(useDraftsStore.getState().routes['saved.xlsx']).toEqual({ own: kept('a') });
    remove(CASE, 'draft-1');
    expect(useDraftsStore.getState().routes[CASE]).toEqual({ own: kept('a') });
    remove(CASE, 'draft-2');
    expect(useDraftsStore.getState().routes[CASE]).toBeUndefined();
    expect(stored(ROUTES_KEY)).toEqual({ 'saved.xlsx': { own: kept('a') } });
    // Those of a system built from scratch are kept in memory only, like its drafts.
    add(BLANK_CASE_KEY, 'Line', { x: 0, y: 0 });
    keepRoutes(BLANK_CASE_KEY, 'own', kept('b'));
    expect(useDraftsStore.getState().routes[BLANK_CASE_KEY]).toEqual({ own: kept('b') });
    expect(stored(ROUTES_KEY)).toEqual({ 'saved.xlsx': { own: kept('a') } });
  });

  it('drops the routes a broken or foreign storage holds', async () => {
    const good = kept('a');
    window.localStorage.setItem(
      ROUTES_KEY,
      JSON.stringify({
        [CASE]: {
          good,
          // No text for where the drafts stood, a route of one point, a way without
          // the route it stands in for, anchors that are no places.
          'no-stand': { ...good, stand: 3 },
          'one-point': {
            ...good,
            own: { e: { ...good.own['draft-line-draft-2'], points: [[1, 2]] } },
          },
          'no-from': { ...good, round: { e: good.own['draft-line-draft-2'] } },
          'no-anchor': {
            ...good,
            own: { e: { points: good.round['line-L1']!.points, anchors: {} } },
          },
        },
        'other.raw': 'not routes',
        ':blank': { good },
      }),
    );
    const { useDraftsStore } = await load();
    expect(useDraftsStore.getState().routes).toEqual({ [CASE]: { good } });
    window.localStorage.setItem(ROUTES_KEY, '{ not json');
    vi.resetModules();
    expect((await load()).useDraftsStore.getState().routes).toEqual({});
  });
});
