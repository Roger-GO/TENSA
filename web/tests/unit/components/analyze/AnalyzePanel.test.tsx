/**
 * Tests for ``<AnalyzePanel />`` (Unit 6).
 *
 * The panel composes the AnalyzeSubModePicker plus the per-routine
 * sub-mode body. We test the routing layer (sub-mode swap → which
 * subtree mounts) plus the EIG sub-mode's "Run EIG" button gating
 * and the tds-initialized info banner; deeper EIG result-view
 * behaviour is covered by EIGScatter.test / EIGParticipationTable.test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyzePanel } from '@/components/analyze/AnalyzePanel';
import { ANALYZE_SUB_MODES, DEFAULT_EIG_FILTER, useAnalyzeStore } from '@/store/analyze';
import { DEFAULT_TDS_CONFIG, useUiStore } from '@/store/ui';
import { usePflowStore } from '@/store/pflow';
import { useAuthStore } from '@/store/auth';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useSweepStore } from '@/store/sweep';
import { useRunModeStore } from '@/store/runMode';
import { setTokenGetter } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { EigResult, PflowResult } from '@/api/types';

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function resetStores() {
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
    cpfResult: null,
    seResult: null,
    seMeasurementsCount: null,
  });
  useUiStore.setState({
    hideLabels: false,
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
  });
  usePflowStore.setState({
    lastRun: null,
    isRunning: false,
    error: null,
  });
  // The Run-readiness hook (Unit 4 of the v2.0 polish plan) reads
  // case + session + auth + sweep slices. Seed all four to a "happy
  // path" baseline so the per-sub-mode disabled-reason tests start
  // from a clean state.
  useAuthStore.setState({ token: 'test-token', persistFailed: false });
  useSessionStore.setState({
    sessionId: parseSessionId('sess-1'),
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
  });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
}

const FAKE_PFLOW_RESULT: PflowResult = {
  // The narrow shape we need — the EIG sub-mode only checks
  // ``lastRun !== null`` to gate the auto-clear behaviour.
  run_id: 'pf-1',
  converged: true,
  iterations: 4,
  mismatch: 1e-6,
  bus_voltages: {},
  bus_angles: {},
  line_flows: {},
  generator_outputs: {},
  load_consumption: {},
};

const RESULT_WITH_TDS_INIT: EigResult = {
  eigenvalues: [{ real: -0.1, imag: 1.0 }],
  damping_ratios: [0.1],
  frequencies_hz: [0.159],
  mode_count: 1,
  state_count: 1,
  state_names: ['delta_1'],
  tds_initialized: true,
};

describe('<AnalyzePanel />', () => {
  beforeEach(() => {
    resetStores();
  });
  afterEach(() => {
    resetStores();
  });

  it('renders the panel header + sub-mode picker', () => {
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-panel')).toBeInTheDocument();
    expect(screen.getByTestId('analyze-sub-mode-picker')).toBeInTheDocument();
    for (const mode of ANALYZE_SUB_MODES) {
      expect(screen.getByTestId(`analyze-sub-mode-${mode}`)).toBeInTheDocument();
    }
  });

  it('PF sub-mode is active by default and shows the PF placeholder', () => {
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-sub-mode-pflow')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('analyze-sub-mode-pflow-content')).toBeInTheDocument();
  });

  it('clicking the TDS sub-mode mounts TdsConfigPanel', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<AnalyzePanel />));
    await user.click(screen.getByTestId('analyze-sub-mode-tds'));
    expect(useAnalyzeStore.getState().subMode).toBe('tds');
    expect(screen.getByTestId('tds-config-panel')).toBeInTheDocument();
  });

  it('clicking the EIG sub-mode mounts the EIG views + Run button', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<AnalyzePanel />));
    await user.click(screen.getByTestId('analyze-sub-mode-eig'));
    expect(useAnalyzeStore.getState().subMode).toBe('eig');
    expect(screen.getByTestId('analyze-run-eig')).toBeInTheDocument();
    // Empty-state shown until EIG runs.
    expect(screen.getByTestId('eig-empty')).toBeInTheDocument();
  });

  it('shows the tds-initialized info banner when EIG result has tds_initialized=true', () => {
    // Seed PF (the EIG sub-mode auto-clears the EIG result if PF is
    // null, since a case-change would have wiped PF first).
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useAnalyzeStore.getState().setSubMode('eig');
    useAnalyzeStore.getState().setEigResult(RESULT_WITH_TDS_INIT);
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('eig-info-tds-initialized')).toBeInTheDocument();
  });

  it('does NOT auto-run EIG on tab open (gated until user clicks Run EIG)', () => {
    useAnalyzeStore.getState().setSubMode('eig');
    render(withQueryClient(<AnalyzePanel />));
    // No result, no info banner, no participation table populated.
    expect(useAnalyzeStore.getState().eigResult).toBeNull();
    expect(screen.queryByTestId('eig-info-tds-initialized')).not.toBeInTheDocument();
  });

  // ---- Run-readiness gates (v2.0 polish, Unit 4) -----------------------

  it('Run EIG is disabled with "Run PFlow first" tooltip when no PF result is present', async () => {
    useAnalyzeStore.getState().setSubMode('eig');
    // Baseline already has no PF result.
    render(withQueryClient(<AnalyzePanel />));
    const button = screen.getByTestId('analyze-run-eig');
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(
      /Run PFlow first; EIG requires a converged operating point/i,
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('Run CPF is disabled with the CPF-specific "Run PFlow first" tooltip', async () => {
    useAnalyzeStore.getState().setSubMode('cpf');
    render(withQueryClient(<AnalyzePanel />));
    const button = screen.getByTestId('analyze-run-cpf');
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(
      /Run PFlow first; CPF requires a converged operating point/i,
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('Run SE is disabled with "Generate measurements first." when PF is converged but no measurements', async () => {
    useAnalyzeStore.getState().setSubMode('se');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    // measurement count stays null.
    render(withQueryClient(<AnalyzePanel />));
    const button = screen.getByTestId('analyze-se-run');
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(/Generate measurements first/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('Run SE is disabled with "Run PFlow first" when PF has not run', async () => {
    useAnalyzeStore.getState().setSubMode('se');
    render(withQueryClient(<AnalyzePanel />));
    const button = screen.getByTestId('analyze-se-run');
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(
      /Run PFlow first; SE requires a converged operating point/i,
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('Generate Measurements is disabled with a "Run PFlow first" tooltip when PF has not run', async () => {
    // SE measurements derive from a converged operating point, so the
    // Generate button must surface the prerequisite BEFORE the click (it
    // used to enable in pre-setup and only 409 afterwards).
    useAnalyzeStore.getState().setSubMode('se');
    render(withQueryClient(<AnalyzePanel />));
    const button = screen.getByTestId('analyze-se-generate-measurements');
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(
      /Run PFlow first; SE requires a converged operating point/i,
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('Generate Measurements enables once PF is converged', () => {
    useAnalyzeStore.getState().setSubMode('se');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-se-generate-measurements')).toBeEnabled();
  });

  it('Run EIG enables when PF is converged', () => {
    useAnalyzeStore.getState().setSubMode('eig');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-run-eig')).toBeEnabled();
  });

  it('Run EIG / CPF / SE all show the sweep-in-progress tooltip when an active sweep is running', async () => {
    useAnalyzeStore.getState().setSubMode('eig');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useAnalyzeStore.setState({ seMeasurementsCount: 5 });
    useSweepStore.setState({
      activeSweepId: 'sweep-9',
      sweeps: {
        'sweep-9': {
          sweepId: 'sweep-9',
          parameterKind: 'disturbance.fault.tc',
          parameterTarget: 0,
          snapshotName: 'snap-A',
          total: 5,
          state: 'running',
          iterations: [],
          truncated: false,
          error: null,
          startedAt: 0,
        },
      },
    });

    render(withQueryClient(<AnalyzePanel />));
    const button = screen.getByTestId('analyze-run-eig');
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(/Sweep sweep-9 in progress/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  // ---- migrated routine-error surfaces (v3.1 Unit 9) -------------------
  //
  // The per-routine EIG / CPF / SE inline error banners are now thin
  // wrappers around the single ``<ProblemDetailsErrorSurface>`` primitive.
  // These tests assert the post-click error UI renders the SAME branches
  // (409 prerequisite vs generic 4xx/5xx) and the 409 recovery CTA routes
  // the user back to the PF view.

  describe('routine error surfaces', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      setTokenGetter(() => 'test-token');
      fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
        typeof vi.spyOn
      >;
      // Seed a converged PF so the Run-readiness gate enables the button —
      // the 409 we inject simulates the substrate disagreeing post-click.
      usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      setTokenGetter(() => null);
    });

    function respondWith(status: number, body: Record<string, unknown>) {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
    }

    it('EIG 409 prerequisite renders the warning banner + a "Run PFlow" recovery CTA wired to the PF view', async () => {
      respondWith(409, {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail: 'Run PFlow before EIG.',
        recovery: { kind: 'run-pflow', label: 'Open PF view' },
      });
      useAnalyzeStore.getState().setSubMode('eig');
      // Reset the run-mode store so the recovery routing is observable.
      useRunModeStore.setState({ activeRoutine: 'eig' });

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-run-eig'));

      // The migrated prerequisite surface renders via the primitive.
      const banner = await screen.findByTestId('eig-prerequisite-error');
      expect(banner).toBeInTheDocument();
      // The EXACT bespoke detail copy is preserved.
      expect(banner).toHaveTextContent('Run PFlow before EIG.');

      // The recovery CTA routes back to the PF view (sub-mode + run mode).
      const cta = screen.getByRole('button', { name: /open pf view/i });
      await userEvent.click(cta);
      expect(useAnalyzeStore.getState().subMode).toBe('pflow');
      expect(useRunModeStore.getState().activeRoutine).toBe('pflow');
    });

    it('EIG generic 5xx renders the danger error banner with the detail copy', async () => {
      respondWith(500, {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'eig solver crashed',
      });
      useAnalyzeStore.getState().setSubMode('eig');

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-run-eig'));

      const banner = await screen.findByTestId('eig-error');
      expect(banner).toHaveTextContent('eig solver crashed');
      // No prerequisite banner for a non-409 error.
      expect(screen.queryByTestId('eig-prerequisite-error')).not.toBeInTheDocument();
    });

    it('CPF 409 prerequisite renders the prerequisite banner with the run-pflow CTA', async () => {
      respondWith(409, {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail: 'Run PFlow before CPF.',
        recovery: { kind: 'run-pflow', label: 'Open PF view' },
      });
      useAnalyzeStore.getState().setSubMode('cpf');

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-run-cpf'));

      const banner = await screen.findByTestId('cpf-prerequisite-error');
      expect(banner).toHaveTextContent('Run PFlow before CPF.');
      expect(screen.getByRole('button', { name: /open pf view/i })).toBeInTheDocument();
    });

    it('SE 409 prerequisite renders the prerequisite banner with the run-pflow CTA', async () => {
      respondWith(409, {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail: 'Run PFlow before SE.',
        recovery: { kind: 'run-pflow', label: 'Open PF view' },
      });
      useAnalyzeStore.getState().setSubMode('se');
      // SE's run gate also needs a measurement count to enable the button.
      useAnalyzeStore.setState({ seMeasurementsCount: 5 });

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-se-run'));

      const banner = await screen.findByTestId('se-prerequisite-error');
      expect(banner).toHaveTextContent('Run PFlow before SE.');
      expect(screen.getByRole('button', { name: /open pf view/i })).toBeInTheDocument();
    });

    it('a 409 with NO recovery field still synthesises the run-pflow CTA (staged-rollout fallback)', async () => {
      respondWith(409, {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail: 'Run PFlow first.',
        // no `recovery` field — legacy body during the staged rollout.
      });
      useAnalyzeStore.getState().setSubMode('eig');

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-run-eig'));

      await screen.findByTestId('eig-prerequisite-error');
      const cta = screen.getByRole('button', { name: /open pf view/i });
      await userEvent.click(cta);
      await waitFor(() => expect(useAnalyzeStore.getState().subMode).toBe('pflow'));
    });
  });

  // ---- Unit 14: SE noise_seed pass-through + inline validation ---------

  describe('SE noise_seed (Unit 14)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      setTokenGetter(() => 'test-token');
      fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
        typeof vi.spyOn
      >;
      // Converged PF so the Generate Measurements button is enabled.
      usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
      useAnalyzeStore.getState().setSubMode('se');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      setTokenGetter(() => null);
    });

    it('forwards an integer noise_seed to the measurement-generate request', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ count: 28 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      render(withQueryClient(<AnalyzePanel />));

      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-noise-seed'), '42');
      await userEvent.click(screen.getByTestId('analyze-se-generate-measurements'));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const generateCall = fetchSpy.mock.calls.find((c) =>
        String(c[0]).includes('/se/measurements/generate'),
      );
      expect(generateCall).toBeDefined();
      const body = JSON.parse((generateCall![1] as RequestInit).body as string);
      expect(body.noise_seed).toBe(42);
    });

    it('omits noise_seed entirely when the input is left blank', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ count: 28 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      render(withQueryClient(<AnalyzePanel />));

      await userEvent.click(screen.getByTestId('analyze-se-generate-measurements'));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const generateCall = fetchSpy.mock.calls.find((c) =>
        String(c[0]).includes('/se/measurements/generate'),
      );
      expect(generateCall).toBeDefined();
      const body = JSON.parse((generateCall![1] as RequestInit).body as string);
      expect(body).not.toHaveProperty('noise_seed');
    });

    it('shows a form-level inline error and blocks generate for a non-integer seed', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ count: 28 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      render(withQueryClient(<AnalyzePanel />));

      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-noise-seed'), '1.5');
      expect(screen.getByTestId('error-se-noise-seed')).toBeInTheDocument();
      // The button is disabled while the seed is invalid.
      expect(screen.getByTestId('analyze-se-generate-measurements')).toBeDisabled();
      // No generate request fired.
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes('/se/measurements/generate')),
      ).toBe(false);
    });

    it('blocks generate for a negative seed (numpy default_rng rejects it)', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ count: 28 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      render(withQueryClient(<AnalyzePanel />));

      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-noise-seed'), '-5');
      expect(screen.getByTestId('error-se-noise-seed')).toBeInTheDocument();
      expect(screen.getByTestId('analyze-se-generate-measurements')).toBeDisabled();
      // No generate request fired — the bad seed is caught inline, not
      // surfaced as a misleading non-convergent error downstream.
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes('/se/measurements/generate')),
      ).toBe(false);
    });
  });
});
