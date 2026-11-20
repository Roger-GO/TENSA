import type { LayoutStorage } from 'react-resizable-panels';

/**
 * Where the shell's panel groups keep the sizes they were dragged to
 * (`useDefaultLayout` of `react-resizable-panels`): `localStorage`, read and
 * written so that neither can break the shell. The library parses what it
 * reads without a guard, and a value that is not a JSON object (cut short by
 * a full disk, or written by hand) would throw while the shell renders; it is
 * read as nothing kept, and the panels open at their default sizes. Storage that
 * cannot be reached (a browser that blocks it, a full quota) keeps nothing.
 */
export const panelLayoutStorage: LayoutStorage = {
  getItem(key) {
    try {
      const value = window.localStorage.getItem(key);
      if (value === null) return null;
      const kept: unknown = JSON.parse(value);
      return typeof kept === 'object' && kept !== null ? value : null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Nothing kept: the panels open at their default sizes next time.
    }
  },
};
