/**
 * WorkflowToolbar — Reload + Undo affordances + destructive-confirm
 * modal.
 *
 * The toolbar wraps two mutation hooks (`useReloadCase`,
 * `useUndoLastEdit`); the tests stub the API client so the lifecycle
 * is exercised without a live substrate. We assert the disabled/enabled
 * gates flip correctly with the topology + selection state combinations
 * the toolbar handles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { WorkflowToolbar } from '@/components/case/WorkflowToolbar';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { ProblemDetails, TopologySummary } from '@/api/types';

const postSpy = vi.fn();
type PostResolver = () => Promise<unknown>;
let nextPost: PostResolver = () => Promise.resolve(emptyTopology());

function emptyTopology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

function makeProblemDetails(status: number, detail: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: `HTTP ${status}`,
    status,
    detail,
    instance: null,
  };
}

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      post: (path: string) => {
        postSpy(path);
        return nextPost();
      },
    },
  };
});

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  postSpy.mockClear();
  nextPost = () => Promise.resolve(emptyTopology());
  MOCK_TOPOLOGY = emptyTopology();
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: null,
    topology: emptyTopology(),
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
});

describe('<WorkflowToolbar />', () => {
  it('renders both Undo and Reload buttons', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    expect(screen.getByTestId('undo-last-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('reload-case-button')).toBeInTheDocument();
  });

  it('disables Reload on a blank session', () => {
    useCaseStore.setState({
      selection: { primaryPath: null, addfiles: [], blank: true },
    });
    render(withQueryClient(<WorkflowToolbar />));
    expect(screen.getByTestId('reload-case-button')).toBeDisabled();
  });

  it('enables Reload on a loaded session', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    expect(screen.getByTestId('reload-case-button')).toBeEnabled();
  });

  it('disables both buttons when there is no topology', () => {
    MOCK_TOPOLOGY = null;
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    expect(screen.getByTestId('reload-case-button')).toBeDisabled();
    expect(screen.getByTestId('undo-last-edit-button')).toBeDisabled();
  });

  it('disables Undo when topology is committed (post-PF)', () => {
    MOCK_TOPOLOGY = { ...emptyTopology(), state: 'committed' };
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    expect(screen.getByTestId('undo-last-edit-button')).toBeDisabled();
  });

  it('clicking Reload opens the destructive-confirm dialog', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    await userEvent.click(screen.getByTestId('reload-case-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Reload from file\?/i);
    expect(screen.getByTestId('reload-confirm')).toBeInTheDocument();
  });

  it('Cancel on the reload dialog closes without firing the request', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    await userEvent.click(screen.getByTestId('reload-case-button'));
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('confirming Reload fires POST /sessions/{id}/reload', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    await userEvent.click(screen.getByTestId('reload-case-button'));
    await userEvent.click(screen.getByTestId('reload-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    const path = postSpy.mock.calls[0]?.[0];
    expect(path).toContain('/sessions/test-session-id/reload');
  });

  it('clicking Undo fires POST /sessions/{id}/undo-last-edit (no confirm)', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    await userEvent.click(screen.getByTestId('undo-last-edit-button'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    const path = postSpy.mock.calls[0]?.[0];
    expect(path).toContain('/sessions/test-session-id/undo-last-edit');
    // No confirm dialog for Undo (only Reload is destructive).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('surfaces an inline error when Undo fails (e.g., 422 nothing-to-undo)', async () => {
    const { ProblemDetailsError } = await import('@/api/client');
    nextPost = () =>
      Promise.reject(
        new ProblemDetailsError(makeProblemDetails(422, 'Nothing to undo')),
      );
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<WorkflowToolbar />));
    await userEvent.click(screen.getByTestId('undo-last-edit-button'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('workflow-error')).toHaveTextContent(/Nothing to undo/);
  });
});
