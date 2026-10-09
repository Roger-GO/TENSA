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
 *
 * The list also holds what the diagram answers to that is no command (how a
 * line is moved by hand, how things are connected by a drag). `section` is
 * the part of it a help entry asks for: the cheatsheet opens scrolled to it.
 */
import { create } from 'zustand';

/** A part of the cheatsheet that can be asked for by name. */
export type CheatsheetSection = 'diagram' | 'connect';

export interface ShortcutCheatsheetState {
  /** True while the cheatsheet is mounted in the open position. */
  open: boolean;
  /** The part to show when it opens, or `null` for its top. */
  section: CheatsheetSection | null;
  /** Open the cheatsheet, at `section` when one is given. */
  openCheatsheet: (section?: CheatsheetSection) => void;
  /** Close the cheatsheet (no-op if already closed). */
  closeCheatsheet: () => void;
  /** Toggle the cheatsheet open/closed. */
  toggleCheatsheet: () => void;
}

export const useShortcutCheatsheetStore = create<ShortcutCheatsheetState>((set) => ({
  open: false,
  section: null,
  openCheatsheet: (section) => set({ open: true, section: section ?? null }),
  closeCheatsheet: () => set({ open: false, section: null }),
  toggleCheatsheet: () => set((state) => ({ open: !state.open, section: null })),
}));
