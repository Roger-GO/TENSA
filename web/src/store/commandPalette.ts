/**
 * Command-palette slice (Unit 9 of the v2.0 polish plan).
 *
 * Tracks the open/close state of the global ⌘K command palette.
 *
 * Why a Zustand slice rather than React state at the App root:
 *
 * - The palette is opened from multiple unrelated surfaces — the global
 *   ⌘K hotkey (registered at AppShell), a "⌘K" hint button in the
 *   TopBar's right cluster, and (in future units) help links in
 *   tooltips. Lifting open/close state into a hook above all of them
 *   would force prop-drilling through every menu intermediary; a slice
 *   avoids the plumbing.
 * - The palette interacts with several other stores (snapshot, bundle,
 *   case, ui) — keeping its own state in the same Zustand store family
 *   keeps the React tree free of cross-cutting context providers.
 * - Persistence: the slice is intentionally NOT persisted. Reload
 *   should land with the palette closed.
 *
 * The slice is tiny: `open`, the `page` it lists (commands, or the
 * workspace's case files for "Open case") and a few setters. Future units
 * (Unit 10 will add the `?` cheatsheet) can compose against the same shape.
 */
import { create } from 'zustand';

/** What the open palette lists: every command, or the workspace's case files. */
export type PalettePage = 'commands' | 'open-case';

export interface CommandPaletteState {
  /** True while the palette is mounted in the open position. */
  open: boolean;
  /** The list the palette shows. Opening it any other way than `openPage` starts on commands. */
  page: PalettePage;
  /** Open the palette on its command list (no-op if already open). */
  openPalette: () => void;
  /** Open the palette on `page`, or switch it there when it is already open. */
  openPage: (page: PalettePage) => void;
  /** Switch the open palette to `page`. */
  setPage: (page: PalettePage) => void;
  /** Close the palette (no-op if already closed). */
  closePalette: () => void;
  /** Toggle the palette open/closed. */
  togglePalette: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  page: 'commands',
  openPalette: () => set({ open: true, page: 'commands' }),
  openPage: (page) => set({ open: true, page }),
  setPage: (page) => set({ page }),
  closePalette: () => set({ open: false, page: 'commands' }),
  togglePalette: () => set((state) => ({ open: !state.open, page: 'commands' })),
}));
