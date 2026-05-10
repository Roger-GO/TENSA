/**
 * Tests for the central `useHotkeys` wrapper + `isEditableTarget`
 * predicate (Unit 6 of the v2.0 polish plan).
 *
 * Behaviour we lock in:
 *
 *  - Default registration ignores keystrokes while an editable element
 *    has focus (the documented bus-filter contamination class of bug).
 *  - Default registration fires when focus is on a non-editable
 *    element (e.g., the document body).
 *  - Callers can opt in via `enableOnFormTags` to fire from inside
 *    inputs (the global Cmd-K command palette case).
 *  - The `isEditableTarget` predicate matches the lib's check so
 *    bespoke window-level handlers can guard themselves the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useHotkeys, isEditableTarget, isEditableActiveElement } from '@/lib/useHotkeys';
import type { Options } from '@/lib/useHotkeys';

afterEach(() => {
  cleanup();
});

// --- isEditableTarget --------------------------------------------------------

describe('isEditableTarget', () => {
  it('returns false for null', () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it('returns true for input / textarea / select', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
  });

  it('returns true for contenteditable elements', () => {
    const div = document.createElement('div');
    // jsdom doesn't reflect `contentEditable` setter into the
    // `isContentEditable` getter, so set the attribute directly AND
    // override `isContentEditable` so our predicate's runtime check
    // (which uses `HTMLElement#isContentEditable`) returns true.
    div.setAttribute('contenteditable', 'true');
    Object.defineProperty(div, 'isContentEditable', {
      configurable: true,
      get: () => true,
    });
    document.body.appendChild(div);
    try {
      expect(isEditableTarget(div)).toBe(true);
    } finally {
      div.remove();
    }
  });

  it('returns false for non-editable elements (button, div, body)', () => {
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(document.createElement('span'))).toBe(false);
  });
});

describe('isEditableActiveElement', () => {
  it('returns false when the active element is the body', () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    expect(isEditableActiveElement()).toBe(false);
  });

  it('returns true when an input has focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      expect(document.activeElement).toBe(input);
      expect(isEditableActiveElement()).toBe(true);
    } finally {
      input.remove();
    }
  });
});

// --- useHotkeys (wrapper) ----------------------------------------------------

/**
 * Dispatch a keyboard event the same way `react-hotkeys-hook` listens
 * for one — the lib subscribes via `document.addEventListener('keydown',
 * ...)` AND keys off `event.code` (not `event.key`), so we have to
 * supply both. `KeyA` collapses to `'a'` in the lib's matcher (it
 * strips the `Key` / `Digit` / `Numpad` prefix).
 */
function pressKey(key: string, code: string, target: EventTarget = document): void {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('useHotkeys (wrapper)', () => {
  beforeEach(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it('fires the callback when no editable element has focus', () => {
    const cb = vi.fn();
    renderHook(() => useHotkeys('a', cb));
    pressKey('a', 'KeyA');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('SKIPS the callback when an input has focus (default behaviour)', () => {
    const cb = vi.fn();
    renderHook(() => useHotkeys('a', cb));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      expect(document.activeElement).toBe(input);
      // The hotkey is dispatched but the lib's editable-element guard
      // should swallow it before our callback runs.
      pressKey('a', 'KeyA', input);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it('SKIPS the callback when a textarea has focus (default behaviour)', () => {
    const cb = vi.fn();
    renderHook(() => useHotkeys('a', cb));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    try {
      pressKey('a', 'KeyA', ta);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      ta.remove();
    }
  });

  it('FIRES the callback inside an input when caller opts in via enableOnFormTags', () => {
    const cb = vi.fn();
    const opts: Options = { enableOnFormTags: ['INPUT'] };
    renderHook(() => useHotkeys('a', cb, opts));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      pressKey('a', 'KeyA', input);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      input.remove();
    }
  });

  it('still fires when focus is on the body even with an input mounted in the document', () => {
    const cb = vi.fn();
    renderHook(() => useHotkeys('a', cb));
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      // Body focus, not input — should fire.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      pressKey('a', 'KeyA');
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      input.remove();
    }
  });

  it('SKIPS the callback when a contenteditable element has focus (default behaviour)', () => {
    const cb = vi.fn();
    renderHook(() => useHotkeys('a', cb));
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    Object.defineProperty(div, 'isContentEditable', {
      configurable: true,
      get: () => true,
    });
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();
    try {
      pressKey('a', 'KeyA', div);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      div.remove();
    }
  });
});
