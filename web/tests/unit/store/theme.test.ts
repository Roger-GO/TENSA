/**
 * Tests for the theme slice. Mirrors the auth-slice testing strategy
 * (vi.resetModules + lazy import) so each test starts from a fresh
 * localStorage snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The vitest+jsdom environment in this repo ships a `localStorage`
 * stub without functional `getItem`/`setItem`/`clear` methods (see
 * `AppShell.test.tsx` for context). Tests below install a real
 * in-memory shim before each run so persistence is observable.
 */
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

describe('theme store', () => {
  let storage: { store: Map<string, string> };

  beforeEach(() => {
    storage = installLocalStorageShim();
    vi.resetModules();
  });

  afterEach(() => {
    storage.store.clear();
  });

  it('defaults to "system" when no value is persisted', async () => {
    const { useThemeStore } = await import('@/store/theme');
    expect(useThemeStore.getState().themePreference).toBe('system');
  });

  it('boots from localStorage when a valid value is persisted', async () => {
    localStorage.setItem('andes-app:theme-preference', 'dark');
    const { useThemeStore } = await import('@/store/theme');
    expect(useThemeStore.getState().themePreference).toBe('dark');
  });

  it('falls back to "system" when localStorage holds garbage', async () => {
    localStorage.setItem('andes-app:theme-preference', 'maroon');
    const { useThemeStore } = await import('@/store/theme');
    expect(useThemeStore.getState().themePreference).toBe('system');
  });

  it('setThemePreference persists + updates resolvedTheme for explicit picks', async () => {
    const { useThemeStore } = await import('@/store/theme');
    useThemeStore.getState().setThemePreference('dark');
    expect(useThemeStore.getState().themePreference).toBe('dark');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    expect(localStorage.getItem('andes-app:theme-preference')).toBe('dark');

    useThemeStore.getState().setThemePreference('light');
    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    expect(localStorage.getItem('andes-app:theme-preference')).toBe('light');
  });

  it('cycleTheme rotates light → dark → system → light', async () => {
    const { useThemeStore } = await import('@/store/theme');
    useThemeStore.getState().setThemePreference('light');
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().themePreference).toBe('dark');
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().themePreference).toBe('system');
    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().themePreference).toBe('light');
  });

  it('localStorage write failure → persistFailed=true, in-memory state still updates', async () => {
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
    const { useThemeStore } = await import('@/store/theme');
    useThemeStore.getState().setThemePreference('dark');
    expect(useThemeStore.getState().themePreference).toBe('dark');
    expect(useThemeStore.getState().persistFailed).toBe(true);
  });

  it('readSystemTheme returns "dark" when matchMedia.matches is true', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const { readSystemTheme, resolveTheme } = await import('@/store/theme');
      expect(readSystemTheme()).toBe('dark');
      expect(resolveTheme('system', 'dark')).toBe('dark');
      expect(resolveTheme('light', 'dark')).toBe('light');
    } finally {
      window.matchMedia = original;
    }
  });

  it('__setSystemSnapshot updates resolvedTheme only when in system mode', async () => {
    const { useThemeStore } = await import('@/store/theme');
    useThemeStore.getState().setThemePreference('system');
    useThemeStore.getState().__setSystemSnapshot('dark');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    useThemeStore.getState().__setSystemSnapshot('light');
    expect(useThemeStore.getState().resolvedTheme).toBe('light');

    // When the user has picked an explicit preference, the system
    // snapshot push must NOT clobber the resolved theme.
    useThemeStore.getState().setThemePreference('dark');
    useThemeStore.getState().__setSystemSnapshot('light');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
  });
});
