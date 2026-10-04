/**
 * The palette's Open case page: the workspace's case files, filtered as you
 * type, opened the way the sidebar's saved-cases list opens them.
 *
 * It is reached from the "Open case…" command in the palette's own list (which
 * must leave the palette open), from the Workspace menu and from Ctrl/Cmd+O, the
 * last two by setting the palette store's `page`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CommandPalette } from '@/components/shell/CommandPalette';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

const loadCaseMutate = vi.fn();
type FilesState = {
  data?: { files: ReadonlyArray<{ name: string; format: string }> };
  isPending: boolean;
  isError: boolean;
  error: Error | null;
};
let filesState: FilesState = { isPending: false, isError: false, error: null };

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: (): TopologySummary | null => null,
    useListWorkspaceFiles: () => filesState,
    useLoadCase: () => ({ mutateAsync: loadCaseMutate, isPending: false }),
  };
});

function withClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function files(...names: string[]): FilesState {
  return {
    data: {
      files: names.map((name) => ({
        name,
        format: name.slice(name.lastIndexOf('.') + 1),
      })),
    },
    isPending: false,
    isError: false,
    error: null,
  };
}

beforeEach(() => {
  loadCaseMutate.mockReset();
  loadCaseMutate.mockResolvedValue({});
  filesState = files('ieee14.raw', 'kundur_full.xlsx', 'ieee14.raw.layout.json', 'notes.txt');
  useSessionStore.setState({ sessionId: parseSessionId('test-session') });
  useCaseStore.setState({ selection: null });
  useCommandPaletteStore.setState({ open: true, page: 'open-case' });
});

afterEach(() => {
  cleanup();
  useCommandPaletteStore.setState({ open: false, page: 'commands' });
});

describe('<CommandPalette /> Open case page', () => {
  it('lists the case files of the workspace, not the layout sidecars or other files', async () => {
    render(withClient(<CommandPalette />));
    expect(await screen.findByTestId('open-case-item-ieee14.raw')).toBeInTheDocument();
    expect(screen.getByTestId('open-case-item-kundur_full.xlsx')).toBeInTheDocument();
    expect(screen.queryByTestId('open-case-item-ieee14.raw.layout.json')).toBeNull();
    expect(screen.queryByTestId('open-case-item-notes.txt')).toBeNull();
  });

  it('narrows the list as you type', async () => {
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    await screen.findByTestId('open-case-item-ieee14.raw');
    await user.type(screen.getByTestId('command-palette-input'), 'kundur');
    await waitFor(() => expect(screen.queryByTestId('open-case-item-ieee14.raw')).toBeNull());
    expect(screen.getByTestId('open-case-item-kundur_full.xlsx')).toBeInTheDocument();

    await user.type(screen.getByTestId('command-palette-input'), 'zzz');
    expect(await screen.findByText(/No case file matches/i)).toBeInTheDocument();
  });

  it('starts with the filter box focused, so typing needs no click', async () => {
    render(withClient(<CommandPalette />));
    await screen.findByTestId('open-case-item-ieee14.raw');
    expect(screen.getByTestId('command-palette-input')).toHaveFocus();
  });

  it('choosing a file closes the palette and loads that case', async () => {
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    await user.click(await screen.findByTestId('open-case-item-kundur_full.xlsx'));
    expect(loadCaseMutate).toHaveBeenCalledTimes(1);
    expect(loadCaseMutate.mock.calls[0]?.[0]).toEqual({
      sessionId: 'test-session',
      request: { primary_path: 'kundur_full.xlsx', addfiles: null },
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('Enter opens the highlighted file', async () => {
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    await screen.findByTestId('open-case-item-ieee14.raw');
    await user.type(screen.getByTestId('command-palette-input'), 'kundur{Enter}');
    await waitFor(() => expect(loadCaseMutate).toHaveBeenCalledTimes(1));
    expect(loadCaseMutate.mock.calls[0]?.[0]).toMatchObject({
      request: { primary_path: 'kundur_full.xlsx' },
    });
  });

  it('marks the case that is open, and loads nothing when it is chosen again', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    const row = await screen.findByTestId('open-case-item-ieee14.raw');
    expect(row).toHaveTextContent('open now');
    await user.click(row);
    expect(loadCaseMutate).not.toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('goes back to the command list with Backspace on an empty filter, or the button', async () => {
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    await screen.findByTestId('open-case-item-ieee14.raw');
    // Not on a filter that has text in it.
    await user.type(screen.getByTestId('command-palette-input'), 'k');
    await user.keyboard('{Backspace}');
    expect(useCommandPaletteStore.getState().page).toBe('open-case');
    await user.keyboard('{Backspace}');
    expect(useCommandPaletteStore.getState().page).toBe('commands');
    expect(await screen.findByTestId('command-palette-item-help.shortcuts')).toBeInTheDocument();

    useCommandPaletteStore.setState({ page: 'open-case' });
    await user.click(await screen.findByTestId('command-palette-back'));
    expect(useCommandPaletteStore.getState().page).toBe('commands');
  });

  it('Escape closes the palette from this page', async () => {
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    await screen.findByTestId('open-case-item-ieee14.raw');
    await user.keyboard('{Escape}');
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('says so while the workspace is being listed, when it cannot be, and when it is empty', async () => {
    filesState = { isPending: true, isError: false, error: null };
    const { rerender } = render(withClient(<CommandPalette />));
    expect(await screen.findByTestId('command-palette-open-case-loading')).toBeInTheDocument();

    filesState = { isPending: false, isError: true, error: new Error('disk gone') };
    rerender(withClient(<CommandPalette />));
    expect(await screen.findByTestId('command-palette-open-case-error')).toHaveTextContent(
      'disk gone',
    );

    filesState = files('ieee14.raw.layout.json');
    rerender(withClient(<CommandPalette />));
    expect(await screen.findByTestId('command-palette-open-case-none')).toBeInTheDocument();
  });
});

describe('<CommandPalette /> "Open case…" command', () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ open: true, page: 'commands' });
  });

  it('moves the palette to the file list and leaves it open', async () => {
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    await user.click(await screen.findByTestId('command-palette-item-workspace.open-case'));
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'open-case' });
    expect(await screen.findByTestId('open-case-item-ieee14.raw')).toBeInTheDocument();
  });

  it('is found by typing "open", and shows its key', async () => {
    const user = userEvent.setup();
    render(withClient(<CommandPalette />));
    await user.type(await screen.findByTestId('command-palette-input'), 'open case');
    const item = await screen.findByTestId('command-palette-item-workspace.open-case');
    expect(item.querySelectorAll('kbd').length).toBeGreaterThan(0);
  });

  it('is not listed without a session', async () => {
    useSessionStore.setState({ sessionId: null });
    render(withClient(<CommandPalette />));
    await screen.findByTestId('command-palette-input');
    expect(screen.queryByTestId('command-palette-item-workspace.open-case')).toBeNull();
  });
});
