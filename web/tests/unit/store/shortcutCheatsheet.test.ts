/**
 * Tests for the `shortcutCheatsheet` Zustand slice (Unit 10 of the
 * v2.0 polish plan).
 *
 * Mirrors the shape of the `commandPalette` slice tests — the slice
 * is intentionally tiny so the test surface is just open / close /
 * toggle correctness + idempotency.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';

beforeEach(() => {
  useShortcutCheatsheetStore.setState({ open: false });
});

describe('useShortcutCheatsheetStore — initial state', () => {
  it('starts closed', () => {
    expect(useShortcutCheatsheetStore.getState().open).toBe(false);
  });
});

describe('useShortcutCheatsheetStore — open / close / toggle', () => {
  it('openCheatsheet flips open to true', () => {
    useShortcutCheatsheetStore.getState().openCheatsheet();
    expect(useShortcutCheatsheetStore.getState().open).toBe(true);
  });

  it('closeCheatsheet flips open back to false', () => {
    useShortcutCheatsheetStore.getState().openCheatsheet();
    useShortcutCheatsheetStore.getState().closeCheatsheet();
    expect(useShortcutCheatsheetStore.getState().open).toBe(false);
  });

  it('toggleCheatsheet alternates open / closed', () => {
    expect(useShortcutCheatsheetStore.getState().open).toBe(false);
    useShortcutCheatsheetStore.getState().toggleCheatsheet();
    expect(useShortcutCheatsheetStore.getState().open).toBe(true);
    useShortcutCheatsheetStore.getState().toggleCheatsheet();
    expect(useShortcutCheatsheetStore.getState().open).toBe(false);
  });

  it('openCheatsheet is idempotent (no-op when already open)', () => {
    useShortcutCheatsheetStore.getState().openCheatsheet();
    const before = useShortcutCheatsheetStore.getState();
    useShortcutCheatsheetStore.getState().openCheatsheet();
    const after = useShortcutCheatsheetStore.getState();
    expect(after.open).toBe(true);
    expect(after.open).toBe(before.open);
  });

  it('closeCheatsheet is idempotent (no-op when already closed)', () => {
    const before = useShortcutCheatsheetStore.getState();
    useShortcutCheatsheetStore.getState().closeCheatsheet();
    const after = useShortcutCheatsheetStore.getState();
    expect(after.open).toBe(false);
    expect(after.open).toBe(before.open);
  });
});
