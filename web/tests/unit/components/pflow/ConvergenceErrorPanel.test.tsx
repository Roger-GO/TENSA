/**
 * Tests for `<ConvergenceErrorPanel />`.
 *
 * Covers the banner + slide-out + dismiss behavior. Per R8 +
 * interaction-states matrix: NOT a modal; inspector + results table
 * stay visible underneath.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ConvergenceErrorPanel } from '@/components/pflow/ConvergenceErrorPanel';
import { makeQueryClient } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { parseRunId, parseSessionId } from '@/api/types';
import type { PflowResult, PflowSettings } from '@/api/types';

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
    usePflowOptionsStore.getState().resetForNewCase();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT });
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

describe('<ConvergenceErrorPanel /> adjusted retries', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const PLAIN: PflowSettings = {
    tolerance: 1e-6,
    max_iterations: 25,
    flat_start: false,
    enforce_q_limits: false,
  };

  function converged(): Response {
    return new Response(
      JSON.stringify({
        run_id: 'run-2',
        converged: true,
        iterations: 6,
        mismatch: 1e-7,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  function failedRun(overrides: Partial<PflowResult> = {}): void {
    usePflowStore.setState({
      lastRun: makeNonConvergedResult({
        iterations: 26,
        mismatch: 0.4,
        settings: PLAIN,
        ...overrides,
      }),
      isRunning: false,
      error: null,
    });
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    fetchSpy.mockImplementation(() => Promise.resolve(converged()));
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    usePflowOptionsStore.getState().resetForNewCase();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('offers the retries that fit how the run ended, with a reason on each', () => {
    failedRun();
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    expect(screen.getByTestId('convergence-retry-more-iterations')).toHaveTextContent(
      'Retry with 50 iterations',
    );
    expect(screen.getByTestId('convergence-retry-flat-start')).toHaveAttribute(
      'title',
      expect.stringMatching(/1 pu at angle 0/),
    );
    // A mismatch of 0.4 is nowhere near the tolerance, and Q limits were off.
    expect(screen.queryByTestId('convergence-retry-looser-tolerance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('convergence-retry-no-q-limits')).not.toBeInTheDocument();
  });

  it('offers a looser tolerance when the mismatch is nearly there, and Q limits off when they were on', () => {
    failedRun({
      mismatch: 4e-6,
      settings: { ...PLAIN, enforce_q_limits: true },
    });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    expect(screen.getByTestId('convergence-retry-looser-tolerance')).toHaveTextContent(
      'Retry at tolerance 1e-5',
    );
    expect(screen.getByTestId('convergence-retry-no-q-limits')).toBeInTheDocument();
  });

  it('a retry writes its change into the options and runs the power flow with it', async () => {
    failedRun();
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('convergence-retry-more-iterations'));

    expect(usePflowOptionsStore.getState().options.maxIterations).toBe(50);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/sessions\/sess-1\/pflow$/);
    expect(JSON.parse(String(init.body))).toEqual({ max_iterations: 50 });
  });

  it('retrying twice builds on the first change', async () => {
    failedRun();
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('convergence-retry-more-iterations'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    // The run came back as failed again, now with the new limit; flat start is next.
    act(() => failedRun({ settings: { ...PLAIN, max_iterations: 50 }, iterations: 51 }));
    await userEvent.click(await screen.findByTestId('convergence-retry-flat-start'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ max_iterations: 50, flat_start: true });
  });

  it('turning Q limits off asks for them off, not for the case’s own', async () => {
    usePflowOptionsStore.getState().setOptions({ enforceQLimits: true });
    failedRun({ settings: { ...PLAIN, enforce_q_limits: true } });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('convergence-retry-no-q-limits'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ enforce_q_limits: false });
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(false);
  });

  it('turns off Q limits that the case itself turned on, with the form untouched', async () => {
    // The case file's own settings enforce the limits, so a request that says nothing
    // about them runs the same enforced power flow again: only an explicit "off"
    // changes the run.
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBeNull();
    failedRun({ settings: { ...PLAIN, enforce_q_limits: true } });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('convergence-retry-no-q-limits'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ enforce_q_limits: false });
  });

  it('points to the retry buttons below its details when there are some', async () => {
    failedRun();
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByRole('button', { name: /view details/i }));

    expect(screen.getByTestId('convergence-error-details')).toHaveTextContent(
      /Retry with one of the adjustments below/,
    );
  });

  it('does not point to adjustments when none applies', async () => {
    // A flat start was used and the run gave up early: nothing to retry with.
    failedRun({ iterations: 6, mismatch: 90, settings: { ...PLAIN, flat_start: true } });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });
    expect(screen.queryByTestId(/^convergence-retry-/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /view details/i }));

    const details = screen.getByTestId('convergence-error-details');
    expect(details).not.toHaveTextContent(/adjustments/);
    expect(details).toHaveTextContent(/Inspect bus voltages and adjust the case/);
  });

  it('works from a server that reports no settings, taking the options form at its word', () => {
    usePflowOptionsStore.getState().setOptions({ flatStart: true });
    usePflowStore.setState({
      lastRun: makeNonConvergedResult({ iterations: 26, mismatch: 0.4 }),
      isRunning: false,
      error: null,
    });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });
    expect(screen.getByTestId('convergence-retry-more-iterations')).toBeInTheDocument();
    // Flat start is already on in the form, so it is not offered again.
    expect(screen.queryByTestId('convergence-retry-flat-start')).not.toBeInTheDocument();
  });

  it('does not suggest more iterations to a run that gave up early', () => {
    failedRun({ iterations: 6, mismatch: 90 });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });
    expect(screen.queryByTestId('convergence-retry-more-iterations')).not.toBeInTheDocument();
    expect(screen.getByTestId('convergence-retry-flat-start')).toBeInTheDocument();
  });

  it('Adjust options opens the PF tab with the drawer open', async () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    failedRun();
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('convergence-adjust-options'));

    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('pf');
    expect(layout.bottomDrawerCollapsed).toBe(false);
  });

  it('lists the settings the run used among its details', async () => {
    failedRun({ settings: { ...PLAIN, flat_start: true } });
    const { Wrapper } = makeWrapper();
    render(<ConvergenceErrorPanel />, { wrapper: Wrapper });

    await userEvent.click(screen.getByRole('button', { name: /view details/i }));

    expect(screen.getByText('settings')).toBeInTheDocument();
    expect(screen.getByText('tolerance 1e-6, up to 25 iterations, flat start')).toBeInTheDocument();
  });
});
