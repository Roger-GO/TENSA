/**
 * Tests for ``useRunReadiness`` (Unit 4 of the v2.0 polish plan).
 *
 * The hook's contract is the reasons map documented at the top of
 * ``src/lib/useRunReadiness.ts``. Each test seeds a single combination
 * of stores and asserts the matching reason / recovery shape.
 *
 * We use ``renderHook`` from React Testing Library to drive the hook
 * inside a real React tree (Zustand selectors are subscription-based
 * and need a reactive context). Stores are reset between tests so the
 * cascade in ``store/index.ts`` doesn't leak state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TopologySummary } from '@/api/types';

// Unit 24's dynamic-content gate reads `case.topology` (the store mirror of
// the topology query). Seed it via the store; null = still loading.
const TOPOLOGY_WITH_CONTROLLER: TopologySummary = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [{ idx: 'GENROU_1', name: 'g', kind: 'GENROU', params: {} }],
  loads: [],
  controllers: [{ idx: 'TGOV1_1', name: 't', kind: 'TGOV1', params: { syn: 'GENROU_1' } }],
};
const TOPOLOGY_STATIC_ONLY: TopologySummary = { ...TOPOLOGY_WITH_CONTROLLER, controllers: [] };

import { useRunReadiness, type RunRoutine } from '@/lib/useRunReadiness';
import { useAnalyzeStore, DEFAULT_EIG_FILTER } from '@/store/analyze';
import { useAuthStore } from '@/store/auth';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { useSweepStore } from '@/store/sweep';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { EigResult, PflowResult } from '@/api/types';

const ALL_ROUTINES: RunRoutine[] = ['pflow', 'tds', 'eig', 'cpf', 'se', 'sweep'];

function resetStores(): void {
  useAuthStore.setState({ token: null, persistFailed: false });
  useSessionStore.setState({
    sessionId: null,
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
  });
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
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
    cpfResult: null,
    seResult: null,
    seMeasurementsCount: null,
  });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
}

/** Seed a happy-path "case loaded + session live + token paste" baseline. */
function seedReadyBaseline(): void {
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
}

const FAKE_PFLOW_OK: PflowResult = {
  run_id: 'pf-1',
  converged: true,
  iterations: 4,
  mismatch: 1e-7,
  bus_voltages: {},
  bus_angles: {},
  line_flows: {},
  generator_outputs: {},
  load_consumption: {},
};

const FAKE_PFLOW_BAD: PflowResult = {
  ...FAKE_PFLOW_OK,
  converged: false,
};

const EIG_AFTER_RUN: EigResult = {
  eigenvalues: [{ real: -0.1, imag: 1.0 }],
  damping_ratios: [0.1],
  frequencies_hz: [0.159],
  mode_count: 1,
  state_count: 1,
  state_names: ['delta_1'],
  tds_initialized: true,
};

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

describe('useRunReadiness — no case loaded', () => {
  it.each(ALL_ROUTINES)(
    '%s: returns disabledReason "No case loaded." with no recovery',
    (routine) => {
      const { result } = renderHook(() => useRunReadiness(routine));
      expect(result.current.ready).toBe(false);
      expect(result.current.disabledReason).toBe('No case loaded.');
      expect(result.current.recovery).toBeNull();
    },
  );
});

describe('useRunReadiness — dynamic-content gate (R18, Unit 24)', () => {
  it.each(['tds', 'eig'] as RunRoutine[])(
    '%s: blocked on a static-only case with the dynamic-content reason',
    (routine) => {
      seedReadyBaseline();
      useAuthStore.setState({ token: 'test-token', persistFailed: false });
      useSessionStore.setState({
        sessionId: parseSessionId('sess-1'),
        recoveryInProgress: false,
        recoveryFailed: false,
        recoveryAttempts: [],
      });
      usePflowStore.setState({ lastRun: FAKE_PFLOW_OK, isRunning: false, error: null });
      useCaseStore.setState({ topology: TOPOLOGY_STATIC_ONLY });
      const { result } = renderHook(() => useRunReadiness(routine));
      expect(result.current.ready).toBe(false);
      expect(result.current.disabledReason).toMatch(/requires dynamic-model data/i);
    },
  );

  it.each(['cpf', 'se'] as RunRoutine[])(
    '%s: NOT gated by dynamic content (static analysis)',
    (routine) => {
      seedReadyBaseline();
      useAuthStore.setState({ token: 'test-token', persistFailed: false });
      useSessionStore.setState({
        sessionId: parseSessionId('sess-1'),
        recoveryInProgress: false,
        recoveryFailed: false,
        recoveryAttempts: [],
      });
      usePflowStore.setState({ lastRun: FAKE_PFLOW_OK, isRunning: false, error: null });
      useAnalyzeStore.setState({ seMeasurementsCount: 5 });
      useCaseStore.setState({ topology: TOPOLOGY_STATIC_ONLY });
      const { result } = renderHook(() => useRunReadiness(routine));
      // With PF converged + (for SE) measurements, a static-only case is ready
      // — the dynamic-content reason must never appear for these routines.
      expect(result.current.disabledReason ?? '').not.toMatch(/requires dynamic-model data/i);
    },
  );

  it('tds: ready on a dynamic case (controllers present)', () => {
    seedReadyBaseline();
    useAuthStore.setState({ token: 'test-token', persistFailed: false });
    useSessionStore.setState({
      sessionId: parseSessionId('sess-1'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    useCaseStore.setState({ topology: TOPOLOGY_WITH_CONTROLLER });
    const { result } = renderHook(() => useRunReadiness('tds'));
    expect(result.current.ready).toBe(true);
  });

  it('tds: not flicker-disabled while the topology is still loading (null)', () => {
    seedReadyBaseline();
    useAuthStore.setState({ token: 'test-token', persistFailed: false });
    useSessionStore.setState({
      sessionId: parseSessionId('sess-1'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    useCaseStore.setState({ topology: null });
    const { result } = renderHook(() => useRunReadiness('tds'));
    expect(result.current.disabledReason ?? '').not.toMatch(/requires dynamic-model data/i);
  });
});

describe('useRunReadiness — no session', () => {
  it('all routines return "Connecting to substrate…" when sessionId is null but case is loaded', () => {
    useAuthStore.setState({ token: 't', persistFailed: false });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      dragOverrides: {},
      pendingDependents: [],
    });
    for (const routine of ALL_ROUTINES) {
      const { result } = renderHook(() => useRunReadiness(routine));
      expect(result.current.ready).toBe(false);
      expect(result.current.disabledReason).toBe('Connecting to substrate…');
    }
  });
});

describe('useRunReadiness — no auth token', () => {
  it('all routines return "Sign in to run." when token is null', () => {
    useSessionStore.setState({
      sessionId: parseSessionId('sess-1'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      dragOverrides: {},
      pendingDependents: [],
    });
    for (const routine of ALL_ROUTINES) {
      const { result } = renderHook(() => useRunReadiness(routine));
      expect(result.current.ready).toBe(false);
      expect(result.current.disabledReason).toBe('Sign in to run.');
    }
  });
});

describe('useRunReadiness — happy path (PF converged)', () => {
  beforeEach(() => {
    seedReadyBaseline();
    usePflowStore.setState({ lastRun: FAKE_PFLOW_OK, isRunning: false, error: null });
    useAnalyzeStore.setState({ seMeasurementsCount: 5 });
  });

  it.each(ALL_ROUTINES)('%s is ready with no disabledReason and no recovery', (routine) => {
    const { result } = renderHook(() => useRunReadiness(routine));
    expect(result.current.ready).toBe(true);
    expect(result.current.disabledReason).toBeNull();
    expect(result.current.recovery).toBeNull();
  });
});

describe('useRunReadiness — PF prerequisite (pre-PF)', () => {
  beforeEach(() => {
    seedReadyBaseline();
    // No PF run yet.
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  it.each<RunRoutine>(['eig', 'cpf', 'se'])(
    '%s returns the PF-required reason and an open-pf recovery',
    (routine) => {
      const { result } = renderHook(() => useRunReadiness(routine));
      expect(result.current.ready).toBe(false);
      expect(result.current.disabledReason).toMatch(/Run PFlow first/);
      expect(result.current.disabledReason).toMatch(/requires a converged operating point/);
      expect(result.current.recovery).toEqual({
        kind: 'open-pf',
        label: 'Open PF view',
      });
    },
  );

  it('the routine name appears in the reason text (EIG)', () => {
    const { result } = renderHook(() => useRunReadiness('eig'));
    expect(result.current.disabledReason).toContain('EIG');
  });

  it('the routine name appears in the reason text (CPF)', () => {
    const { result } = renderHook(() => useRunReadiness('cpf'));
    expect(result.current.disabledReason).toContain('CPF');
  });

  it('the routine name appears in the reason text (SE)', () => {
    const { result } = renderHook(() => useRunReadiness('se'));
    expect(result.current.disabledReason).toContain('SE');
  });

  it('non-converged PF (200 + converged=false) is treated as "no PF"', () => {
    usePflowStore.setState({
      lastRun: FAKE_PFLOW_BAD,
      isRunning: false,
      error: null,
    });
    const { result } = renderHook(() => useRunReadiness('eig'));
    expect(result.current.ready).toBe(false);
    expect(result.current.disabledReason).toMatch(/Run PFlow first/);
  });

  it('PF and TDS themselves are NOT gated by the PF prerequisite', () => {
    const pf = renderHook(() => useRunReadiness('pflow'));
    const tds = renderHook(() => useRunReadiness('tds'));
    expect(pf.result.current.ready).toBe(true);
    expect(tds.result.current.ready).toBe(true);
  });
});

describe('useRunReadiness — EIG mutated dae state', () => {
  beforeEach(() => {
    seedReadyBaseline();
    usePflowStore.setState({ lastRun: FAKE_PFLOW_OK, isRunning: false, error: null });
    useAnalyzeStore.setState({ eigResult: EIG_AFTER_RUN });
  });

  it('PF returns the EIG-mutated reason with reload-case recovery', () => {
    const { result } = renderHook(() => useRunReadiness('pflow'));
    expect(result.current.ready).toBe(false);
    expect(result.current.disabledReason).toBe(
      'EIG initialised the dynamic state; reload case to re-run PF.',
    );
    expect(result.current.recovery).toEqual({
      kind: 'reload-case',
      label: 'Reload case',
    });
  });

  it('TDS / EIG / CPF / SE are NOT gated by the EIG-mutated check (only PF cares)', () => {
    useAnalyzeStore.setState({ seMeasurementsCount: 5 });
    for (const routine of ['tds', 'eig', 'cpf', 'se'] as const) {
      const { result } = renderHook(() => useRunReadiness(routine));
      expect(result.current.ready).toBe(true);
    }
  });

  it('an EIG result with tds_initialized=false does NOT block PF', () => {
    useAnalyzeStore.setState({
      eigResult: { ...EIG_AFTER_RUN, tds_initialized: false },
    });
    const { result } = renderHook(() => useRunReadiness('pflow'));
    expect(result.current.ready).toBe(true);
  });
});

describe('useRunReadiness — sweep in progress', () => {
  beforeEach(() => {
    seedReadyBaseline();
    usePflowStore.setState({ lastRun: FAKE_PFLOW_OK, isRunning: false, error: null });
    useAnalyzeStore.setState({ seMeasurementsCount: 5 });
    useSweepStore.setState({
      activeSweepId: 'sweep-42',
      sweeps: {
        'sweep-42': {
          sweepId: 'sweep-42',
          parameterKind: 'disturbance.fault.tc',
          parameterTarget: 0,
          snapshotName: 'snap-A',
          total: 10,
          state: 'running',
          iterations: [
            // Three iterations completed.
            {
              iteration: 0,
              parameter_value: 1.0,
              converged: true,
              final_t: 2,
              callpert_count: 0,
              error: null,
            },
            {
              iteration: 1,
              parameter_value: 1.1,
              converged: true,
              final_t: 2,
              callpert_count: 0,
              error: null,
            },
            {
              iteration: 2,
              parameter_value: 1.2,
              converged: true,
              final_t: 2,
              callpert_count: 0,
              error: null,
            },
          ],
          truncated: false,
          error: null,
          startedAt: 0,
        },
      },
    });
  });

  it.each(ALL_ROUTINES)(
    '%s returns the sweep-in-progress reason with the id + progress',
    (routine) => {
      const { result } = renderHook(() => useRunReadiness(routine));
      expect(result.current.ready).toBe(false);
      expect(result.current.disabledReason).toBe(
        'Sweep sweep-42 in progress (3/10); wait or abort.',
      );
      expect(result.current.recovery).toBeNull();
    },
  );

  it('falls back to no-progress text when the sweep record is missing', () => {
    useSweepStore.setState({ activeSweepId: 'sweep-orphan', sweeps: {} });
    const { result } = renderHook(() => useRunReadiness('eig'));
    expect(result.current.disabledReason).toBe('Sweep sweep-orphan in progress; wait or abort.');
  });
});

describe('useRunReadiness — SE measurement gate', () => {
  beforeEach(() => {
    seedReadyBaseline();
    usePflowStore.setState({ lastRun: FAKE_PFLOW_OK, isRunning: false, error: null });
  });

  it('SE without measurements returns "Generate measurements first."', () => {
    useAnalyzeStore.setState({ seMeasurementsCount: null });
    const { result } = renderHook(() => useRunReadiness('se'));
    expect(result.current.ready).toBe(false);
    expect(result.current.disabledReason).toBe('Generate measurements first.');
  });

  it('SE with zero measurements still gates', () => {
    useAnalyzeStore.setState({ seMeasurementsCount: 0 });
    const { result } = renderHook(() => useRunReadiness('se'));
    expect(result.current.ready).toBe(false);
    expect(result.current.disabledReason).toBe('Generate measurements first.');
  });

  it('SE with positive measurement count is ready', () => {
    useAnalyzeStore.setState({ seMeasurementsCount: 12 });
    const { result } = renderHook(() => useRunReadiness('se'));
    expect(result.current.ready).toBe(true);
  });

  it('the SE measurement gate does NOT affect EIG / CPF', () => {
    useAnalyzeStore.setState({ seMeasurementsCount: null });
    expect(renderHook(() => useRunReadiness('eig')).result.current.ready).toBe(true);
    expect(renderHook(() => useRunReadiness('cpf')).result.current.ready).toBe(true);
  });
});

describe('useRunReadiness — gate ordering', () => {
  it('"No case loaded." shadows every other reason', () => {
    // Sweep is "in progress" + EIG mutated dae + no PF + no measurements,
    // but no case → the case reason wins.
    useSweepStore.setState({
      activeSweepId: 'sweep-42',
      sweeps: {},
    });
    useAnalyzeStore.setState({ eigResult: EIG_AFTER_RUN });
    const { result } = renderHook(() => useRunReadiness('pflow'));
    expect(result.current.disabledReason).toBe('No case loaded.');
  });

  it('sweep-in-progress shadows the PF-prerequisite reason', () => {
    seedReadyBaseline();
    useSweepStore.setState({ activeSweepId: 'sweep-1', sweeps: {} });
    const { result } = renderHook(() => useRunReadiness('eig'));
    expect(result.current.disabledReason).toMatch(/Sweep sweep-1 in progress/);
  });

  it('sweep-in-progress shadows the EIG-mutated-dae reason', () => {
    seedReadyBaseline();
    usePflowStore.setState({ lastRun: FAKE_PFLOW_OK, isRunning: false, error: null });
    useAnalyzeStore.setState({ eigResult: EIG_AFTER_RUN });
    useSweepStore.setState({ activeSweepId: 'sweep-1', sweeps: {} });
    const { result } = renderHook(() => useRunReadiness('pflow'));
    expect(result.current.disabledReason).toMatch(/Sweep sweep-1 in progress/);
  });
});
