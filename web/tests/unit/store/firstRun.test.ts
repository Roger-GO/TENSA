/**
 * Tests for the first-run coach slice (Unit 13). Mirrors the
 * theme-slice testing strategy: install a real in-memory localStorage
 * shim before each test (the project's vitest+jsdom env ships a
 * non-functional Storage stub), then ``vi.resetModules()`` so the
 * slice's bootstrap reads the fresh shim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installLocalStorageShim(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: shim,
  });
  return { store };
}

describe('firstRun store', () => {
  let storage: { store: Map<string, string> };

  beforeEach(() => {
    storage = installLocalStorageShim();
    vi.resetModules();
  });

  afterEach(() => {
    storage.store.clear();
  });

  it('boots at step 1 when nothing is persisted', async () => {
    const { useFirstRunStore } = await import('@/store/firstRun');
    expect(useFirstRunStore.getState().coachStep).toBe(1);
    expect(useFirstRunStore.getState().coachDismissed).toBe(false);
  });

  it('boots dismissed (coachStep=null) when localStorage holds the dismissal sentinel', async () => {
    localStorage.setItem('tensa:first-run-coach-v1', 'dismissed');
    const { useFirstRunStore } = await import('@/store/firstRun');
    expect(useFirstRunStore.getState().coachStep).toBeNull();
    expect(useFirstRunStore.getState().coachDismissed).toBe(true);
  });

  it('treats unknown stored values as not-dismissed (defensive)', async () => {
    localStorage.setItem('tensa:first-run-coach-v1', 'maybe');
    const { useFirstRunStore } = await import('@/store/firstRun');
    expect(useFirstRunStore.getState().coachStep).toBe(1);
    expect(useFirstRunStore.getState().coachDismissed).toBe(false);
  });

  it('nextStep advances 1 → 2 → 3 → null and persists on terminal', async () => {
    const { useFirstRunStore } = await import('@/store/firstRun');
    useFirstRunStore.getState().nextStep();
    expect(useFirstRunStore.getState().coachStep).toBe(2);
    useFirstRunStore.getState().nextStep();
    expect(useFirstRunStore.getState().coachStep).toBe(3);
    // Terminal — persists and dismisses.
    useFirstRunStore.getState().nextStep();
    expect(useFirstRunStore.getState().coachStep).toBeNull();
    expect(useFirstRunStore.getState().coachDismissed).toBe(true);
    expect(localStorage.getItem('tensa:first-run-coach-v1')).toBe('dismissed');
  });

  it('nextStep is a no-op once dismissed', async () => {
    const { useFirstRunStore } = await import('@/store/firstRun');
    useFirstRunStore.getState().dismissCoach();
    expect(useFirstRunStore.getState().coachStep).toBeNull();
    useFirstRunStore.getState().nextStep();
    expect(useFirstRunStore.getState().coachStep).toBeNull();
  });

  it('dismissCoach immediately persists and clears step', async () => {
    const { useFirstRunStore } = await import('@/store/firstRun');
    useFirstRunStore.getState().dismissCoach();
    expect(useFirstRunStore.getState().coachStep).toBeNull();
    expect(useFirstRunStore.getState().coachDismissed).toBe(true);
    expect(localStorage.getItem('tensa:first-run-coach-v1')).toBe('dismissed');
  });

  it('persistFailed=true when localStorage.setItem throws; in-memory still updates', async () => {
    const throwingStub: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('QuotaExceeded', 'QuotaExceededError');
      },
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: throwingStub,
    });
    const { useFirstRunStore } = await import('@/store/firstRun');
    useFirstRunStore.getState().dismissCoach();
    expect(useFirstRunStore.getState().coachStep).toBeNull();
    expect(useFirstRunStore.getState().coachDismissed).toBe(true);
    expect(useFirstRunStore.getState().persistFailed).toBe(true);
  });

  it('__resetForTests with clearStorage wipes the persisted flag and re-boots at step 1', async () => {
    localStorage.setItem('tensa:first-run-coach-v1', 'dismissed');
    const { useFirstRunStore } = await import('@/store/firstRun');
    expect(useFirstRunStore.getState().coachStep).toBeNull();
    useFirstRunStore.getState().__resetForTests({ clearStorage: true });
    expect(useFirstRunStore.getState().coachStep).toBe(1);
    expect(useFirstRunStore.getState().coachDismissed).toBe(false);
    expect(localStorage.getItem('tensa:first-run-coach-v1')).toBeNull();
  });
});
