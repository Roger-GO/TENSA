/**
 * Combined store entrypoint.
 *
 * Each slice is its own Zustand store (this composition is the
 * recommended pattern for v5). This module's job is the cross-slice
 * cascade:
 *
 * - When `session` clears, `case` and `pflow` clear too.
 * - When `case` changes, `pflow` clears (results don't carry across cases).
 *
 * The cascade is wired here (one place to read) rather than each slice
 * importing every other slice (cycles + tangled blast radius).
 *
 * Side effect: this module's import has the side effect of registering
 * the cascade. Tests that exercise cascade behavior should `import './'`
 * to ensure the wiring is live.
 */
import { useCaseStore } from './case';
import { useSessionStore } from './session';
import { usePflowStore } from './pflow';
import { useRunsStore } from './runs';
import { useAnimationStore } from './animation';
import { useConnectivityStore } from './connectivity';
import { usePmuStore } from './pmu';
import { useProfilesStore } from './profiles';
import { useSweepStore } from './sweep';
import { useJobsStore } from './jobs';

// Re-export slices so consumers have one import surface.
export { useSessionStore } from './session';
export { useCaseStore } from './case';
export { usePflowStore } from './pflow';
export { useRunsStore } from './runs';
export { useLayoutStore, DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY } from './layout';
export { BOTTOM_DRAWER_TABS, ANALYSIS_SUB_TABS } from './layout';
export type { SessionState } from './session';
export type { CaseState, CaseSelection } from './case';
export type { PflowState } from './pflow';
export type { RunsState, RunRecord, RunState, RunConnectionStatus } from './runs';
export type { LayoutState, BottomDrawerTab, AnalysisSubTab } from './layout';

// ---- cascade wiring -------------------------------------------------------

let cascadeWired = false;

/**
 * Wire the cross-slice clear cascade. Idempotent — safe to call multiple
 * times (HMR, test setup). Tests can also call `__resetCascadeForTests`
 * to undo the wiring between cases.
 */
export function wireStoreCascade(): void {
  if (cascadeWired) return;
  cascadeWired = true;

  // session clear → case + pflow + runs clear.
  // Subscribe to `sessionId`; when it transitions to null, cascade —
  // EXCEPT when the transition is part of an in-progress recovery (Unit 5),
  // in which case we want to preserve the case selection so the recovery
  // effect can re-issue ``loadCase`` against the new session id. Runs are
  // session-scoped (a run's frames only make sense against the worker that
  // produced them), so they always clear on session change — recovery or
  // not.
  let prevSessionId = useSessionStore.getState().sessionId;
  useSessionStore.subscribe((state) => {
    const next = state.sessionId;
    if (prevSessionId !== null && next === null) {
      useRunsStore.getState().clearRuns();
      useAnimationStore.getState().clearAll();
      useConnectivityStore.getState().clear();
      usePmuStore.getState().clear();
      useProfilesStore.getState().clear();
      useSweepStore.getState().clearSweeps();
      // Jobs are session-scoped (a job's lifecycle belongs to the worker
      // that produced it); always clear on session change, recovery or not.
      useJobsStore.getState().clearJobs();
      if (!state.recoveryInProgress) {
        useCaseStore.getState().clearCase();
        usePflowStore.getState().clearPflow();
      }
    }
    prevSessionId = next;
  });

  // case change → pflow + connectivity + pmu + profiles clear.
  // Triggered on selection change OR clear. Connectivity is bus-idx
  // keyed and a new case has a new bus set, so a stale snapshot would
  // grey out the wrong nodes; PMU and TimeSeries placements are
  // device-idx keyed for the same reason.
  let prevSelection = useCaseStore.getState().selection;
  useCaseStore.subscribe((state) => {
    const next = state.selection;
    if (prevSelection !== next) {
      usePflowStore.getState().clearPflow();
      useConnectivityStore.getState().clear();
      usePmuStore.getState().clear();
      useProfilesStore.getState().clear();
    }
    prevSelection = next;
  });
}

/**
 * Internal test helper: undo cascade wiring. Each test that mutates store
 * state should call this in `afterEach` so the next test starts clean.
 */
export function __resetCascadeForTests(): void {
  cascadeWired = false;
  useSessionStore.setState({
    sessionId: null,
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
    recoveryStuckSince: null,
  });
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useAnimationStore.setState({ busOverlayByRun: {} });
  useConnectivityStore.setState({
    result: null,
    energisedBusIdxes: new Set<string>(),
  });
  usePmuStore.setState({ pmus: [] });
  useProfilesStore.setState({ profiles: [] });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
  useJobsStore.setState({ jobs: {} });
}

// Side-effect: defensive auto-wire on first import. `wireStoreCascade` is
// idempotent so this is safe; tests that need a reset call
// `__resetCascadeForTests` then `wireStoreCascade` again.
wireStoreCascade();
