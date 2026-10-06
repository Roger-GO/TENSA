/**
 * Tests for `<SavedCasesList />` (v3 Unit 4).
 *
 * Concerns:
 *  - Happy path: 3 workspace files + 2 snapshots render with the
 *    expected testids when a case is loaded.
 *  - Workspace-file row click fires the loadCase mutation with the
 *    parsed primary path + null addfiles.
 *  - Snapshot row click fires the restoreSnapshot mutation without the
 *    dill opt-in, so the restore replays (the default).
 *  - Same-file no-op guard: clicking a row that matches the
 *    currently-loaded case does NOT fire loadCase.
 *  - No-case-loaded hides the snapshot section entirely.
 *  - The snapshot section has the button that saves one, with and
 *    without snapshots, and says what a click on a row does.
 *  - Empty workspace renders the EmptyState (with the
 *    `saved-cases-files-empty` test id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SavedCasesList } from '@/components/shell/SavedCasesList';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useSnapshotStore } from '@/store/snapshot';
import { useRecentCasesStore } from '@/store/recentCases';
import { useUploadNoticeStore } from '@/store/uploadNotice';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

// ---- mocks ---------------------------------------------------------------
const loadCaseMutate = vi.fn();
const restoreMutateAsync = vi.fn();
let mockFiles: ReadonlyArray<{
  name: string;
  size_bytes: number;
  modified_iso: string;
  format: string;
}> = [];
let mockSnapshots: ReadonlyArray<{
  name: string;
  saved_at: string;
  has_pflow: boolean;
  has_tds: boolean;
  has_dill: boolean;
  andes_version: string;
  disturbance_count: number;
}> = [];

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useListWorkspaceFiles: () => ({
      data: { files: mockFiles },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useListSnapshots: () => ({
      data: { snapshots: mockSnapshots },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useLoadCase: () => ({
      mutateAsync: loadCaseMutate,
      isPending: false,
      reset: vi.fn(),
      error: null,
    }),
    useRestoreSnapshot: () => ({
      mutateAsync: restoreMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      reset: vi.fn(),
      error: null,
    }),
  };
});

function withClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  loadCaseMutate.mockReset();
  loadCaseMutate.mockResolvedValue({});
  restoreMutateAsync.mockReset();
  mockFiles = [
    { name: 'kundur.raw', size_bytes: 1024, modified_iso: '2026-05-01T00:00:00Z', format: 'raw' },
    { name: 'ieee14.raw', size_bytes: 2048, modified_iso: '2026-05-01T00:00:00Z', format: 'raw' },
    { name: 'demo.xlsx', size_bytes: 3072, modified_iso: '2026-05-01T00:00:00Z', format: 'xlsx' },
    // sidecar should be filtered out
    {
      name: 'kundur.layout.json',
      size_bytes: 256,
      modified_iso: '2026-05-01T00:00:00Z',
      format: 'json',
    },
  ];
  mockSnapshots = [];
  useSessionStore.setState({ sessionId: parseSessionId('test-session') });
  useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
  useRecentCasesStore.setState({ cases: [] });
  useUploadNoticeStore.getState().dismiss();
  useSnapshotStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('<SavedCasesList />', () => {
  it('renders 3 workspace file rows + filters out the .layout.json sidecar', () => {
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-row-kundur.raw')).toBeInTheDocument();
    expect(screen.getByTestId('saved-cases-row-ieee14.raw')).toBeInTheDocument();
    expect(screen.getByTestId('saved-cases-row-demo.xlsx')).toBeInTheDocument();
    // Sidecar is excluded.
    expect(screen.queryByTestId('saved-cases-row-kundur.layout.json')).toBeNull();
  });

  it('hides the snapshot section when no case is loaded', () => {
    render(withClient(<SavedCasesList />));
    expect(screen.queryByTestId('saved-cases-snapshots-group')).toBeNull();
    expect(screen.queryByTestId('saved-cases-snapshots-empty')).toBeNull();
  });

  it('renders the snapshot section + 2 snapshot rows when a case is loaded', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    mockSnapshots = [
      {
        name: 'baseline',
        saved_at: '2026-05-01T00:00:00Z',
        has_pflow: true,
        has_tds: false,
        has_dill: true,
        andes_version: '1.9.0',
        disturbance_count: 0,
      },
      {
        name: 'post-disturbance',
        saved_at: '2026-05-01T01:00:00Z',
        has_pflow: true,
        has_tds: true,
        has_dill: true,
        andes_version: '1.9.0',
        disturbance_count: 2,
      },
    ];
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-snapshots-group')).toBeInTheDocument();
    expect(screen.getByTestId('saved-cases-row-snapshot-baseline')).toBeInTheDocument();
    expect(screen.getByTestId('saved-cases-row-snapshot-post-disturbance')).toBeInTheDocument();
  });

  it('shows the snapshot empty state when a case is loaded but no snapshots exist', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    mockSnapshots = [];
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-snapshots-empty')).toBeInTheDocument();
  });

  it('has a Save snapshot button in the snapshot section, which the empty state points to', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    mockSnapshots = [];
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-snapshots-empty')).toHaveTextContent(
      'Use Save snapshot to keep the operating point and the diagram as it is placed now',
    );
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save snapshot…' }));
    // The dialog itself is mounted at the app's root and opens from this flag.
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });

  it('keeps the Save snapshot button once there are snapshots, and says what a click on one does', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    mockSnapshots = [
      {
        name: 'baseline',
        saved_at: '2026-05-01T00:00:00Z',
        has_pflow: true,
        has_tds: false,
        has_dill: false,
        andes_version: '1.9.0',
        disturbance_count: 0,
      },
    ];
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-save-snapshot')).toBeInTheDocument();
    // The row is named for what it does, not only for the snapshot.
    expect(screen.getByRole('button', { name: /^Restore snapshot\s*baseline/ })).toBe(
      screen.getByTestId('saved-cases-row-snapshot-baseline'),
    );
    expect(screen.getByTestId('saved-cases-snapshots-hint')).toHaveTextContent(
      'Click a snapshot to restore its operating point and diagram layout.',
    );
  });

  it('has no Save snapshot button while no case is loaded', () => {
    render(withClient(<SavedCasesList />));
    expect(screen.queryByTestId('saved-cases-save-snapshot')).toBeNull();
  });

  it('clicking a workspace file row fires loadCase with the parsed path + no addfiles', async () => {
    const user = userEvent.setup();
    render(withClient(<SavedCasesList />));
    await user.click(screen.getByTestId('saved-cases-row-ieee14.raw'));
    expect(loadCaseMutate).toHaveBeenCalledTimes(1);
    const [vars] = loadCaseMutate.mock.calls[0] ?? [];
    expect(vars).toEqual({
      sessionId: 'test-session',
      request: { primary_path: 'ieee14.raw', addfiles: null },
    });
  });

  it('marks the row of the case being loaded', () => {
    useCaseStore.setState({ loadingPath: parseWorkspacePath('ieee14.raw') });
    try {
      render(withClient(<SavedCasesList />));
      const loading = screen.getByTestId('saved-cases-row-ieee14.raw');
      expect(loading).toHaveAttribute('aria-busy', 'true');
      expect(loading).toHaveTextContent('Loading…');
      // The other rows keep their format tag.
      expect(screen.getByTestId('saved-cases-row-kundur.raw')).toHaveTextContent('RAW');
      expect(screen.getByTestId('saved-cases-row-kundur.raw')).not.toHaveAttribute('aria-busy');
    } finally {
      useCaseStore.setState({ loadingPath: null });
    }
  });

  it('clicking the already-loaded case is a same-file no-op (loadCase NOT fired)', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    render(withClient(<SavedCasesList />));
    await user.click(screen.getByTestId('saved-cases-row-kundur.raw'));
    expect(loadCaseMutate).not.toHaveBeenCalled();
  });

  it('clicking a snapshot row fires restoreSnapshot without the dill opt-in', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    mockSnapshots = [
      {
        name: 'baseline',
        saved_at: '2026-05-01T00:00:00Z',
        has_pflow: true,
        has_tds: false,
        has_dill: true,
        andes_version: '1.9.0',
        disturbance_count: 0,
      },
    ];
    restoreMutateAsync.mockResolvedValue({
      used_dill: true,
      fallback_reason: null,
      disturbances_replayed: 0,
    });
    render(withClient(<SavedCasesList />));
    await user.click(screen.getByTestId('saved-cases-row-snapshot-baseline'));
    expect(restoreMutateAsync).toHaveBeenCalledTimes(1);
    // No ``useDillOptimization``: the hook's default is the replay restore,
    // even for a snapshot that carries a solver-state blob.
    expect(restoreMutateAsync).toHaveBeenCalledWith({
      sessionId: 'test-session',
      name: 'baseline',
    });
  });

  it('renders the workspace EmptyState when the workspace lister returns []', () => {
    mockFiles = [];
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-files-empty')).toBeInTheDocument();
  });

  it('offers to add files to the workspace, and says dropping works too, when there are none', () => {
    mockFiles = [];
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('add-case-files')).toBeInTheDocument();
    expect(screen.getByTestId('saved-cases-files-empty')).toHaveTextContent(
      'Drop a .raw / .xlsx / .json / .m file anywhere in this window, or use Add files.',
    );
  });

  it('says under the list that files can be dropped on the window, and which kinds', () => {
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-drop-hint')).toHaveTextContent(
      'Drop .raw, .dyr, .m, .xlsx, .json files anywhere in this window to add them.',
    );
  });

  describe('files that were turned away', () => {
    it('shows no notice until a file was refused', () => {
      render(withClient(<SavedCasesList />));
      expect(screen.queryByTestId('saved-cases-upload-notice')).toBeNull();
    });

    it('lists each refused file with its reason, under the Workspace header, until dismissed', async () => {
      const user = userEvent.setup();
      useUploadNoticeStore
        .getState()
        .show([
          'test.txt is not a case file. The workspace holds .raw, .dyr, .m, .xlsx, .json files.',
        ]);
      render(withClient(<SavedCasesList />));
      const notice = screen.getByRole('group', { name: 'Files not added' });
      expect(notice).toHaveTextContent('1 file was not added');
      expect(notice).toHaveTextContent('test.txt is not a case file');
      const heading = screen.getByTestId('saved-cases-files-heading');
      expect(
        heading.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByTestId('saved-cases-upload-notice')).toBeNull();
    });

    it('counts several, and shows when the workspace is empty too', () => {
      mockFiles = [];
      useUploadNoticeStore.getState().show(['a.txt is empty.', 'b.zip is not a case file.']);
      render(withClient(<SavedCasesList />));
      const notice = screen.getByTestId('saved-cases-upload-notice');
      expect(notice).toHaveTextContent('2 files were not added');
      expect(notice).toHaveTextContent('a.txt is empty.');
      expect(notice).toHaveTextContent('b.zip is not a case file.');
      expect(screen.getByTestId('saved-cases-files-empty')).toBeInTheDocument();
    });
  });

  describe('recent cases', () => {
    const recent = (primaryPath: string, addfiles: string[] = [], openedAt = 1) => ({
      primaryPath,
      addfiles,
      openedAt,
    });

    it('shows no Recent group before anything has been opened', () => {
      render(withClient(<SavedCasesList />));
      expect(screen.queryByTestId('saved-cases-recent-group')).toBeNull();
    });

    it('lists the cases opened last, newest first, ahead of the workspace files', () => {
      useRecentCasesStore.setState({
        cases: [recent('demo.xlsx'), recent('kundur.raw')],
      });
      render(withClient(<SavedCasesList />));
      const rows = screen
        .getByRole('list', { name: 'Recent cases' })
        .querySelectorAll('[data-testid^="saved-cases-recent-"]');
      expect(Array.from(rows).map((r) => r.getAttribute('data-testid'))).toEqual([
        'saved-cases-recent-demo.xlsx',
        'saved-cases-recent-kundur.raw',
      ]);
      const group = screen.getByTestId('saved-cases-recent-group');
      const workspace = screen.getByTestId('saved-cases-files-heading');
      expect(
        group.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // The same file is still in the workspace list, under its own test id.
      expect(screen.getByTestId('saved-cases-row-demo.xlsx')).toBeInTheDocument();
    });

    it('leaves out a case whose file is no longer in the workspace', () => {
      useRecentCasesStore.setState({ cases: [recent('gone.raw'), recent('kundur.raw')] });
      render(withClient(<SavedCasesList />));
      expect(screen.queryByTestId('saved-cases-recent-gone.raw')).toBeNull();
      expect(screen.getByTestId('saved-cases-recent-kundur.raw')).toBeInTheDocument();
    });

    it('shows no more than five', () => {
      mockFiles = Array.from({ length: 7 }, (_, i) => ({
        name: `case${i}.raw`,
        size_bytes: 1,
        modified_iso: '2026-05-01T00:00:00Z',
        format: 'raw',
      }));
      useRecentCasesStore.setState({
        cases: mockFiles.map((f) => recent(f.name)),
      });
      render(withClient(<SavedCasesList />));
      expect(screen.getByRole('list', { name: 'Recent cases' }).children).toHaveLength(5);
    });

    it('says which dynamic files a case was opened with, and opens it with them', async () => {
      const user = userEvent.setup();
      mockFiles = [
        ...mockFiles,
        {
          name: 'kundur.dyr',
          size_bytes: 1,
          modified_iso: '2026-05-01T00:00:00Z',
          format: 'dyr',
        },
      ];
      useRecentCasesStore.setState({ cases: [recent('kundur.raw', ['kundur.dyr', 'lost.dyr'])] });
      render(withClient(<SavedCasesList />));
      const row = screen.getByTestId('saved-cases-recent-kundur.raw');
      // The file that has left the workspace is not listed and not sent.
      expect(row).toHaveTextContent('with kundur.dyr');
      expect(row).not.toHaveTextContent('lost.dyr');
      await user.click(row);
      expect(loadCaseMutate.mock.calls[0]?.[0]).toEqual({
        sessionId: 'test-session',
        request: { primary_path: 'kundur.raw', addfiles: ['kundur.dyr'] },
      });
    });

    it('opens a recent case with no dynamic files with none', async () => {
      const user = userEvent.setup();
      useRecentCasesStore.setState({ cases: [recent('ieee14.raw')] });
      render(withClient(<SavedCasesList />));
      expect(screen.getByTestId('saved-cases-recent-ieee14.raw')).not.toHaveTextContent('with');
      await user.click(screen.getByTestId('saved-cases-recent-ieee14.raw'));
      expect(loadCaseMutate.mock.calls[0]?.[0]).toEqual({
        sessionId: 'test-session',
        request: { primary_path: 'ieee14.raw', addfiles: null },
      });
    });

    it('marks the open case, and a click on it is a no-op', async () => {
      const user = userEvent.setup();
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
      });
      useRecentCasesStore.setState({ cases: [recent('kundur.raw')] });
      render(withClient(<SavedCasesList />));
      const row = screen.getByTestId('saved-cases-recent-kundur.raw');
      expect(row).toHaveAttribute('aria-current', 'true');
      await user.click(row);
      expect(loadCaseMutate).not.toHaveBeenCalled();
    });
  });
});
