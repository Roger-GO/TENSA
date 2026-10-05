/**
 * Tests for the recent cases slice: newest first, one entry per case, capped,
 * remembered across a reload through localStorage, and unharmed by storage that
 * is missing, full or holding something else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** An in-memory `localStorage`, as the units tests install (jsdom's has no working methods). */
function installLocalStorageShim(): { store: Map<string, string> } {
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
  return { store };
}

describe('recent cases store', () => {
  let storage: { store: Map<string, string> };

  beforeEach(() => {
    storage = installLocalStorageShim();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts empty when nothing is stored', async () => {
    const { useRecentCasesStore } = await import('@/store/recentCases');
    expect(useRecentCasesStore.getState().cases).toEqual([]);
  });

  it('puts the newest case first, with the dynamic files it was opened with', async () => {
    const { useRecentCasesStore } = await import('@/store/recentCases');
    const { record } = useRecentCasesStore.getState();
    record('kundur.raw', []);
    record('ieee14.raw', ['ieee14.dyr']);
    expect(useRecentCasesStore.getState().cases).toMatchObject([
      { primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
      { primaryPath: 'kundur.raw', addfiles: [] },
    ]);
  });

  it('lists a case once: opening it again moves it to the top with its latest files', async () => {
    const { useRecentCasesStore } = await import('@/store/recentCases');
    const { record } = useRecentCasesStore.getState();
    record('ieee14.raw', ['ieee14.dyr']);
    record('kundur.raw', []);
    record('ieee14.raw', []);
    expect(useRecentCasesStore.getState().cases).toMatchObject([
      { primaryPath: 'ieee14.raw', addfiles: [] },
      { primaryPath: 'kundur.raw', addfiles: [] },
    ]);
  });

  it('keeps the most recent MAX_RECENT_CASES and drops the rest', async () => {
    const { useRecentCasesStore, MAX_RECENT_CASES } = await import('@/store/recentCases');
    const { record } = useRecentCasesStore.getState();
    for (let i = 0; i < MAX_RECENT_CASES + 3; i += 1) record(`case${i}.raw`, []);
    const { cases } = useRecentCasesStore.getState();
    expect(cases).toHaveLength(MAX_RECENT_CASES);
    expect(cases[0]?.primaryPath).toBe(`case${MAX_RECENT_CASES + 2}.raw`);
    expect(cases.some((c) => c.primaryPath === 'case0.raw')).toBe(false);
  });

  it('persists the list and reads it back after a reload', async () => {
    const first = await import('@/store/recentCases');
    first.useRecentCasesStore.getState().record('ieee14.raw', ['ieee14.dyr']);
    expect(storage.store.has(first.RECENT_CASES_STORAGE_KEY)).toBe(true);

    vi.resetModules();
    const second = await import('@/store/recentCases');
    expect(second.useRecentCasesStore.getState().cases).toMatchObject([
      { primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
    ]);
  });

  it('ignores stored entries that are malformed, and anything that is not a list', async () => {
    const { RECENT_CASES_STORAGE_KEY } = await import('@/store/recentCases');
    const good = { primaryPath: 'ieee14.raw', addfiles: [], openedAt: 5 };
    storage.store.set(
      RECENT_CASES_STORAGE_KEY,
      JSON.stringify([
        { primaryPath: '', addfiles: [], openedAt: 1 },
        { primaryPath: 'a.raw', addfiles: 'a.dyr', openedAt: 1 },
        { primaryPath: 'b.raw', addfiles: [3], openedAt: 1 },
        { primaryPath: 'c.raw', addfiles: [] },
        null,
        'd.raw',
        good,
      ]),
    );
    vi.resetModules();
    const list = await import('@/store/recentCases');
    expect(list.useRecentCasesStore.getState().cases).toEqual([good]);

    storage.store.set(RECENT_CASES_STORAGE_KEY, '{"primaryPath":"x.raw"}');
    vi.resetModules();
    expect((await import('@/store/recentCases')).useRecentCasesStore.getState().cases).toEqual([]);

    storage.store.set(RECENT_CASES_STORAGE_KEY, 'not json');
    vi.resetModules();
    expect((await import('@/store/recentCases')).useRecentCasesStore.getState().cases).toEqual([]);
  });

  it('works in memory when storage throws', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.resetModules();
    const { useRecentCasesStore } = await import('@/store/recentCases');
    expect(useRecentCasesStore.getState().cases).toEqual([]);
    useRecentCasesStore.getState().record('ieee14.raw', []);
    expect(useRecentCasesStore.getState().cases).toHaveLength(1);
  });
});
