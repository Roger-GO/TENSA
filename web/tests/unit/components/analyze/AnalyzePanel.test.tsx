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
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyzePanel } from '@/components/analyze/AnalyzePanel';
import { ANALYZE_SUB_MODES, DEFAULT_EIG_FILTER, useAnalyzeStore } from '@/store/analyze';
import { DEFAULT_TDS_CONFIG, useUiStore } from '@/store/ui';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useSweepStore } from '@/store/sweep';
import { useRunModeStore } from '@/store/runMode';
import { useRunsStore } from '@/store/runs';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { EigResult, PflowResult } from '@/api/types';

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function resetStores() {
  usePflowOptionsStore.getState().resetForNewCase();
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
  // case + session + sweep slices. Seed them to a "happy path"
  // baseline so the per-sub-mode disabled-reason tests start from a
  // clean state.
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
      fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
        typeof vi.spyOn
      >;
      // Seed a converged PF so the Run-readiness gate enables the button —
      // the 409 we inject simulates the substrate disagreeing post-click.
      usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
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

    it('a CPF run refused for the power flow is no longer shown once the power flow is solved again', async () => {
      respondWith(409, {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail:
          'The power flow this continuation starts from leaves 2 generators past a reactive limit.',
        recovery: { kind: 'run-pflow', label: 'Run power flow first' },
      });
      useAnalyzeStore.getState().setSubMode('cpf');

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-run-cpf'));
      expect(await screen.findByTestId('cpf-prerequisite-error')).toHaveTextContent(
        'past a reactive limit',
      );

      // The user does what it says: the power flow is solved again.
      act(() => {
        usePflowStore.getState().setLastRun({ ...FAKE_PFLOW_RESULT, run_id: 'pf-2' } as never);
      });
      expect(screen.queryByTestId('cpf-prerequisite-error')).not.toBeInTheDocument();
    });

    it('a CPF error that a power flow does not answer stays', async () => {
      respondWith(422, {
        type: 'about:blank',
        title: 'Unprocessable',
        status: 422,
        detail: "load_increase names 'PQ_99', which is not a PQ load",
      });
      useAnalyzeStore.getState().setSubMode('cpf');

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-run-cpf'));
      expect(await screen.findByTestId('cpf-error')).toHaveTextContent('not a PQ load');

      act(() => {
        usePflowStore.getState().setLastRun({ ...FAKE_PFLOW_RESULT, run_id: 'pf-2' } as never);
      });
      expect(screen.getByTestId('cpf-error')).toBeInTheDocument();
    });

    it('Run CPF sends the form and the Q-limit switch it shares with the power flow', async () => {
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      const topology = {
        state: 'committed',
        buses: [],
        lines: [],
        transformers: [],
        generators: [{ idx: 2, name: 'G2', kind: 'PV', params: { bus: 2 } }],
        loads: [{ idx: 'PQ_1', name: 'Load A', kind: 'PQ', params: { bus: 4 } }],
      };
      const cpfResult = {
        lambdas: [0, 0.5],
        voltages_per_bus: { '1': [1, 0.9] },
        bus_idxes: ['1'],
        nose_idx: 1,
        max_lam: 0.5,
        truncated: false,
        done_msg: 'Nose point at lambda=0.500000',
        mode: 'pv',
        direction: 'load-only',
        stop_at: 'full',
        complete: true,
        q_limits_enforced: true,
        generators: [{ idx: '1', model: 'Slack', bus: '1', q: [5, 9], q_min: -50, q_max: 100 }],
        limit_events: [],
      };
      fetchSpy.mockImplementation((...args: unknown[]) =>
        Promise.resolve(json(String(args[0]).endsWith('/topology') ? topology : cpfResult)),
      );
      useAnalyzeStore.getState().setSubMode('cpf');

      render(withQueryClient(<AnalyzePanel />));
      // The devices of a custom direction come from the case.
      await userEvent.click(screen.getByTestId('cpf-config-direction-custom'));
      expect(await screen.findByTestId('cpf-direction-load-PQ_1-p')).toBeInTheDocument();
      expect(screen.getByTestId('cpf-direction-gen-2-p')).toBeInTheDocument();
      // The box in the CPF form is the power-flow option.
      await userEvent.click(screen.getByTestId('cpf-config-enforce-q-limits'));
      expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(true);
      await userEvent.click(screen.getByTestId('cpf-config-direction-load-only'));
      await userEvent.click(screen.getByTestId('cpf-config-lower-branch'));
      await userEvent.click(screen.getByTestId('analyze-run-cpf'));

      await screen.findByTestId('cpf-generators');
      const posted = fetchSpy.mock.calls.find(
        ([url, init]) => String(url).endsWith('/cpf') && (init as RequestInit).method === 'POST',
      );
      expect(posted).toBeDefined();
      expect(JSON.parse(String((posted![1] as RequestInit).body))).toEqual({
        direction: 'load-only',
        enforce_q_limits: true,
        stop_at: 'full',
      });
      // What the generators did is under the curve.
      expect(screen.getByTestId('cpf-generators-summary')).toHaveTextContent(
        'Q limits were enforced and no generator reached one.',
      );
      expect(screen.getByTestId('cpf-run-caption')).toHaveTextContent('Loads only');
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
      const cta = screen.getByRole('button', { name: /run power flow/i });
      await userEvent.click(cta);
      await waitFor(() => expect(useAnalyzeStore.getState().subMode).toBe('pflow'));
      // The CTA does what it says: it starts a power flow rather than only
      // moving the user to the PF view.
      await waitFor(() =>
        expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/pflow'))).toBe(true),
      );
    });
  });

  // ---- Unit 14: SE noise_seed pass-through + inline validation ---------

  describe('SE noise_seed (Unit 14)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
        typeof vi.spyOn
      >;
      // Converged PF so the Generate Measurements button is enabled.
      usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
      useAnalyzeStore.getState().setSubMode('se');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
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

// ---- visible run-readiness notes ----------------------------------------
//
// A disabled Run button used to explain itself only in a hover tooltip, so a
// first-time user (or anyone on a keyboard or a screen reader) saw a greyed-out
// button and no reason. The same reason now sits under the button as text, with
// the recovery next to it.

describe('<AnalyzePanel /> run-readiness notes', () => {
  beforeEach(() => {
    resetStores();
  });
  afterEach(() => {
    resetStores();
  });

  it('EIG: shows why Run EIG is off without a hover, and the button is described by it', () => {
    useAnalyzeStore.getState().setSubMode('eig');
    render(withQueryClient(<AnalyzePanel />));
    const note = screen.getByTestId('analyze-run-eig-hint');
    expect(note).toHaveTextContent('Run PFlow first; EIG requires a converged operating point.');
    expect(screen.getByTestId('analyze-run-eig')).toHaveAttribute(
      'aria-describedby',
      'analyze-run-eig-hint',
    );
    expect(note.id).toBe('analyze-run-eig-hint');
    expect(screen.getByRole('button', { name: 'Run power flow' })).toBeInTheDocument();
  });

  it('EIG: the Run power flow action starts a power flow', async () => {
    const fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'nope' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    try {
      useAnalyzeStore.getState().setSubMode('eig');
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-run-eig-hint-action'));
      await waitFor(() =>
        expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/pflow'))).toBe(true),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('EIG: the note goes away once a converged power flow exists', () => {
    useAnalyzeStore.getState().setSubMode('eig');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.queryByTestId('analyze-run-eig-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('analyze-run-eig')).not.toHaveAttribute('aria-describedby');
  });

  it('EIG: on a static-only case the note says the case needs dynamic models, with no action', () => {
    useCaseStore.setState({
      topology: {
        state: 'pre-setup',
        buses: [],
        lines: [],
        transformers: [],
        generators: [{ idx: '1', name: 'slack', kind: 'Slack', params: {} }],
        loads: [],
        controllers: [],
      },
    });
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useAnalyzeStore.getState().setSubMode('eig');
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-run-eig-hint')).toHaveTextContent(
      /requires dynamic-model data/i,
    );
    expect(screen.queryByTestId('analyze-run-eig-hint-action')).not.toBeInTheDocument();
  });

  it('CPF: shows the reason under the Run CPF button', () => {
    useAnalyzeStore.getState().setSubMode('cpf');
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-run-cpf-hint')).toHaveTextContent(
      'Run PFlow first; CPF requires a converged operating point.',
    );
    expect(screen.getByTestId('analyze-run-cpf')).toHaveAttribute(
      'aria-describedby',
      'analyze-run-cpf-hint',
    );
  });

  it('SE: before a power flow, the note gives the PF reason and both buttons point at it', () => {
    useAnalyzeStore.getState().setSubMode('se');
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-se-run-hint')).toHaveTextContent(
      'Run PFlow first; SE requires a converged operating point.',
    );
    expect(screen.getByTestId('analyze-se-run')).toHaveAttribute(
      'aria-describedby',
      'analyze-se-run-hint',
    );
    expect(screen.getByTestId('analyze-se-generate-measurements')).toHaveAttribute(
      'aria-describedby',
      'analyze-se-run-hint',
    );
  });

  it('SE: after a power flow, the note spells out the Generate Measurements step', () => {
    useAnalyzeStore.getState().setSubMode('se');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<AnalyzePanel />));
    const note = screen.getByTestId('analyze-se-run-hint');
    expect(note).toHaveTextContent('Generate measurements first.');
    expect(note).toHaveTextContent(/no measurement file is required/i);
    expect(note).toHaveTextContent(/then click Run SE/i);
    // Generate is the enabled next step; Run SE waits for it.
    expect(screen.getByTestId('analyze-se-generate-measurements')).toBeEnabled();
    expect(screen.getByTestId('analyze-se-run')).toBeDisabled();
    expect(screen.queryByTestId('analyze-se-run-hint-action')).not.toBeInTheDocument();
  });

  it('SE: the note is gone once measurements exist', () => {
    useAnalyzeStore.getState().setSubMode('se');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useAnalyzeStore.setState({ seMeasurementsCount: 30 });
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.queryByTestId('analyze-se-run-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('analyze-se-run')).toBeEnabled();
  });

  it('after a TDS run the note offers Reset run, not Run power flow', () => {
    useAnalyzeStore.getState().setSubMode('eig');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useRunsStore.setState({ activeRunId: 'run-1' });
    try {
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('analyze-run-eig-hint')).toHaveTextContent(/Reset the run first/i);
      expect(screen.getByRole('button', { name: 'Reset run' })).toBeInTheDocument();
    } finally {
      useRunsStore.setState({ activeRunId: null });
    }
  });
});
