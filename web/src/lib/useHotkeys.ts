/**
 * useHotkeys — central registrar for keyboard shortcuts.
 *
 * Thin wrapper around `react-hotkeys-hook`'s same-named hook that
 * enforces project-wide defaults:
 *
 *  - `enableOnFormTags: false` (the lib's name for "skip when an input,
 *    textarea, select, or contenteditable element has focus"). This is
 *    the lib's default already; we set it explicitly so a future bump
 *    that flips the default doesn't silently regress us into the
 *    bus-filter-contamination class of bug.
 *  - `enableOnContentEditable: false` for the same reason — we don't
 *    want a global `?` shortcut firing while the user is typing into a
 *    contenteditable rich-text surface (we don't have one yet, but
 *    Phase 3 has plot-annotation surfaces that may grow into one).
 *
 * The escape hatch for shortcuts that DO want to fire from inside a
 * text input (e.g., the global `Cmd-K` command palette per Phase 2) is
 * to pass `enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT']` (or any
 * subset) explicitly. The wrapper merges the override on top of the
 * defaults, so callers only have to opt in to the form tags they care
 * about.
 *
 * Why centralise: Unit 6 of the v2.0 polish plan documents a Phase 2
 * smoke finding where typing into the snapshot-name input also
 * triggered the bus filter. The root cause is hand-rolled
 * `addEventListener('keydown', ...)` handlers that don't check
 * `document.activeElement`. By funnelling all hotkey registration
 * through this wrapper we eliminate that bug class structurally — the
 * lib does the editable-element check for us.
 *
 * Auditing helper: `isEditableTarget(element)` exposes the same check
 * as a pure function so any non-hotkey window-level handlers that
 * sneak in (e.g., the `App.tsx` resize listener — which doesn't need
 * the check, but a future keydown one would) can use the same
 * predicate without re-deriving the rules.
 */
import { useHotkeys as useReactHotkeys } from 'react-hotkeys-hook';
import type {
  HotkeyCallback,
  Keys,
  Options,
} from 'react-hotkeys-hook';

/**
 * Registers a keyboard shortcut. Auto-skips when an editable element
 * has focus unless the caller explicitly opts in via `enableOnFormTags`.
 *
 * Returns a ref callback (forwarded from the underlying hook) that
 * scopes the shortcut to a specific element when attached to one. Pass
 * the ref to a focusable element and the shortcut only fires while
 * that element (or a descendant) has focus. Most callers ignore the
 * return value and rely on the global default.
 */
export function useHotkeys<T extends HTMLElement>(
  keys: Keys,
  callback: HotkeyCallback,
  options?: Options,
  dependencies?: ReadonlyArray<unknown>,
) {
  // Project defaults: skip when active element is editable. Callers
  // can override per-call (the global Cmd-K command palette will).
  const merged: Options = {
    enableOnFormTags: false,
    enableOnContentEditable: false,
    ...(options ?? {}),
  };
  return useReactHotkeys<T>(
    keys,
    callback,
    merged,
    // The lib accepts a deps array as the 4th arg; forward as-is.
    dependencies as unknown as Options,
  );
}

/**
 * Pure predicate: is the given element an editable surface that a
 * global keyboard handler should NOT steal keystrokes from?
 *
 * Mirrors `react-hotkeys-hook`'s internal check so non-hotkey
 * window-level listeners (e.g., a hand-rolled `keydown` for a feature
 * that doesn't fit the hook's model) can use the same predicate
 * without re-deriving the rules.
 *
 * Returns true when `element` is one of:
 *  - `<input>` (any type)
 *  - `<textarea>`
 *  - `<select>`
 *  - any element with `contenteditable="true"`
 *
 * Returns false for null / non-Element targets — a non-existent active
 * element is never editable.
 */
export function isEditableTarget(element: Element | null): boolean {
  if (element === null) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return false;
}

/**
 * Convenience: is the document's currently-focused element editable?
 * Returns `false` in non-DOM environments (SSR, tests without jsdom).
 */
export function isEditableActiveElement(): boolean {
  if (typeof document === 'undefined') return false;
  return isEditableTarget(document.activeElement);
}

// Re-export the lib's types for callers that want to type their own
// callbacks without depending on `react-hotkeys-hook` directly.
export type { HotkeyCallback, Keys, Options } from 'react-hotkeys-hook';
