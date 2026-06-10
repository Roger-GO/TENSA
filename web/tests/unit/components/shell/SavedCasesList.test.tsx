/**
 * Tests for `<SavedCasesList />` (v3 Unit 4).
 *
 * Concerns:
 *  - Happy path: 3 workspace files + 2 snapshots render with the
 *    expected testids when a case is loaded.
 *  - Workspace-file row click fires the loadCase mutation with the
 *    parsed primary path + null addfiles.
 *  - Snapshot row click fires the restoreSnapshot mutation with the
 *    dill fast path enabled.
 *  - Same-file no-op guard: clicking a row that matches the
 *    currently-loaded case does NOT fire loadCase.
 *  - No-case-loaded hides the snapshot section entirely.
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
      mutate: loadCaseMutate,
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

  it('clicking the already-loaded case is a same-file no-op (loadCase NOT fired)', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    render(withClient(<SavedCasesList />));
    await user.click(screen.getByTestId('saved-cases-row-kundur.raw'));
    expect(loadCaseMutate).not.toHaveBeenCalled();
  });

  it('clicking a snapshot row fires restoreSnapshot with dill fast path enabled', async () => {
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
    expect(restoreMutateAsync).toHaveBeenCalledWith({
      sessionId: 'test-session',
      name: 'baseline',
      useDillOptimization: true,
    });
  });

  it('renders the workspace EmptyState when the workspace lister returns []', () => {
    mockFiles = [];
    render(withClient(<SavedCasesList />));
    expect(screen.getByTestId('saved-cases-files-empty')).toBeInTheDocument();
  });
});
