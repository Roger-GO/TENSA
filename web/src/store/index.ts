/**
 * Combined store entrypoint.
 *
 * Each slice is its own Zustand store (this composition is the
 * recommended pattern for v5). This module's job is the cross-slice
 * cascade:
 *
 * - When `session` clears, `case` and `pflow` clear too.
 * - When `case` changes, `pflow` and the EIG / CPF / SE results clear
 *   (results don't carry across cases), the disturbances scheduled for the next
 *   TDS run clear (they name the old case's buses), the ANDES variables picked
 *   for it clear (they name its devices), the power-flow options go back to the
 *   defaults, and the active TDS run is released.
 *   The finished runs themselves stay: they are results only this tab holds,
 *   and comparing a run on one case with a run on a modified copy is a normal
 *   workflow. They go when the session ends.
 * - When `pflow` clears (case change, reload, run reset), the EIG / CPF / SE
 *   results clear with it: they were computed from that operating point.
 *
 * The cascade is wired here (one place to read) rather than each slice
 * importing every other slice (cycles + tangled blast radius).
 *
 * Side effect: this module's import has the side effect of registering
 * the cascade. `App.tsx` imports it for exactly that reason (nothing else
 * in the app reads from this entrypoint, so without that import the
 * cascade never runs and a case change leaves the old case's results
 * enabling the new case's Run buttons). Tests that exercise cascade
 * behavior should `import './'` to ensure the wiring is live.
 */
import { useCaseStore } from './case';
import { useSessionStore } from './session';
import { usePflowStore } from './pflow';
import { usePflowOptionsStore } from './pflowOptions';
import { useRunsStore } from './runs';
import { useAnimationStore } from './animation';
import { useConnectivityStore } from './connectivity';
import { usePmuStore } from './pmu';
import { useProfilesStore } from './profiles';
import { useDisturbanceStore } from './disturbance';
import { useSweepStore } from './sweep';
import { useJobsStore } from './jobs';
import { useAnalyzeStore } from './analyze';
import { useUiStore } from './ui';

// Re-export slices so consumers have one import surface.
export { useSessionStore } from './session';
export { useCaseStore } from './case';
export { usePflowStore } from './pflow';
export { usePflowOptionsStore } from './pflowOptions';
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

  // case change → pflow + analysis results + connectivity + pmu + profiles +
  // scheduled disturbances + the ANDES variables picked for the next run clear,
  // the power-flow options go back to the defaults
  // (a setting made to rescue one case should not follow the user to the next),
  // and the active TDS run is released. Triggered on selection change
  // OR clear. Connectivity is bus-idx keyed and a new case has a new bus set,
  // so a stale snapshot would grey out the wrong nodes; PMU and TimeSeries
  // placements are device-idx keyed for the same reason. An EIG result that
  // initialised the dynamic state, or a TDS run still marked active, would
  // otherwise keep the new case's Run PF disabled ("Reset the run first") and
  // draw the old case's frames over the new diagram. Only the *active* run
  // does that, so the runs themselves (names, colours, overlay pins) are kept,
  // as Reset run keeps the rest of the history. The diagram overlay is bus-idx
  // keyed, so it clears with the case. So are the scheduled disturbances: a
  // fault on bus 7 of the old case would otherwise be committed to the new one
  // (or refused, when it has no bus 7) the next time a TDS run starts.
  let prevSelection = useCaseStore.getState().selection;
  useCaseStore.subscribe((state) => {
    const next = state.selection;
    if (prevSelection !== next) {
      usePflowStore.getState().clearPflow();
      usePflowOptionsStore.getState().resetForNewCase();
      clearAnalysisResults();
      useRunsStore.getState().clearActiveRun();
      useAnimationStore.getState().clearAll();
      useConnectivityStore.getState().clear();
      usePmuStore.getState().clear();
      useProfilesStore.getState().clear();
      useDisturbanceStore.getState().clearDisturbances();
      // The ANDES variables picked for the next run are names of the old
      // case's devices.
      useUiStore.getState().setTdsConfig({ daeVars: [] });
    }
    prevSelection = next;
  });

  // pflow cleared → EIG / CPF / SE results clear. Reload, run reset, a case
  // change, and a session clear all drop the operating point; the results
  // computed from it must not outlive it (the Analyze views that used to
  // clear them on this transition only do so while they are mounted).
  usePflowStore.subscribe((state, prev) => {
    if (prev.lastRun !== null && state.lastRun === null) clearAnalysisResults();
  });
}

/** Drop the EIG, CPF and SE results (and the SE measurement count). */
function clearAnalysisResults(): void {
  const analyze = useAnalyzeStore.getState();
  analyze.clearEigResult();
  analyze.clearCpfResult();
  analyze.clearSeResult();
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
  usePflowOptionsStore.getState().resetForNewCase();
  useAnalyzeStore.setState({
    eigResult: null,
    selectedModeId: null,
    cpfResult: null,
    seResult: null,
    seMeasurementsCount: null,
  });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  useAnimationStore.setState({ busOverlayByRun: {} });
  useConnectivityStore.setState({
    result: null,
    energisedBusIdxes: new Set<string>(),
  });
  usePmuStore.setState({ pmus: [] });
  useProfilesStore.setState({ profiles: [] });
  useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
  useUiStore.getState().setTdsConfig({ daeVars: [] });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
  useJobsStore.setState({ jobs: {} });
}

// Side-effect: defensive auto-wire on first import. `wireStoreCascade` is
// idempotent so this is safe; tests that need a reset call
// `__resetCascadeForTests` then `wireStoreCascade` again.
wireStoreCascade();
