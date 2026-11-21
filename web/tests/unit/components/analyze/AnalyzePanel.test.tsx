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
import type { MockInstance } from 'vitest';
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
import { useJobsStore } from '@/store/jobs';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { EigResult, PflowResult, SeResult } from '@/api/types';

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

  it('says in that banner what Reload case costs: nothing while no edit is unsaved', () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useAnalyzeStore.getState().setSubMode('eig');
    useAnalyzeStore.getState().setEigResult(RESULT_WITH_TDS_INIT);
    render(withQueryClient(<AnalyzePanel />));
    const banner = screen.getByTestId('eig-info-tds-initialized');
    expect(banner).toHaveTextContent('To run power flow again, reload the case first');
    expect(banner).toHaveTextContent(
      'The reload loses none of your edits (there are none unsaved); it clears the power flow result and these eigenvalues.',
    );
  });

  it('says in that banner which edits Reload case would lose, while it would lose some', () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useAnalyzeStore.getState().setSubMode('eig');
    useAnalyzeStore.getState().setEigResult(RESULT_WITH_TDS_INIT);
    // An element was changed since the case file was opened, and not saved.
    const before = useCaseStore.getState();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      topology: {
        state: 'committed',
        buses: [],
        lines: [],
        transformers: [],
        generators: [{ idx: 'G1', name: 'G1', kind: 'GENROU', params: {} }],
        loads: [],
        undo: { op: 'edit', model: 'PQ', idx: 'PQ_0', params: ['p0'], also: 0 },
      },
    });
    try {
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('eig-info-tds-initialized')).toHaveTextContent(
        'The reload reads the case from its file again: the elements you added, changed or deleted since it was opened are not saved yet and would be lost. Save the system first to keep them.',
      );
    } finally {
      useCaseStore.setState({ selection: before.selection, topology: before.topology });
    }
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

  it('the CPF form starts over when another case is opened', async () => {
    useAnalyzeStore.getState().setSubMode('cpf');
    render(withQueryClient(<AnalyzePanel />));
    await userEvent.click(screen.getByTestId('cpf-config-direction-gen'));
    await userEvent.click(screen.getByTestId('cpf-config-lower-branch'));
    expect(screen.getByTestId('cpf-config-direction-gen')).toBeChecked();

    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      });
    });
    expect(screen.getByTestId('cpf-config-direction-load')).toBeChecked();
    expect(screen.getByTestId('cpf-config-lower-branch')).not.toBeChecked();
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

  it('Run EIG says before the press that a power flow then needs Reload case', async () => {
    // The lock was only said after the run, in the banner.
    useAnalyzeStore.getState().setSubMode('eig');
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<AnalyzePanel />));
    const button = screen.getByTestId('analyze-run-eig');
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute(
      'aria-description',
      expect.stringMatching(
        /^After it, a power flow cannot run again until Reload case\. A reload reads the case from its file again/,
      ),
    );
    await userEvent.hover(button);
    const shown = await screen.findAllByText(/After it, a power flow cannot run again/);
    expect(shown.length).toBeGreaterThan(0);
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
    let fetchSpy: MockInstance<typeof fetch>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
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

    describe('a run asked for by a command', () => {
      // "Run eigenvalue analysis (EIG)" and its like in the Run menu and the
      // palette: the tab's own Run button starts the run, as by a click on it.
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      const posts = (path: string) =>
        fetchSpy.mock.calls.filter(
          ([url, init]) => String(url).endsWith(path) && (init as RequestInit)?.method === 'POST',
        );

      beforeEach(() => {
        useRunModeStore.setState({ runRequest: null });
        // A run that was started stays under way: what is checked is that it
        // was sent, not what the tab draws of its answer.
        fetchSpy.mockImplementation((...args: unknown[]) =>
          (args[1] as RequestInit | undefined)?.method === 'POST'
            ? new Promise<Response>(() => {})
            : Promise.resolve(
                json({ state: 'committed', buses: [], lines: [], generators: [], loads: [] }),
              ),
        );
      });

      it('runs EIG when it is asked for with the tab on screen', async () => {
        useAnalyzeStore.getState().setSubMode('eig');
        usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
        render(withQueryClient(<AnalyzePanel />));
        expect(posts('/eig')).toHaveLength(0);
        act(() => useRunModeStore.getState().requestRun('eig'));
        await waitFor(() => expect(posts('/eig')).toHaveLength(1));
        expect(useRunModeStore.getState().runRequest).toBeNull();
      });

      it('runs EIG when the tab comes on screen for the request', async () => {
        // The drawer was at its tabs when the command was chosen.
        usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
        useRunModeStore.getState().requestRun('eig');
        useAnalyzeStore.getState().setSubMode('eig');
        render(withQueryClient(<AnalyzePanel />));
        await waitFor(() => expect(posts('/eig')).toHaveLength(1));
      });

      it('does not run EIG without a converged power flow, and takes the request', () => {
        useAnalyzeStore.getState().setSubMode('eig');
        render(withQueryClient(<AnalyzePanel />));
        act(() => useRunModeStore.getState().requestRun('eig'));
        expect(posts('/eig')).toHaveLength(0);
        // Not left to start a run later, when the power flow is in.
        expect(useRunModeStore.getState().runRequest).toBeNull();
      });

      it('runs CPF from the form as it stands', async () => {
        useAnalyzeStore.getState().setSubMode('cpf');
        usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
        render(withQueryClient(<AnalyzePanel />));
        await userEvent.click(screen.getByTestId('cpf-config-direction-load-only'));
        act(() => useRunModeStore.getState().requestRun('cpf'));
        await waitFor(() => expect(posts('/cpf')).toHaveLength(1));
        expect(JSON.parse(String((posts('/cpf')[0]![1] as RequestInit).body))).toMatchObject({
          direction: 'load-only',
        });
      });

      it('runs SE once measurements were generated, and not before', async () => {
        useAnalyzeStore.getState().setSubMode('se');
        usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
        render(withQueryClient(<AnalyzePanel />));
        act(() => useRunModeStore.getState().requestRun('se'));
        expect(posts('/se')).toHaveLength(0);
        act(() => useAnalyzeStore.setState({ seMeasurementsCount: 12 }));
        act(() => useRunModeStore.getState().requestRun('se'));
        await waitFor(() => expect(posts('/se')).toHaveLength(1));
      });
    });

    it('a CPF that used up its steps says so by the Run button and runs again with more', async () => {
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
        generators: [],
        loads: [{ idx: 'PQ_1', name: 'Load A', kind: 'PQ', params: { bus: 4 } }],
      };
      // 500 steps along a small custom increase, and no nose yet.
      const cutShort = {
        lambdas: [0, 120, 247.2766],
        voltages_per_bus: { '1': [1, 0.99, 0.97] },
        bus_idxes: ['1'],
        nose_idx: -1,
        max_lam: 247.2766,
        truncated: true,
        done_msg: 'Reached max steps (500)',
        mode: 'pv',
        direction: 'custom',
        stop_at: 'nose',
        complete: false,
        q_limits_enforced: false,
        generators: [],
        limit_events: [],
      };
      const whole = {
        ...cutShort,
        lambdas: [0, 120, 274.4788, 274.39],
        voltages_per_bus: { '1': [1, 0.99, 0.93, 0.92] },
        nose_idx: 2,
        max_lam: 274.4788,
        truncated: false,
        done_msg: 'Nose point at lambda=274.478844',
        complete: true,
      };
      const posted: Record<string, unknown>[] = [];
      fetchSpy.mockImplementation((...args: unknown[]) => {
        const [url, init] = args as [unknown, RequestInit | undefined];
        if (String(url).endsWith('/topology')) return Promise.resolve(json(topology));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posted.push(body);
        return Promise.resolve(json(body.max_iter === undefined ? cutShort : whole));
      });
      useAnalyzeStore.getState().setSubMode('cpf');

      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('cpf-config-direction-custom'));
      await userEvent.type(await screen.findByTestId('cpf-direction-load-PQ_1-p'), '10');
      await userEvent.click(screen.getByTestId('analyze-run-cpf'));

      // The summary is in the Run button's row, and the note follows it.
      const summary = await screen.findByTestId('cpf-summary');
      expect(summary).toHaveTextContent('3 steps; max lambda = 247.2766');
      expect(summary.parentElement).toContainElement(screen.getByTestId('analyze-run-cpf'));
      expect(screen.getByTestId('cpf-step-limit-note')).toHaveTextContent(
        'The run used all of its 500 steps and stopped at λ = 247.2766, before it reached the nose.',
      );

      await userEvent.click(
        screen.getByRole('button', { name: 'Run again with up to 2000 steps' }),
      );
      await waitFor(() =>
        expect(screen.queryByTestId('cpf-step-limit-note')).not.toBeInTheDocument(),
      );
      // The same direction, with the limit raised, and the field shows it.
      expect(posted).toEqual([
        { direction: 'custom', load_increase: [{ idx: 'PQ_1', p: 10, q: 0 }] },
        { direction: 'custom', load_increase: [{ idx: 'PQ_1', p: 10, q: 0 }], max_iter: 2000 },
      ]);
      expect(screen.getByTestId('field-cpf-config-max-iter')).toHaveValue('2000');
      expect(screen.getByTestId('cpf-summary')).toHaveTextContent('max lambda = 274.4788');
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
    let fetchSpy: MockInstance<typeof fetch>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
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

  // ---- SE-2: estimator choice, run settings, chi-squared result -------

  describe('SE estimator and run settings (SE-2)', () => {
    let fetchSpy: MockInstance<typeof fetch>;

    const SE_RESULT: SeResult = {
      converged: true,
      iterations: 3,
      mismatch: 12.34,
      residuals: [0.1, -0.2, 0.05],
      measurement_count: 3,
      flagged_indices: [],
    };

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
      // Converged PF + measurements so Run SE is enabled.
      usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
      useAnalyzeStore.getState().setSubMode('se');
      useAnalyzeStore.setState({ seMeasurementsCount: 12 });
      // Each POST settles with a result at once: Run SE is disabled while a
      // run is under way, and a test that runs twice needs the button back.
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(SE_RESULT), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    const sePosts = () =>
      fetchSpy.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/se') && (init as RequestInit | undefined)?.method === 'POST',
      );
    const seBody = () => JSON.parse(String((sePosts().at(-1)![1] as RequestInit).body)) as unknown;

    it('sends only the session (an empty body) when nothing was changed', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({});
    });

    it('sends the estimator only when LAV is picked', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-algorithm-lav'));
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({ algorithm: 'lav' });

      await userEvent.click(screen.getByTestId('se-algorithm-wls'));
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(2));
      expect(seBody()).toEqual({});
    });

    it('shows the LAV iteration hint only while LAV is picked', async () => {
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.queryByTestId('se-lav-max-iter-hint')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('se-algorithm-lav'));
      expect(screen.getByTestId('se-lav-max-iter-hint')).toHaveTextContent(
        'LAV is for a measurement set that may hold a bad measurement: it weighs large residuals less than WLS does, so one bad value can pull the estimate less. It often needs more iterations; raise max_iter under Advanced if the run does not converge.',
      );
      expect(screen.getByRole('radiogroup', { name: 'SE estimator' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'LAV' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: 'WLS' })).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(screen.getByTestId('se-algorithm-wls'));
      expect(screen.queryByTestId('se-lav-max-iter-hint')).not.toBeInTheDocument();
    });

    it('sends tol as a number when one is typed', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-tol'), '1e-5');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({ tol: 1e-5 });
    });

    it('sends max_iter as a number when one is typed', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-max-iter'), '200');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({ max_iter: 200 });
    });

    it('sends noise_seed as a number when one is typed for the run', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-run-noise-seed'), '42');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({ noise_seed: 42 });
    });

    it('shows an inline error and does not run for a tol of 0 or of abc', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      const field = screen.getByTestId('field-se-tol');
      await userEvent.type(field, '0');
      const error = screen.getByTestId('error-se-tol');
      expect(error).toHaveTextContent('Enter a tolerance above 0, or leave blank.');
      expect(error).toHaveAttribute('role', 'alert');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);

      await userEvent.clear(field);
      await userEvent.type(field, 'abc');
      expect(screen.getByTestId('error-se-tol')).toHaveTextContent(
        'Enter a tolerance above 0, or leave blank.',
      );
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);
    });

    it('shows an inline error and does not run for a max_iter of 0 or of 1.5', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      const field = screen.getByTestId('field-se-max-iter');
      await userEvent.type(field, '0');
      expect(screen.getByTestId('error-se-max-iter')).toHaveTextContent(
        'Enter a whole number of at least 1, or leave blank.',
      );
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);

      await userEvent.clear(field);
      await userEvent.type(field, '1.5');
      expect(screen.getByTestId('error-se-max-iter')).toHaveTextContent(
        'Enter a whole number of at least 1, or leave blank.',
      );
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);
    });

    it('shows an inline error and does not run for a negative run seed', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-run-noise-seed'), '-1');
      expect(screen.getByTestId('error-se-run-noise-seed')).toHaveTextContent(
        'Enter a non-negative whole number (integer) seed, or leave blank.',
      );
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);
    });

    it('shows the chi-squared outcome of a failed test', () => {
      useAnalyzeStore.getState().setSeResult({
        ...SE_RESULT,
        chi_squared: { passed: false, J: 120.5, threshold: 50.0, dof: 15, confidence: 0.95 },
      });
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('se-chi-squared-verdict')).toHaveTextContent(
        'Bad-data test (chi-squared, 95% confidence): failed',
      );
      expect(screen.getByTestId('se-chi-squared-verdict')).toHaveClass('text-danger');
      expect(screen.getByTestId('se-chi-squared-meaning')).toHaveTextContent(
        'The residuals are larger than measurement noise alone explains at this confidence, so at least one measurement is suspect.',
      );
      expect(screen.getByTestId('se-chi-squared-numbers')).toHaveTextContent(
        'J = 121, threshold 50, 15 degrees of freedom',
      );
    });

    it('shows the chi-squared outcome of a passed test', () => {
      useAnalyzeStore.getState().setSeResult({
        ...SE_RESULT,
        chi_squared: { passed: true, J: 12.3456, threshold: 25.0, dof: 15, confidence: 0.95 },
      });
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('se-chi-squared-verdict')).toHaveTextContent(
        'Bad-data test (chi-squared, 95% confidence): passed',
      );
      expect(screen.getByTestId('se-chi-squared-verdict')).not.toHaveClass('text-danger');
      expect(screen.getByTestId('se-chi-squared-meaning')).toHaveTextContent(
        'No bad data detected at this confidence. That does not show every measurement is good.',
      );
      expect(screen.getByTestId('se-chi-squared-numbers')).toHaveTextContent(
        'J = 12.3, threshold 25, 15 degrees of freedom',
      );
      expect(screen.queryByTestId('se-chi-squared-none')).not.toBeInTheDocument();
    });

    it('takes the confidence of the test from the result', () => {
      useAnalyzeStore.getState().setSeResult({
        ...SE_RESULT,
        chi_squared: { passed: true, J: 12.3, threshold: 30.6, dof: 15, confidence: 0.99 },
      });
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('se-chi-squared-verdict')).toHaveTextContent(
        'Bad-data test (chi-squared, 99% confidence): passed',
      );
    });

    it('says nothing of a bad-data test before any run', () => {
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.queryByTestId('se-chi-squared')).not.toBeInTheDocument();
    });

    it('says there is no bad-data test when the result carries none (an LAV run)', () => {
      useAnalyzeStore.getState().setSeResult({
        ...SE_RESULT,
        algorithm: 'lav',
        chi_squared: null,
      });
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('se-chi-squared-none')).toHaveTextContent(
        'No bad-data test: it needs weighted least squares and more measurements than states.',
      );
      expect(screen.queryByTestId('se-chi-squared-verdict')).not.toBeInTheDocument();
    });

    it('drops the chi-squared block with the result when the power flow is cleared', () => {
      useAnalyzeStore.getState().setSeResult({
        ...SE_RESULT,
        chi_squared: { passed: true, J: 12.3, threshold: 50.0, dof: 15, confidence: 0.95 },
      });
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('se-chi-squared')).toBeInTheDocument();
      act(() => {
        usePflowStore.setState({ lastRun: null });
      });
      expect(screen.queryByTestId('se-chi-squared')).not.toBeInTheDocument();
    });

    it('sends the empty body it sent before, byte for byte', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect((sePosts()[0]![1] as RequestInit).body).toBe('{}');
    });

    it('sends every option at once, each under its name and type', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-algorithm-lav'));
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-tol'), ' 0.001 ');
      await userEvent.type(screen.getByTestId('field-se-max-iter'), '500');
      await userEvent.type(screen.getByTestId('field-se-run-noise-seed'), '0');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toStrictEqual({
        algorithm: 'lav',
        tol: 0.001,
        max_iter: 500,
        noise_seed: 0,
      });
    });

    it('keeps the two seeds apart: the run seed is not sent to Generate, nor the reverse', async () => {
      fetchSpy.mockImplementation((url) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(url).includes('/se/measurements/generate') ? { count: 12 } : SE_RESULT,
            ),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-run-noise-seed'), '42');
      await userEvent.click(screen.getByTestId('analyze-se-generate-measurements'));
      const generatePosts = () =>
        fetchSpy.mock.calls.filter(([url]) => String(url).includes('/se/measurements/generate'));
      await waitFor(() => expect(generatePosts()).toHaveLength(1));
      expect(JSON.parse(String((generatePosts()[0]![1] as RequestInit).body))).toEqual({});
      expect(screen.getByTestId('field-se-noise-seed')).toHaveValue('');

      await userEvent.clear(screen.getByTestId('field-se-run-noise-seed'));
      await userEvent.type(screen.getByTestId('field-se-noise-seed'), '7');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({});
      expect(screen.getByTestId('field-se-run-noise-seed')).toHaveValue('');
    });

    it('labels the run seed as this run only', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      expect(screen.getByLabelText('noise_seed for this run only (optional)')).toBe(
        screen.getByTestId('field-se-run-noise-seed'),
      );
      expect(screen.getByTestId('field-se-run-noise-seed')).toHaveAccessibleDescription(
        /for this run only.*Generate Measurements made/,
      );
    });

    it('keeps the options of a run on its job, for a retry', async () => {
      useJobsStore.setState({ jobs: {} });
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ title: 'Did not converge', status: 422 }), {
            status: 422,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        ),
      );
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-algorithm-lav'));
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-max-iter'), '400');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() =>
        expect(Object.values(useJobsStore.getState().jobs).map((j) => j.status)).toEqual([
          'failed',
        ]),
      );
      const [job] = Object.values(useJobsStore.getState().jobs);
      expect(job!.kind).toBe('se');
      expect(job!.request_summary).toEqual({ algorithm: 'lav', max_iter: 400 });
    });

    it('hides the bad-data test while a new run is under way', async () => {
      let answer: (r: Response) => void = () => {};
      fetchSpy.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      useAnalyzeStore.getState().setSeResult({
        ...SE_RESULT,
        chi_squared: { passed: true, J: 12.3, threshold: 25.0, dof: 15, confidence: 0.95 },
      });
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('se-chi-squared')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(screen.queryByTestId('se-chi-squared')).not.toBeInTheDocument();
      await act(async () => {
        answer(
          new Response(
            JSON.stringify({
              ...SE_RESULT,
              chi_squared: { passed: false, J: 99, threshold: 25.0, dof: 15, confidence: 0.95 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(screen.getByTestId('se-chi-squared-verdict')).toHaveTextContent('failed'),
      );
    });

    it('hides the bad-data test of the last result once a run fails', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ title: 'Did not converge', status: 422 }), {
            status: 422,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        ),
      );
      useAnalyzeStore.getState().setSeResult({
        ...SE_RESULT,
        chi_squared: { passed: true, J: 12.3, threshold: 25.0, dof: 15, confidence: 0.95 },
      });
      render(withQueryClient(<AnalyzePanel />));
      expect(screen.getByTestId('se-chi-squared')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      await waitFor(() => expect(screen.queryByTestId('se-chi-squared')).not.toBeInTheDocument());
    });

    it('hides the bad-data test once the options differ from the run that made it', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...SE_RESULT,
              algorithm: 'wls',
              chi_squared: { passed: true, J: 12.3, threshold: 25.0, dof: 15, confidence: 0.95 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(screen.getByTestId('se-chi-squared-verdict')).toBeInTheDocument());

      // Another estimator: the test shown would read as LAV's.
      await userEvent.click(screen.getByTestId('se-algorithm-lav'));
      expect(screen.queryByTestId('se-chi-squared')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('se-algorithm-wls'));
      expect(screen.getByTestId('se-chi-squared')).toBeInTheDocument();

      // Another setting, or one that is not valid yet.
      await userEvent.click(screen.getByTestId('se-advanced'));
      await userEvent.type(screen.getByTestId('field-se-max-iter'), '0');
      expect(screen.queryByTestId('se-chi-squared')).not.toBeInTheDocument();
      await userEvent.clear(screen.getByTestId('field-se-max-iter'));
      expect(screen.getByTestId('se-chi-squared')).toBeInTheDocument();
      await userEvent.type(screen.getByTestId('field-se-run-noise-seed'), '3');
      expect(screen.queryByTestId('se-chi-squared')).not.toBeInTheDocument();
    });

    it('refuses a fractional or negative seed and a negative max_iter for the run', async () => {
      render(withQueryClient(<AnalyzePanel />));
      await userEvent.click(screen.getByTestId('se-advanced'));
      const seed = screen.getByTestId('field-se-run-noise-seed');
      await userEvent.type(seed, '1.5');
      expect(screen.getByTestId('error-se-run-noise-seed')).toHaveAttribute('role', 'alert');
      expect(seed).toHaveAttribute('aria-invalid', 'true');
      expect(seed).toHaveAttribute('aria-describedby', 'se-run-noise-seed-error');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);

      await userEvent.clear(seed);
      const maxIter = screen.getByTestId('field-se-max-iter');
      await userEvent.type(maxIter, '-3');
      expect(screen.getByTestId('error-se-max-iter')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);

      await userEvent.clear(maxIter);
      const tol = screen.getByTestId('field-se-tol');
      await userEvent.type(tol, '-1e-4');
      expect(screen.getByTestId('error-se-tol')).toBeInTheDocument();
      expect(tol).toHaveAttribute('aria-describedby', 'se-tol-error');
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      expect(sePosts()).toHaveLength(0);

      // Blank again: nothing is set and the run goes.
      await userEvent.clear(tol);
      await userEvent.click(screen.getByTestId('analyze-se-run'));
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({});
    });

    it('runs from the Run menu with the options of the form, as a click does', async () => {
      render(withQueryClient(<AnalyzePanel />));
      useRunModeStore.setState({ runRequest: null });
      await userEvent.click(screen.getByTestId('se-algorithm-lav'));
      act(() => {
        useRunModeStore.getState().requestRun('se');
      });
      await waitFor(() => expect(sePosts()).toHaveLength(1));
      expect(seBody()).toEqual({ algorithm: 'lav' });
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
