/**
 * Combined store entrypoint.
 *
 * Each slice is its own Zustand store (this composition is the
 * recommended pattern for v5). This module's job is the cross-slice
 * cascade:
 *
 * - When `auth` clears, `session`, `case`, and `pflow` clear too.
 * - When `session` clears, `case` and `pflow` clear too.
 * - When `case` changes, `pflow` clears (results don't carry across cases).
 *
 * The cascade is wired here (one place to read) rather than each slice
 * importing every other slice (cycles + tangled blast radius).
 *
 * Side effect: this module's import has the side effect of registering
 * the cascade. `App.tsx` imports it once on boot via the auth-store
 * import; tests that exercise cascade behavior should `import './'` to
 * ensure the wiring is live.
 */
import { useAuthStore, registerAuthClearCascade } from './auth';
import { useCaseStore } from './case';
import { useSessionStore } from './session';
import { usePflowStore } from './pflow';
import { useRunsStore } from './runs';
import { useAnimationStore } from './animation';
import { useConnectivityStore } from './connectivity';

// Re-export slices so consumers have one import surface.
export { useAuthStore } from './auth';
export { useSessionStore } from './session';
export { useCaseStore } from './case';
export { usePflowStore } from './pflow';
export { useRunsStore } from './runs';
export { registerAuthClearCascade, getAuthToken } from './auth';
export type { AuthState } from './auth';
export type { SessionState } from './session';
export type { CaseState, CaseSelection } from './case';
export type { PflowState } from './pflow';
export type { RunsState, RunRecord, RunState, RunConnectionStatus } from './runs';

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

  // auth clear → session + case + pflow + runs + animation + connectivity clear.
  registerAuthClearCascade(() => {
    useSessionStore.getState().clearSession();
    useCaseStore.getState().clearCase();
    usePflowStore.getState().clearPflow();
    useRunsStore.getState().clearRuns();
    useAnimationStore.getState().clearAll();
    useConnectivityStore.getState().clear();
  });

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
      if (!state.recoveryInProgress) {
        useCaseStore.getState().clearCase();
        usePflowStore.getState().clearPflow();
      }
    }
    prevSessionId = next;
  });

  // case change → pflow + connectivity clear. Triggered on selection
  // change OR clear. Connectivity is bus-idx keyed and a new case has
  // a new bus set, so a stale snapshot would grey out the wrong nodes.
  let prevSelection = useCaseStore.getState().selection;
  useCaseStore.subscribe((state) => {
    const next = state.selection;
    if (prevSelection !== next) {
      usePflowStore.getState().clearPflow();
      useConnectivityStore.getState().clear();
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
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useAnimationStore.setState({ busOverlayByRun: {} });
  useConnectivityStore.setState({
    result: null,
    energisedBusIdxes: new Set<string>(),
  });
}

// Side-effect: defensive auto-wire on first import. `wireStoreCascade` is
// idempotent so this is safe; tests that need a reset call
// `__resetCascadeForTests` then `wireStoreCascade` again.
wireStoreCascade();
