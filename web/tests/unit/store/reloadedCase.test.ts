/**
 * Tests for the reloaded case slice: the tab's mark of the case file it has
 * open, which is what the page reads after a reload to say which case the
 * reload closed. The mark follows the open case through the store cascade, is
 * kept for the tab (sessionStorage), and a storage that is missing, broken or
 * holding something else leaves the page with nothing to say.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspacePath } from '@/api/types';

const KEY = 'tensa:open-case-v1';

/** An in-memory `sessionStorage` whose methods a test can replace, as `recentCases.test.ts` has for `localStorage`. */
function installSessionStorageShim(): void {
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
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: shim });
}

function mark(): unknown {
  const raw = window.sessionStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe('reloaded case store', () => {
  beforeEach(() => {
    installSessionStorageShim();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('has nothing to say on a first visit', async () => {
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    expect(useReloadedCaseStore.getState().closed).toBeNull();
  });

  it('reads at start the case the tab had open when the page went away', async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] }),
    );
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    expect(useReloadedCaseStore.getState().closed).toEqual({
      primaryPath: 'ieee14.raw',
      addfiles: ['ieee14.dyr'],
    });
    // The mark stays, so a second reload says the same.
    expect(mark()).toEqual({ primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] });
  });

  it.each([
    ['not JSON', '{nope'],
    ['another shape', JSON.stringify({ path: 'a.xlsx' })],
    ['an empty path', JSON.stringify({ primaryPath: '', addfiles: [] })],
    ['dynamic files that are not names', JSON.stringify({ primaryPath: 'a.raw', addfiles: [1] })],
    ['a list', JSON.stringify(['a.xlsx'])],
  ])('reads %s as no mark', async (_what, stored) => {
    window.sessionStorage.setItem(KEY, stored);
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    expect(useReloadedCaseStore.getState().closed).toBeNull();
  });

  it('marks the case file that is opened, with its dynamic files', async () => {
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    useReloadedCaseStore.getState().follow({
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [parseWorkspacePath('ieee14.dyr')],
    });
    expect(mark()).toEqual({ primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] });
  });

  it('drops what the reload closed once a case is open again', async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ primaryPath: 'kundur_full.xlsx', addfiles: [] }),
    );
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    useReloadedCaseStore
      .getState()
      .follow({ primaryPath: parseWorkspacePath('wscc9.xlsx'), addfiles: [] });
    expect(useReloadedCaseStore.getState().closed).toBeNull();
    expect(mark()).toEqual({ primaryPath: 'wscc9.xlsx', addfiles: [] });
  });

  it('removes the mark when the user closes the case, so a reload after it has none to name', async () => {
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    const { follow } = useReloadedCaseStore.getState();
    follow({ primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] });
    follow(null);
    expect(mark()).toBeNull();
  });

  it('marks a system built from scratch as one, since no file holds it', async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ primaryPath: 'kundur_full.xlsx', addfiles: [] }),
    );
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    useReloadedCaseStore.getState().follow({ primaryPath: null, addfiles: [], blank: true });
    expect(mark()).toEqual({ primaryPath: null, addfiles: [], blank: true });
    expect(useReloadedCaseStore.getState().closed).toBeNull();
  });

  it('reads the mark of a system built from scratch back when the page starts', async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ primaryPath: null, addfiles: [], blank: true }),
    );
    const { isOnFile, useReloadedCaseStore } = await import('@/store/reloadedCase');
    const closed = useReloadedCaseStore.getState().closed;
    expect(closed).toEqual({ primaryPath: null, addfiles: [], blank: true });
    expect(closed !== null && isOnFile(closed)).toBe(false);
  });

  it('keeps what the tab holds for a system built from scratch only for that system', async () => {
    // The drafts of such a system are kept in the tab for a reload of it.
    const BLANK_DRAFTS = 'tensa:sld-drafts-blank-v1';
    const hold = () => window.sessionStorage.setItem(BLANK_DRAFTS, '[]');
    const held = () => window.sessionStorage.getItem(BLANK_DRAFTS) !== null;
    const { BLANK_DRAFTS_STORAGE_KEY, useReloadedCaseStore } = await import('@/store/reloadedCase');
    expect(BLANK_DRAFTS_STORAGE_KEY).toBe(BLANK_DRAFTS);
    const { follow, forget } = useReloadedCaseStore.getState();
    hold();
    follow({ primaryPath: null, addfiles: [], blank: true });
    expect(held()).toBe(true);
    // Another case is opened in its place, or none: they are not for that one.
    follow({ primaryPath: 'kundur_full.xlsx' as never, addfiles: [] });
    expect(held()).toBe(false);
    hold();
    follow(null);
    expect(held()).toBe(false);
    // Nor for a later system, when the one they were kept for could not be built again.
    hold();
    forget();
    expect(held()).toBe(false);
  });

  it('forgets a case whose file is gone', async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ primaryPath: 'kundur_full.xlsx', addfiles: [] }),
    );
    const { useReloadedCaseStore } = await import('@/store/reloadedCase');
    useReloadedCaseStore.getState().forget();
    expect(useReloadedCaseStore.getState().closed).toBeNull();
    expect(mark()).toBeNull();
  });

  it('follows the open case through the store cascade', async () => {
    const { useCaseStore } = await import('@/store');
    useCaseStore
      .getState()
      .setCase({ primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] });
    expect(mark()).toEqual({ primaryPath: 'kundur_full.xlsx', addfiles: [] });
    useCaseStore.getState().clearCase();
    expect(mark()).toBeNull();
  });

  it('works without the mark when the storage throws', async () => {
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(window.sessionStorage, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { useReloadedCaseStore, writeOpenCaseMark } = await import('@/store/reloadedCase');
    expect(useReloadedCaseStore.getState().closed).toBeNull();
    expect(() =>
      useReloadedCaseStore
        .getState()
        .follow({ primaryPath: parseWorkspacePath('a.xlsx'), addfiles: [] }),
    ).not.toThrow();
    expect(() => useReloadedCaseStore.getState().follow(null)).not.toThrow();
    expect(writeOpenCaseMark({ primaryPath: 'a.xlsx', addfiles: [] })).toBe(false);
    expect(writeOpenCaseMark(null)).toBe(false);
  });
});
