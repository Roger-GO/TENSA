/**
 * Theme slice. Owns the user's light / dark / system preference and the
 * derived resolved theme that is actually applied to the DOM.
 *
 * Persistence: ``localStorage`` (NOT ``sessionStorage`` — auth uses
 * sessionStorage because tokens are per-launch; the theme is a UX
 * preference the user expects to survive a tab close + reopen, just
 * like every other web app's dark-mode toggle).
 *
 * Mechanism: this slice is the source of truth for the *preference*.
 * The ``useTheme`` hook bridges the slice to the DOM by toggling the
 * ``.dark`` class on ``document.documentElement`` whenever
 * ``resolvedTheme`` changes, and by subscribing to ``matchMedia`` so
 * that the system mode tracks the OS preference in real time.
 *
 * The ``.dark`` class is the convention wired by ``tokens.css`` via
 * Tailwind v4's ``@custom-variant dark (&:where(.dark, .dark *))``.
 * Toggling it swaps every colour token defined under ``:where(.dark)``
 * in one paint cycle.
 *
 * No-flash: ``index.html`` carries an inline script that reads this
 * slice's localStorage key + ``matchMedia`` BEFORE React mounts and
 * applies the class synchronously. The slice's lazy bootstrap below
 * mirrors that logic so the in-memory state agrees with what the DOM
 * already shows by the time React hydrates.
 */
import { create } from 'zustand';

export const STORAGE_KEY = 'andes-app:theme-preference';

/** User-selected preference. ``"system"`` follows the OS. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** Resolved theme actually applied to the DOM. */
export type ResolvedTheme = 'light' | 'dark';

const VALID_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

/**
 * Read the persisted preference from ``localStorage``. Returns
 * ``"system"`` on any failure (storage unavailable, value missing,
 * legacy junk in the slot) — system is the safest default since it
 * tracks the OS the user already configured.
 */
export function readPersistedPreference(): ThemePreference {
  try {
    if (typeof localStorage === 'undefined') return 'system';
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (VALID_PREFERENCES as readonly string[]).includes(raw)) {
      return raw as ThemePreference;
    }
    return 'system';
  } catch {
    return 'system';
  }
}

/**
 * Try to persist the preference. Returns ``true`` on success, ``false``
 * if storage threw (private-mode Safari, quota exceeded, etc.). The
 * theme still works in-memory either way.
 */
export function writePersistedPreference(pref: ThemePreference): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(STORAGE_KEY, pref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current OS-level dark-mode preference. Falls back to
 * ``"light"`` when ``matchMedia`` is unavailable (jsdom default
 * behaves this way; the setup.ts polyfill also returns ``matches:
 * false``).
 */
export function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Resolve a preference + system snapshot into the concrete theme. */
export function resolveTheme(pref: ThemePreference, system: ResolvedTheme): ResolvedTheme {
  return pref === 'system' ? system : pref;
}

/** Cycle order: light → dark → system → light. */
export function nextPreference(pref: ThemePreference): ThemePreference {
  switch (pref) {
    case 'light':
      return 'dark';
    case 'dark':
      return 'system';
    case 'system':
    default:
      return 'light';
  }
}

export interface ThemeState {
  /** What the user picked. Drives the toggle icon. */
  themePreference: ThemePreference;
  /**
   * What's currently applied. ``themePreference`` for ``'light'`` /
   * ``'dark'``; tracks the OS for ``'system'``.
   */
  resolvedTheme: ResolvedTheme;
  /** ``true`` if the most recent persistence attempt failed. */
  persistFailed: boolean;
  setThemePreference: (pref: ThemePreference) => void;
  cycleTheme: () => void;
  /**
   * Hook-only setter — used by ``useTheme`` to push a fresh OS snapshot
   * into the slice when the system mode is active and the OS preference
   * changes. Not intended for component callers.
   */
  __setSystemSnapshot: (system: ResolvedTheme) => void;
}

const initialPreference = readPersistedPreference();
const initialSystem = readSystemTheme();

export const useThemeStore = create<ThemeState>((set, get) => ({
  themePreference: initialPreference,
  resolvedTheme: resolveTheme(initialPreference, initialSystem),
  persistFailed: false,
  setThemePreference: (pref: ThemePreference) => {
    const ok = writePersistedPreference(pref);
    const system = readSystemTheme();
    set({
      themePreference: pref,
      resolvedTheme: resolveTheme(pref, system),
      persistFailed: !ok,
    });
  },
  cycleTheme: () => {
    const next = nextPreference(get().themePreference);
    get().setThemePreference(next);
  },
  __setSystemSnapshot: (system: ResolvedTheme) => {
    const pref = get().themePreference;
    set({ resolvedTheme: resolveTheme(pref, system) });
  },
}));
