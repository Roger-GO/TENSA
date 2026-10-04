/**
 * The command-palette slice: open or closed, and which page it lists.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useCommandPaletteStore } from '@/store/commandPalette';

beforeEach(() => {
  useCommandPaletteStore.setState({ open: false, page: 'commands' });
});

describe('useCommandPaletteStore', () => {
  it('opens on the command list', () => {
    useCommandPaletteStore.getState().openPalette();
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'commands' });
  });

  it('opens straight onto another page, or switches the open palette to it', () => {
    useCommandPaletteStore.getState().openPage('open-case');
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'open-case' });

    useCommandPaletteStore.getState().setPage('commands');
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'commands' });

    useCommandPaletteStore.getState().openPage('open-case');
    expect(useCommandPaletteStore.getState().page).toBe('open-case');
  });

  it('forgets the page on close, so the next opening starts on the commands', () => {
    useCommandPaletteStore.getState().openPage('open-case');
    useCommandPaletteStore.getState().closePalette();
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, page: 'commands' });
    useCommandPaletteStore.getState().openPalette();
    expect(useCommandPaletteStore.getState().page).toBe('commands');
  });

  it('toggling an open palette closes it, and toggling a closed one opens the commands', () => {
    useCommandPaletteStore.getState().openPage('open-case');
    useCommandPaletteStore.getState().togglePalette();
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, page: 'commands' });
    useCommandPaletteStore.getState().togglePalette();
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'commands' });
  });

  it('the top bar hint can pass its click event straight to openPalette', () => {
    // onClick={openPalette} hands the event as the first argument.
    (useCommandPaletteStore.getState().openPalette as (e?: unknown) => void)({ type: 'click' });
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'commands' });
  });
});
