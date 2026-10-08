/**
 * `<ReloadedCaseNote />`: what the page says after a reload that closed a case,
 * and the button that opens the case again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReloadedCaseNote } from '@/components/case/ReloadedCaseNote';
import { parseSessionId } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { OPEN_CASE_STORAGE_KEY, useReloadedCaseStore } from '@/store/reloadedCase';
import { useSessionStore } from '@/store/session';

// ---- mocks ---------------------------------------------------------------
const loadCaseMutate = vi.fn();
const listWorkspaceFiles = vi.fn();
let mockFiles: ReadonlyArray<{ name: string; format: string }> | undefined = [];
let loadPending = false;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useListWorkspaceFiles: () => {
      listWorkspaceFiles();
      return { data: mockFiles === undefined ? undefined : { files: mockFiles } };
    },
    useLoadCase: () => ({ mutateAsync: loadCaseMutate, isPending: loadPending }),
  };
});

function closeByReload(primaryPath: string, addfiles: string[] = []): void {
  window.sessionStorage.setItem(OPEN_CASE_STORAGE_KEY, JSON.stringify({ primaryPath, addfiles }));
  useReloadedCaseStore.setState({ closed: { primaryPath, addfiles } });
}

beforeEach(() => {
  loadCaseMutate.mockReset();
  loadCaseMutate.mockResolvedValue({});
  listWorkspaceFiles.mockReset();
  loadPending = false;
  mockFiles = [
    { name: 'kundur_full.xlsx', format: 'xlsx' },
    { name: 'ieee14.raw', format: 'raw' },
    { name: 'ieee14.dyr', format: 'dyr' },
  ];
  window.sessionStorage.clear();
  useReloadedCaseStore.setState({ closed: null });
  useSessionStore.setState({ sessionId: parseSessionId('test-session') });
  useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  useReloadedCaseStore.setState({ closed: null });
});

describe('<ReloadedCaseNote />', () => {
  it('draws nothing on a first visit, and asks the server nothing', () => {
    const { container } = render(<ReloadedCaseNote placement="diagram" />);
    expect(container).toBeEmptyDOMElement();
    expect(listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('says that the reload closed the case, and which one', () => {
    closeByReload('kundur_full.xlsx');
    render(<ReloadedCaseNote placement="project" />);
    expect(screen.getByTestId('reloaded-case-note-project')).toHaveTextContent(
      'A reload of the page closes the open case. kundur_full.xlsx was open.',
    );
    expect(screen.getByRole('group', { name: 'Case closed by the reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen kundur_full.xlsx' })).toBeEnabled();
  });

  it('opens the case again in one click, with the dynamic files it was opened with', async () => {
    closeByReload('ieee14.raw', ['ieee14.dyr']);
    render(<ReloadedCaseNote placement="diagram" />);
    expect(screen.getByTestId('reloaded-case-note-diagram')).toHaveTextContent(
      'ieee14.raw was open, with ieee14.dyr.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reopen ieee14.raw' }));
    expect(loadCaseMutate).toHaveBeenCalledWith({
      sessionId: 'test-session',
      request: { primary_path: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
    });
    await waitFor(() =>
      expect(useCaseStore.getState().selection).toEqual({
        primaryPath: 'ieee14.raw',
        addfiles: ['ieee14.dyr'],
      }),
    );
  });

  it('leaves out a dynamic file the workspace no longer holds', async () => {
    mockFiles = [{ name: 'ieee14.raw', format: 'raw' }];
    closeByReload('ieee14.raw', ['ieee14.dyr']);
    render(<ReloadedCaseNote placement="components" />);
    expect(screen.getByTestId('reloaded-case-note-components')).toHaveTextContent(
      'ieee14.raw was open.',
    );
    await userEvent.click(screen.getByTestId('reloaded-case-reopen-components'));
    expect(loadCaseMutate).toHaveBeenCalledWith({
      sessionId: 'test-session',
      request: { primary_path: 'ieee14.raw', addfiles: null },
    });
  });

  it('names the file without its folder', () => {
    mockFiles = [{ name: 'studies/kundur_full.xlsx', format: 'xlsx' }];
    closeByReload('studies/kundur_full.xlsx');
    render(<ReloadedCaseNote placement="diagram" />);
    expect(screen.getByRole('button', { name: 'Reopen kundur_full.xlsx' })).toBeInTheDocument();
  });

  it('waits for the server session before it can reopen, and says so', () => {
    useSessionStore.setState({ sessionId: null });
    closeByReload('kundur_full.xlsx');
    render(<ReloadedCaseNote placement="diagram" />);
    const reopen = screen.getByRole('button', { name: 'Reopen kundur_full.xlsx' });
    expect(reopen).toBeDisabled();
    expect(reopen).toHaveAttribute('title', 'The server session is not ready yet.');
  });

  it('cannot be pressed twice while the case is loading', () => {
    loadPending = true;
    closeByReload('kundur_full.xlsx');
    render(<ReloadedCaseNote placement="diagram" />);
    expect(screen.getByRole('button', { name: 'Reopen kundur_full.xlsx' })).toBeDisabled();
  });

  it('says what the reload closed before the workspace has been listed', () => {
    mockFiles = undefined;
    closeByReload('kundur_full.xlsx');
    render(<ReloadedCaseNote placement="diagram" />);
    expect(screen.getByRole('button', { name: 'Reopen kundur_full.xlsx' })).toBeEnabled();
  });

  it('forgets a case whose file has left the workspace', async () => {
    mockFiles = [{ name: 'ieee14.raw', format: 'raw' }];
    closeByReload('kundur_full.xlsx');
    const { container } = render(<ReloadedCaseNote placement="diagram" />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(useReloadedCaseStore.getState().closed).toBeNull());
    expect(window.sessionStorage.getItem(OPEN_CASE_STORAGE_KEY)).toBeNull();
  });
});
