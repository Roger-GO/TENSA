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

// Re-export slices so consumers have one import surface.
export { useAuthStore } from './auth';
export { useSessionStore } from './session';
export { useCaseStore } from './case';
export { usePflowStore } from './pflow';
export { registerAuthClearCascade, getAuthToken } from './auth';
export type { AuthState } from './auth';
export type { SessionState } from './session';
export type { CaseState, CaseSelection } from './case';
export type { PflowState } from './pflow';

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

  // auth clear → session + case + pflow clear.
  registerAuthClearCascade(() => {
    useSessionStore.getState().clearSession();
    useCaseStore.getState().clearCase();
    usePflowStore.getState().clearPflow();
  });

  // session clear → case + pflow clear.
  // Subscribe to `sessionId`; when it transitions to null, cascade.
  let prevSessionId = useSessionStore.getState().sessionId;
  useSessionStore.subscribe((state) => {
    const next = state.sessionId;
    if (prevSessionId !== null && next === null) {
      useCaseStore.getState().clearCase();
      usePflowStore.getState().clearPflow();
    }
    prevSessionId = next;
  });

  // case change → pflow clear. Triggered on selection change OR clear.
  let prevSelection = useCaseStore.getState().selection;
  useCaseStore.subscribe((state) => {
    const next = state.selection;
    if (prevSelection !== next) {
      usePflowStore.getState().clearPflow();
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
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
}

// Side-effect: defensive auto-wire on first import. `wireStoreCascade` is
// idempotent so this is safe; tests that need a reset call
// `__resetCascadeForTests` then `wireStoreCascade` again.
wireStoreCascade();
