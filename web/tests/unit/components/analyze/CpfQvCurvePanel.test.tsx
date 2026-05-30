/**
 * Tests for ``<CpfQvCurvePanel />`` (v3.1 Unit 13).
 *
 * The QV panel drives the EXISTING ``useCpfQvRun`` hook from a bus
 * picker + Run button and renders the QV-curve via the shared
 * ``CPFCurveChart``. We mock ``useCpfQvRun`` + ``useCurrentTopology``
 * (the bus picker's data source) so the tests stay synchronous. We
 * test:
 *
 * - the bus picker + Run wire to ``useCpfQvRun.mutate`` with the picked bus;
 * - a QV result renders the chart;
 * - a 409 result renders the run-pflow recovery banner with the CTA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProblemDetailsError } from '@/api/client';
import type { CpfResult, TopologySummary } from '@/api/types';

// ---- mocks ----------------------------------------------------------------

const mutate = vi.fn();
let mockMutationState: {
  mutate: typeof mutate;
  isPending: boolean;
  data: CpfResult | null;
  error: Error | null;
};

let mockTopology: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => mockTopology,
    useCpfQvRun: () => mockMutationState,
  };
});

import { CpfQvCurvePanel } from '@/components/analyze/CpfQvCurvePanel';
import { useSessionStore } from '@/store/session';
import { useAnalyzeStore } from '@/store/analyze';
import { useRunModeStore } from '@/store/runMode';
import { useAuthStore } from '@/store/auth';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { PflowResult } from '@/api/types';

const CONVERGED_PF: PflowResult = {
  run_id: 'pf-1',
  converged: true,
  iterations: 4,
  mismatch: 1e-6,
  bus_voltages: {},
  bus_angles: {},
  line_flows: {},
} as unknown as PflowResult;

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 5, name: 'Bus5', kind: 'Bus', params: {} },
    { idx: 6, name: 'Bus6', kind: 'Bus', params: {} },
  ],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
} as unknown as TopologySummary;

const QV_RESULT: CpfResult = {
  lambdas: [0, 1, 2],
  voltages_per_bus: { '5': [1.0, 0.95, 0.9] },
  bus_idxes: ['5'],
  nose_idx: 2,
  max_lam: 2,
  truncated: false,
  done_msg: 'Nose point at Q=2.0',
  mode: 'qv',
};

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  mutate.mockReset();
  mockTopology = TOPOLOGY;
  mockMutationState = { mutate, isPending: false, data: null, error: null };
  useSessionStore.setState({
    sessionId: parseSessionId('sess-1'),
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
  });
  useAnalyzeStore.setState({ subMode: 'cpf', activeCpfSubMode: 'qv' });
  useRunModeStore.setState({ activeRoutine: 'cpf' });
  // CPF (incl. its QV mode) is PF-dependent. Seed the readiness inputs to a
  // happy-path baseline (case + auth + converged PF) so the Run button is
  // gated only by the bus picker; individual tests override as needed.
  useAuthStore.setState({ token: 'test-token', persistFailed: false });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    topology: null,
  });
  usePflowStore.setState({ lastRun: CONVERGED_PF, isRunning: false, error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<CpfQvCurvePanel />', () => {
  it('renders the bus picker + Run button', () => {
    render(withQueryClient(<CpfQvCurvePanel />));
    expect(screen.getByTestId('cpf-qv-panel')).toBeInTheDocument();
    expect(screen.getByTestId('bus-idx-select')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-qv-run')).toBeInTheDocument();
  });

  it('disables Run until a bus is picked, then drives useCpfQvRun.mutate with the bus', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<CpfQvCurvePanel />));

    // No bus picked → Run disabled.
    expect(screen.getByTestId('cpf-qv-run')).toBeDisabled();

    await user.selectOptions(screen.getByTestId('bus-idx-select'), '5');
    const runButton = screen.getByTestId('cpf-qv-run');
    expect(runButton).toBeEnabled();

    await user.click(runButton);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      sessionId: parseSessionId('sess-1'),
      busIdx: '5',
    });
  });

  it('disables Run with a "Run PFlow first" tooltip when PF has not converged', async () => {
    // No converged PF → CPF (and QV) is gated; the user should see the
    // prerequisite BEFORE clicking, not only as a post-click 409.
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    const user = userEvent.setup();
    render(withQueryClient(<CpfQvCurvePanel />));

    await user.selectOptions(screen.getByTestId('bus-idx-select'), '5');
    const runButton = screen.getByTestId('cpf-qv-run');
    expect(runButton).toBeDisabled();

    await user.hover(runButton.parentElement!);
    expect(await screen.findByTestId('cpf-qv-run-disabled-reason')).toHaveTextContent(
      /Run PFlow first/i,
    );
  });

  it('renders the QV chart for a result', () => {
    mockMutationState = { mutate, isPending: false, data: QV_RESULT, error: null };
    render(withQueryClient(<CpfQvCurvePanel />));
    const chart = screen.getByTestId('cpf-curve');
    expect(chart).toBeInTheDocument();
    expect(chart).toHaveAttribute('data-mode', 'qv');
    // The single requested bus's polyline renders.
    expect(screen.getByTestId('cpf-curve-line-5')).toBeInTheDocument();
  });

  it('a 409 (no converged PF) renders the run-pflow recovery banner with the CTA', async () => {
    const error = new ProblemDetailsError(
      {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail: 'Run PFlow before CPF.',
      },
      {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail: 'Run PFlow before CPF.',
        recovery: { kind: 'run-pflow', label: 'Open PF view' },
      },
    );
    mockMutationState = { mutate, isPending: false, data: null, error };

    render(withQueryClient(<CpfQvCurvePanel />));

    const banner = screen.getByTestId('cpf-qv-prerequisite-error');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Run PFlow before CPF.');

    // The recovery CTA routes the user back to the PF view.
    const cta = screen.getByRole('button', { name: /open pf view/i });
    await userEvent.click(cta);
    expect(useAnalyzeStore.getState().subMode).toBe('pflow');
    expect(useRunModeStore.getState().activeRoutine).toBe('pflow');
  });

  it('a generic (500) error renders the danger error banner', () => {
    const error = new ProblemDetailsError({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'qv solver crashed',
    });
    mockMutationState = { mutate, isPending: false, data: null, error };

    render(withQueryClient(<CpfQvCurvePanel />));
    expect(screen.getByTestId('cpf-qv-error')).toHaveTextContent('qv solver crashed');
    expect(screen.queryByTestId('cpf-qv-prerequisite-error')).not.toBeInTheDocument();
  });
});
