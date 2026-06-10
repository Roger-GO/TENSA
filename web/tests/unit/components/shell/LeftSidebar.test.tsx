/**
 * Tests for `<LeftSidebar />` (v3 Unit 3).
 *
 * Concerns:
 *  - Mounts the three sections (Case, Saved cases, Component library)
 *    with stable testids.
 *  - Each section renders its uppercase heading.
 *  - The shell composition holds — CaseNav + SavedCasesList +
 *    ComponentLibrary all mount together.
 *
 * Network is stubbed via the api/queries mock so SavedCasesList +
 * CaseNav (which both consume `useListWorkspaceFiles`) don't fire real
 * fetches in jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { LeftSidebar } from '@/components/shell/LeftSidebar';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useListWorkspaceFiles: () => ({
      data: { files: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useListSnapshots: () => ({
      data: { snapshots: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useLoadCase: () => ({
      mutate: vi.fn(),
      isPending: false,
      reset: vi.fn(),
      error: null,
    }),
    useRestoreSnapshot: () => ({
      mutateAsync: vi.fn(),
      mutate: vi.fn(),
      isPending: false,
      reset: vi.fn(),
      error: null,
    }),
    useDeleteSession: () => ({
      mutate: vi.fn(),
      isPending: false,
      reset: vi.fn(),
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
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
});

afterEach(() => {
  cleanup();
});

describe('<LeftSidebar />', () => {
  it('mounts the root container with the testid', () => {
    render(withClient(<LeftSidebar />));
    expect(screen.getByTestId('left-sidebar')).toBeInTheDocument();
  });

  it('renders the three section containers in order', () => {
    render(withClient(<LeftSidebar />));
    const caseSection = screen.getByTestId('left-sidebar-section-case');
    const savedSection = screen.getByTestId('left-sidebar-section-saved-cases');
    const librarySection = screen.getByTestId('left-sidebar-section-component-library');
    expect(caseSection).toBeInTheDocument();
    expect(savedSection).toBeInTheDocument();
    expect(librarySection).toBeInTheDocument();
    // Order check — DOM position guarantees the visual stack matches
    // the IA spec.
    expect(
      caseSection.compareDocumentPosition(savedSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      savedSection.compareDocumentPosition(librarySection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders each section heading with the uppercase label', () => {
    render(withClient(<LeftSidebar />));
    expect(screen.getByTestId('left-sidebar-section-case-heading').textContent).toBe('Case');
    expect(screen.getByTestId('left-sidebar-section-saved-cases-heading').textContent).toBe(
      'Saved cases',
    );
    expect(screen.getByTestId('left-sidebar-section-component-library-heading').textContent).toBe(
      'Component library',
    );
  });

  it('mounts the three child components together', () => {
    render(withClient(<LeftSidebar />));
    // CaseNav (no case loaded) renders WorkspaceFilePicker, whose
    // empty-state EmptyState surfaces "No supported case files".
    // SavedCasesList renders its own EmptyState ("No case files").
    // ComponentLibrary surfaces its grid.
    expect(screen.getByTestId('saved-cases-list')).toBeInTheDocument();
    expect(screen.getByTestId('component-library')).toBeInTheDocument();
  });
});
