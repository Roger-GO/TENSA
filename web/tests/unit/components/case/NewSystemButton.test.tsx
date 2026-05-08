/**
 * NewSystemButton — workspace-picker affordance to create a blank
 * `andes.System()` session.
 *
 * Behavior under test:
 * - Without a loaded case: clicking fires the blank mutation directly.
 * - With a loaded case: opens a destructive-confirm modal first.
 * - On 409 (system already loaded): inline error message.
 * - On success: setCase is called with `blank: true`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { NewSystemButton } from '@/components/case/NewSystemButton';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { ProblemDetails, TopologySummary } from '@/api/types';

const postSpy = vi.fn();
type PostResolver = () => Promise<unknown>;
let nextPost: PostResolver = () =>
  Promise.resolve({
    session_id: 'test-session-id',
    topology: emptyTopology(),
  });

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

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  postSpy.mockClear();
  nextPost = () =>
    Promise.resolve({
      session_id: 'test-session-id',
      topology: emptyTopology(),
    });
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
});

describe('<NewSystemButton />', () => {
  it('renders the "+ New system" button enabled when a session exists', () => {
    render(withQueryClient(<NewSystemButton />));
    const btn = screen.getByTestId('new-system-button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/New system/i);
    expect(btn).toBeEnabled();
  });

  it('disables the button when there is no sessionId', () => {
    useSessionStore.setState({ sessionId: null });
    render(withQueryClient(<NewSystemButton />));
    expect(screen.getByTestId('new-system-button')).toBeDisabled();
  });

  it('with no current case, clicking fires the blank mutation directly (no modal)', async () => {
    render(withQueryClient(<NewSystemButton />));
    await userEvent.click(screen.getByTestId('new-system-button'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    expect(postSpy.mock.calls[0]?.[0]).toContain('/sessions/test-session-id/blank');
    // No confirmation dialog.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('on success, sets the case slice with blank=true and primaryPath=null', async () => {
    render(withQueryClient(<NewSystemButton />));
    await userEvent.click(screen.getByTestId('new-system-button'));
    await waitFor(() => {
      expect(useCaseStore.getState().selection).toMatchObject({
        primaryPath: null,
        blank: true,
      });
    });
  });

  it('with a loaded case, clicking opens the destructive-confirm modal first', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<NewSystemButton />));
    await userEvent.click(screen.getByTestId('new-system-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Discard current system\?/i);
    expect(screen.getByTestId('new-system-confirm')).toBeInTheDocument();
    // Mutation has NOT fired yet.
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('Keep current cancels the modal and does not fire the mutation', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<NewSystemButton />));
    await userEvent.click(screen.getByTestId('new-system-button'));
    await userEvent.click(screen.getByRole('button', { name: /Keep current/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('Discard & start blank fires the mutation and clears the modal', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<NewSystemButton />));
    await userEvent.click(screen.getByTestId('new-system-button'));
    await userEvent.click(screen.getByTestId('new-system-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    expect(postSpy.mock.calls[0]?.[0]).toContain('/sessions/test-session-id/blank');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('on a 409 from the substrate, surfaces the explanatory error inline', async () => {
    const { ProblemDetailsError } = await import('@/api/client');
    nextPost = () =>
      Promise.reject(
        new ProblemDetailsError(makeProblemDetails(409, 'A System is already loaded')),
      );
    render(withQueryClient(<NewSystemButton />));
    await userEvent.click(screen.getByTestId('new-system-button'));
    await waitFor(() => {
      expect(screen.getByTestId('new-system-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('new-system-error')).toHaveTextContent(/already loaded/i);
  });

  it('on a generic error, surfaces the message inline', async () => {
    nextPost = () => Promise.reject(new Error('Network down'));
    render(withQueryClient(<NewSystemButton />));
    await userEvent.click(screen.getByTestId('new-system-button'));
    await waitFor(() => {
      expect(screen.getByTestId('new-system-error')).toHaveTextContent(/Network down/);
    });
  });
});
