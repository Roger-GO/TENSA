/**
 * Tests for the units slice: the default is per unit, the choice persists in
 * localStorage, and a bad or unavailable storage never breaks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** An in-memory `localStorage`, as the theme tests install (jsdom's has no working methods). */
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

describe('units store', () => {
  let storage: { store: Map<string, string> };

  beforeEach(() => {
    storage = installLocalStorageShim();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts per unit when nothing is stored', async () => {
    const { useUnitsStore } = await import('@/store/units');
    expect(useUnitsStore.getState().mode).toBe('pu');
  });

  it('persists the mode it is set to', async () => {
    const { useUnitsStore, UNIT_MODE_STORAGE_KEY } = await import('@/store/units');
    useUnitsStore.getState().setMode('actual');
    expect(useUnitsStore.getState().mode).toBe('actual');
    expect(storage.store.get(UNIT_MODE_STORAGE_KEY)).toBe('actual');
  });

  it('starts from the stored mode', async () => {
    storage.store.set('tensa:unit-mode', 'actual');
    const { useUnitsStore } = await import('@/store/units');
    expect(useUnitsStore.getState().mode).toBe('actual');
  });

  it('reads a stored value it does not know as per unit', async () => {
    storage.store.set('tensa:unit-mode', 'kV');
    const { useUnitsStore } = await import('@/store/units');
    expect(useUnitsStore.getState().mode).toBe('pu');
  });

  it('keeps working in memory when storage throws', async () => {
    const { useUnitsStore, readPersistedUnitMode } = await import('@/store/units');
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => useUnitsStore.getState().setMode('actual')).not.toThrow();
    expect(useUnitsStore.getState().mode).toBe('actual');
    expect(readPersistedUnitMode()).toBe('pu');
  });
});
