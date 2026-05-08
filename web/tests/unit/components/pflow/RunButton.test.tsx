/**
 * Tests for `<RunButton />`.
 *
 * Covers the state machine: idle (no case) / idle (case loaded) /
 * running / success-toast / error-route. Network is mocked via
 * `globalThis.fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RunButton } from '@/components/pflow/RunButton';
import { makeQueryClient } from '@/api/queries';
import { setTokenGetter } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeWrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { Wrapper };
}

function seedLoadedCase() {
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [],
    },
    topology: {
      state: 'pre-setup',
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    },
    layoutSidecar: null,
    selectedElement: null,
  });
  useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
}

describe('<RunButton />', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTokenGetter(() => 'test-token');
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
  });

  it('is disabled when no case is loaded', () => {
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    expect(screen.getByTestId('run-pflow-button')).toBeDisabled();
  });

  it('is enabled when case + session are loaded', () => {
    seedLoadedCase();
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    expect(screen.getByTestId('run-pflow-button')).toBeEnabled();
  });

  it('shows the spinner + Running label while PF is running', () => {
    seedLoadedCase();
    usePflowStore.setState({ isRunning: true, lastRun: null, error: null });
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    expect(screen.getByTestId('run-pflow-button')).toBeDisabled();
    expect(screen.getByText(/running pf/i)).toBeInTheDocument();
  });

  it('on PF success (converged), shows the success toast', async () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          run_id: 'run-abc',
          converged: true,
          iterations: 3,
          mismatch: 1e-7,
          bus_voltages: { '1': 1.0 },
          bus_angles: { '1': 0 },
          line_flows: {},
        }),
      ),
    );
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('run-pflow-button'));

    await waitFor(() => {
      expect(screen.getByTestId('pflow-success-toast')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pflow-success-toast')).toHaveTextContent(/converged in 3/i);
  });

  it('on non-convergence (200 + converged=false), does NOT show success toast', async () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          run_id: 'run-bad',
          converged: false,
          iterations: 30,
          mismatch: 1.5,
          bus_voltages: {},
          bus_angles: {},
          line_flows: {},
        }),
      ),
    );
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('run-pflow-button'));

    // Wait for the mutation to settle.
    await waitFor(() => {
      expect(usePflowStore.getState().lastRun).not.toBeNull();
    });

    // No success toast — the convergence panel is the surface (a
    // different component subscribes to lastRun).
    expect(screen.queryByTestId('pflow-success-toast')).not.toBeInTheDocument();
  });

  it('on 5xx, sets pflow.error to a ServerError so RuntimeCrashModal opens', async () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ title: 'Internal Server Error', status: 500, detail: 'boom' }, 500),
      ),
    );
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('run-pflow-button'));

    await waitFor(() => {
      const err = usePflowStore.getState().error;
      expect(err).not.toBeNull();
      expect(err?.status).toBe(500);
    });
  });

  it('shows a tooltip on the disabled button explaining the cause', async () => {
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    const button = screen.getByTestId('run-pflow-button');
    await userEvent.hover(button.parentElement!);

    const matches = await screen.findAllByText(/Load a case first/i);
    expect(matches.length).toBeGreaterThan(0);
  });
});
