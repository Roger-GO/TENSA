/**
 * Combined store entrypoint.
 *
 * Each slice is its own Zustand store (this composition is the
 * recommended pattern for v5). This module's job is the cross-slice
 * cascade:
 *
 * - When `session` clears, `case` and `pflow` clear too, and so do the
 *   time-domain runs and the power flows kept for comparison, unless the
 *   session is being recovered: then the finished runs and the kept power
 *   flows stay.
 * - When `case` changes, `pflow` and the EIG / CPF / SE results clear
 *   (results don't carry across cases), the disturbances scheduled for the next
 *   TDS run clear (they name the old case's buses), the ANDES variables picked
 *   for it clear (they name its devices), the power-flow options go back to the
 *   defaults, and the active TDS run is released.
 *   The finished runs themselves stay, and so do the power flows kept for
 *   comparison: they are results only this tab holds, and comparing a run on
 *   one case with a run on a modified copy is a normal workflow. They go when
 *   the session ends. The tab's mark of the case file it has open follows the
 *   change too (`reloadedCase.ts`).
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
import { usePflowHistoryStore } from './pflowHistory';
import { usePflowOptionsStore } from './pflowOptions';
import { useRunsStore } from './runs';
import { useAnimationStore } from './animation';
import { useConnectivityStore } from './connectivity';
import { usePmuStore } from './pmu';
import { useProfilesStore } from './profiles';
import { useDisturbanceStore } from './disturbance';
import { useSweepStore } from './sweep';
import { useJobsStore } from './jobs';
import { useMessagesStore } from './messages';
import { useAnalyzeStore } from './analyze';
import { useUiStore } from './ui';
import { useReloadedCaseStore } from './reloadedCase';

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
  // effect can re-issue ``loadCase`` against the new session id. The runs
  // follow the same line: a session the user discarded takes them all, and
  // one that was lost (reaped, or gone with a server restart) takes only the
  // runs still streaming and the active run's hold on the Run buttons. The
  // finished ones are results, kept across a reload of the page too
  // (``resultsPersistence.ts``), and a lost session is no reason to delete
  // them.
  let prevSessionId = useSessionStore.getState().sessionId;
  useSessionStore.subscribe((state) => {
    const next = state.sessionId;
    if (prevSessionId !== null && next === null) {
      if (state.recoveryInProgress) useRunsStore.getState().dropUnfinishedRuns();
      else useRunsStore.getState().clearRuns();
      useAnimationStore.getState().clearAll();
      useConnectivityStore.getState().clear();
      usePmuStore.getState().clear();
      useProfilesStore.getState().clear();
      useSweepStore.getState().clearSweeps();
      // Jobs are session-scoped (a job's lifecycle belongs to the worker
      // that produced it); always clear on session change, recovery or not.
      useJobsStore.getState().clearJobs();
      // The messages are the server session's log; a new session starts with none.
      useMessagesStore.getState().reset();
      if (!state.recoveryInProgress) {
        useCaseStore.getState().clearCase();
        usePflowStore.getState().clearPflow();
        // The power flows kept for comparison go with a session the user
        // discarded. A recovery keeps them: they are results, not session state.
        usePflowHistoryStore.getState().clear();
      }
    }
    prevSessionId = next;
  });

  // case change → pflow + analysis results + connectivity + pmu + profiles +
  // scheduled disturbances + the ANDES variables picked for the next run and
  // its frequency controllers clear,
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
      // The ANDES variables picked for the next run, and the devices its
      // frequency controllers command, are the old case's.
      useUiStore.getState().setTdsConfig({ daeVars: [], controllers: [] });
      // The tab's mark of the case file it has open, which is what a reload
      // of the page reads to say which case it closed.
      useReloadedCaseStore.getState().follow(next);
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
    diagramLayout: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, lastSolved: null, isRunning: false, error: null });
  usePflowHistoryStore.getState().clear();
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
  useDisturbanceStore.setState({
    disturbances: [],
    removedWith: {},
    dirty: false,
    committed: false,
  });
  useUiStore.getState().setTdsConfig({ daeVars: [], controllers: [] });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
  useJobsStore.setState({ jobs: {} });
}

// Side-effect: defensive auto-wire on first import. `wireStoreCascade` is
// idempotent so this is safe; tests that need a reset call
// `__resetCascadeForTests` then `wireStoreCascade` again.
wireStoreCascade();
