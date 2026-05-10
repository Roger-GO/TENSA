/**
 * Tests for `useTheme` (Unit 12 of the v2.0 polish plan).
 *
 * Strategy: replace ``window.matchMedia`` with a controllable fake so
 * we can capture the registered listener and fire change events
 * synchronously. Each test resets the theme store + the document's
 * class list before exercising the hook.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { useTheme, applyThemeClass } from '@/lib/useTheme';
import { useThemeStore } from '@/store/theme';

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  listeners: Array<(e: MediaQueryListEvent) => void>;
  addEventListener: (type: 'change', cb: (e: MediaQueryListEvent) => void) => void;
  removeEventListener: (type: 'change', cb: (e: MediaQueryListEvent) => void) => void;
}

function makeFakeMediaQuery(initialMatches = false): FakeMediaQueryList {
  const mql: FakeMediaQueryList = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    listeners: [],
    addEventListener(type, cb) {
      if (type === 'change') mql.listeners.push(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'change') {
        const i = mql.listeners.indexOf(cb);
        if (i >= 0) mql.listeners.splice(i, 1);
      }
    },
  };
  return mql;
}

let fakeMql: FakeMediaQueryList;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  fakeMql = makeFakeMediaQuery(false);
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((_query: string) =>
    fakeMql as unknown as MediaQueryList) as typeof window.matchMedia;

  document.documentElement.classList.remove('dark');
  // Reset theme store to a known starting point.
  useThemeStore.setState({
    themePreference: 'system',
    resolvedTheme: 'light',
    persistFailed: false,
  });
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  document.documentElement.classList.remove('dark');
});

function HookProbe() {
  useTheme();
  return null;
}

describe('useTheme — class application', () => {
  it('adds .dark to <html> when resolvedTheme flips to dark', () => {
    render(<HookProbe />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    act(() => {
      useThemeStore.getState().setThemePreference('dark');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes .dark when the user switches back to light', () => {
    document.documentElement.classList.add('dark');
    useThemeStore.setState({ themePreference: 'dark', resolvedTheme: 'dark' });
    render(<HookProbe />);
    act(() => {
      useThemeStore.getState().setThemePreference('light');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('useTheme — matchMedia listener wiring', () => {
  it('subscribes to (prefers-color-scheme: dark) on mount', () => {
    render(<HookProbe />);
    expect(fakeMql.listeners.length).toBeGreaterThanOrEqual(1);
  });

  it('removes the listener on unmount (cleanup)', () => {
    const { unmount } = render(<HookProbe />);
    expect(fakeMql.listeners.length).toBeGreaterThanOrEqual(1);
    unmount();
    expect(fakeMql.listeners.length).toBe(0);
  });

  it('system mode tracks the OS preference change in real time', () => {
    useThemeStore.setState({ themePreference: 'system', resolvedTheme: 'light' });
    render(<HookProbe />);
    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    act(() => {
      // Fire an OS-level change to dark.
      fakeMql.matches = true;
      for (const cb of fakeMql.listeners) {
        cb({ matches: true } as MediaQueryListEvent);
      }
    });
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('explicit preference ignores OS-level changes', () => {
    useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
    render(<HookProbe />);
    act(() => {
      fakeMql.matches = true;
      for (const cb of fakeMql.listeners) {
        cb({ matches: true } as MediaQueryListEvent);
      }
    });
    // Resolved theme stays "light" because the explicit preference pins it.
    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('applyThemeClass', () => {
  it('toggles the .dark class on <html>', () => {
    document.documentElement.classList.remove('dark');
    applyThemeClass('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    applyThemeClass('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
