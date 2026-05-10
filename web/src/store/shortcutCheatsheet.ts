/**
 * Shortcut-cheatsheet slice (Unit 10 of the v2.0 polish plan).
 *
 * Tracks the open/close state of the global ? keyboard cheatsheet
 * modal. Mirrors the shape of `commandPalette.ts` (Unit 9) so consumers
 * have one consistent pattern for "global modal triggered by a hotkey".
 *
 * Why a Zustand slice rather than a useState hoisted at AppShell:
 *
 * - The cheatsheet can be opened from multiple unrelated surfaces:
 *   the global `?` hotkey (registered at AppShell), the command-palette
 *   entry "Show keyboard shortcuts", and (potentially) help affordances
 *   inside tooltips. A slice avoids prop-drilling toggle handlers
 *   through every intermediary.
 * - Persistence: intentionally NOT persisted. Reload should land with
 *   the cheatsheet closed.
 */
import { create } from 'zustand';

export interface ShortcutCheatsheetState {
  /** True while the cheatsheet is mounted in the open position. */
  open: boolean;
  /** Open the cheatsheet (no-op if already open). */
  openCheatsheet: () => void;
  /** Close the cheatsheet (no-op if already closed). */
  closeCheatsheet: () => void;
  /** Toggle the cheatsheet open/closed. */
  toggleCheatsheet: () => void;
}

export const useShortcutCheatsheetStore = create<ShortcutCheatsheetState>((set) => ({
  open: false,
  openCheatsheet: () => set({ open: true }),
  closeCheatsheet: () => set({ open: false }),
  toggleCheatsheet: () => set((state) => ({ open: !state.open })),
}));
