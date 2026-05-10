/**
 * useTheme — bridges ``useThemeStore`` to the DOM (Unit 12 of the v2.0
 * polish plan).
 *
 * Three responsibilities:
 *
 *  1. **Apply the resolved theme to the DOM.** Every time
 *     ``resolvedTheme`` changes (either because the user clicked the
 *     toggle, or because the OS preference changed while ``system``
 *     mode is active), this hook adds / removes the ``.dark`` class on
 *     ``document.documentElement``. Tailwind v4's
 *     ``@custom-variant dark`` configured in ``tokens.css`` keys off
 *     that class.
 *
 *  2. **Track OS preference changes.** When ``themePreference ===
 *     'system'``, a ``matchMedia('(prefers-color-scheme: dark)')``
 *     listener pushes OS-level changes into the store via
 *     ``__setSystemSnapshot``. When the user picks an explicit
 *     preference the listener still fires (it's cheap), but the
 *     resolver pins the resolved value to the explicit choice anyway.
 *     Listener cleanup runs on unmount + on preference change so the
 *     handler is always single-mounted.
 *
 *  3. **Expose a stable API.** Returns ``{ themePreference,
 *     resolvedTheme, setThemePreference, cycleTheme }`` so consumers
 *     can read both states + drive the toggle without importing the
 *     store directly.
 *
 * No-flash: ``index.html`` ships an inline script that applies the
 * ``.dark`` class BEFORE React mounts, reading the same localStorage
 * key (see ``store/theme.ts``). The first effect run here is therefore
 * a no-op in the steady state — the class is already correct from the
 * inline script.
 */
import { useEffect } from 'react';

import { useThemeStore, readSystemTheme } from '@/store/theme';
import type { ResolvedTheme, ThemePreference } from '@/store/theme';

const DARK_CLASS = 'dark';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * Apply the ``.dark`` class on ``document.documentElement`` for the
 * given resolved theme. Pulled out as a free function so the
 * inline-script logic in ``index.html`` and the React effect below
 * agree on the mechanism.
 */
export function applyThemeClass(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add(DARK_CLASS);
  } else {
    root.classList.remove(DARK_CLASS);
  }
}

export interface UseThemeReturn {
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setThemePreference: (pref: ThemePreference) => void;
  cycleTheme: () => void;
}

export function useTheme(): UseThemeReturn {
  const themePreference = useThemeStore((s) => s.themePreference);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const setThemePreference = useThemeStore((s) => s.setThemePreference);
  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const setSystemSnapshot = useThemeStore((s) => s.__setSystemSnapshot);

  // (1) Apply class whenever the resolved theme changes.
  useEffect(() => {
    applyThemeClass(resolvedTheme);
  }, [resolvedTheme]);

  // (2) Subscribe to OS-level preference changes. We re-subscribe on
  // every preference change so the listener identity stays stable
  // within a single preference window — simpler than juggling a ref +
  // checking ``themePreference`` inside the handler.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(MEDIA_QUERY);

    // Push the current OS snapshot once on mount in case the OS
    // preference changed while the tab was backgrounded (matchMedia
    // listeners don't fire retroactively).
    setSystemSnapshot(readSystemTheme());

    const handler = (event: MediaQueryListEvent) => {
      setSystemSnapshot(event.matches ? 'dark' : 'light');
    };

    // Modern browsers expose addEventListener; older Safari only
    // exposed addListener. Prefer the modern API and fall back so the
    // jsdom polyfill in tests/setup.ts (which only stubs
    // addEventListener as a no-op) doesn't crash.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(handler);
      return () => mql.removeListener(handler);
    }
    return undefined;
  }, [themePreference, setSystemSnapshot]);

  return { themePreference, resolvedTheme, setThemePreference, cycleTheme };
}
