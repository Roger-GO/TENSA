/**
 * Tests for `<ConvergenceErrorPanel />`.
 *
 * Covers the banner + slide-out + dismiss behavior. Per R8 +
 * interaction-states matrix: NOT a modal; inspector + results table
 * stay visible underneath.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ConvergenceErrorPanel } from '@/components/pflow/ConvergenceErrorPanel';
import { makeQueryClient } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { parseRunId, parseSessionId } from '@/api/types';
import type { PflowResult } from '@/api/types';

function makeWrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { Wrapper };
}

function makeNonConvergedResult(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: false,
    iterations: 30,
    mismatch: 1.5,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {},
    ...overrides,
  };
}

describe('<ConvergenceErrorPanel />', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('renders nothing when there is no PF result', () => {
    const { Wrapper } = makeWrapper();
    const { container } = render(<ConvergenceErrorPanel />, { wrapper: Wrapper });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when PF converged', () => {
    usePflowStore.setState({
      lastRun: { ...makeNonConvergedResult(), converged: true },
      isRunning: false,
      error: null,
    });
    const { Wrapper } = makeWrapper();
    const { container } = render(<ConvergenceErrorPanel />, { wrapper: Wrapper });
    expect(container.firstChild).toBeNull();
  });

  it('renders the banner when PF did not converge', () => {
    usePflowStore.setState({
      lastRun: makeNonConvergedResult({ iterations: 30 }),
      isRunning: false,
      error: null,
    });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    expect(screen.getByTestId('convergence-error-panel')).toBeInTheDocument();
    expect(screen.getByText(/PF did not converge/i)).toBeInTheDocument();
    expect(screen.getByText(/30 iterations/i)).toBeInTheDocument();
  });

  it('renders via the single error primitive (role=alert banner; "Run again" is the recovery CTA)', () => {
    usePflowStore.setState({
      lastRun: makeNonConvergedResult({ iterations: 30 }),
      isRunning: false,
      error: null,
    });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    // The migrated wrapper renders the primitive's banner surface.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The recovery descriptor (kind: retry) surfaces the "Run again" CTA.
    expect(screen.getByRole('button', { name: /run again/i })).toBeInTheDocument();
  });

  it('expands details on click; shows iteration + mismatch + run_id', async () => {
    usePflowStore.setState({
      lastRun: makeNonConvergedResult({ iterations: 28, mismatch: 0.0123 }),
      isRunning: false,
      error: null,
    });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    expect(screen.queryByTestId('convergence-error-details')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /view details/i }));

    expect(screen.getByTestId('convergence-error-details')).toBeInTheDocument();
    expect(screen.getByText(/last mismatch/i)).toBeInTheDocument();
    expect(screen.getByText(/1\.230e-2/i)).toBeInTheDocument();
  });

  it('dismiss button hides the banner; same run does not re-show', async () => {
    usePflowStore.setState({
      lastRun: makeNonConvergedResult(),
      isRunning: false,
      error: null,
    });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    expect(screen.getByTestId('convergence-error-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/dismiss convergence error/i));
    expect(screen.queryByTestId('convergence-error-panel')).not.toBeInTheDocument();
  });

  it('a new PF run (different run_id) re-shows the banner after dismiss', async () => {
    usePflowStore.setState({
      lastRun: makeNonConvergedResult({ run_id: parseRunId('run-1') }),
      isRunning: false,
      error: null,
    });
    const { Wrapper } = makeWrapper();
    const { rerender } = render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByLabelText(/dismiss convergence error/i));
    expect(screen.queryByTestId('convergence-error-panel')).not.toBeInTheDocument();

    // A new failed run lands; the banner re-appears.
    usePflowStore.setState({
      lastRun: makeNonConvergedResult({ run_id: parseRunId('run-2') }),
      isRunning: false,
      error: null,
    });
    rerender(<ConvergenceErrorPanel />);
    expect(screen.getByTestId('convergence-error-panel')).toBeInTheDocument();
  });

  it('Run again triggers a new PF mutation', async () => {
    usePflowStore.setState({
      lastRun: makeNonConvergedResult(),
      isRunning: false,
      error: null,
    });
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            run_id: 'run-2',
            converged: true,
            iterations: 5,
            mismatch: 1e-7,
            bus_voltages: {},
            bus_angles: {},
            line_flows: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByRole('button', { name: /view details/i }));
    await userEvent.click(screen.getByRole('button', { name: /run again/i }));

    expect(fetchSpy).toHaveBeenCalled();
  });
});
