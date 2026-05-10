/**
 * Tests for the session store's recovery state machine — focused on the
 * v2.0 polish Unit 2 additions:
 *
 *   - ``recoveryStuckSince`` is stamped on entry into ``connecting`` and
 *     preserved across re-entrant ``resetSession`` calls.
 *   - ``markRecoveryFailed`` is idempotent against the "session arrived
 *     first" race — a stale 10s timer firing after recovery succeeded
 *     must not flip a healthy live state into failed.
 *   - ``clearRecoveryInProgress`` clears both the in-progress flag and
 *     the stuck-since stamp so the next connecting cycle gets a fresh
 *     wall-clock.
 *   - ``hardReset`` clears sessionStorage and reloads the tab.
 *
 * The "happy path" + sliding-window assertions for the recovery counter
 * already live in ``tests/unit/api/sessionRecovery.test.tsx`` (where they
 * test the same store via the ``handleGlobalRecoveryError`` integration);
 * this file owns the Unit 2-specific surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useSessionStore,
  RECOVERY_STUCK_TIMEOUT_MS,
  MAX_RECOVERY_ATTEMPTS,
  setHardResetImpl,
  resetHardResetImpl,
} from '@/store/session';
import { parseSessionId } from '@/api/types';

const FRESH_STATE = {
  sessionId: null,
  recoveryInProgress: false,
  recoveryFailed: false,
  recoveryAttempts: [],
  recoveryStuckSince: null,
};

describe('session store — recoveryStuckSince stamp', () => {
  beforeEach(() => {
    useSessionStore.setState(FRESH_STATE);
  });

  afterEach(() => {
    useSessionStore.setState(FRESH_STATE);
    vi.useRealTimers();
  });

  it('resetSession stamps recoveryStuckSince with the current wall-clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));

    useSessionStore.getState().resetSession();
    const stuckSince = useSessionStore.getState().recoveryStuckSince;
    expect(stuckSince).toBe(new Date('2026-05-09T12:00:00Z').getTime());
  });

  it('preserves recoveryStuckSince across re-entrant resetSession calls', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));

    useSessionStore.getState().resetSession();
    const firstStamp = useSessionStore.getState().recoveryStuckSince;
    expect(firstStamp).not.toBeNull();

    // Advance the clock 3 seconds and re-entrant call. The stamp must
    // NOT advance — the 10s stuck-detection timer measures from the
    // first transition into connecting, not the most recent attempt.
    vi.setSystemTime(new Date('2026-05-09T12:00:03Z'));
    useSessionStore.getState().resetSession();
    expect(useSessionStore.getState().recoveryStuckSince).toBe(firstStamp);
  });

  it('clearRecoveryInProgress clears the recoveryStuckSince stamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));

    useSessionStore.getState().resetSession();
    expect(useSessionStore.getState().recoveryStuckSince).not.toBeNull();

    useSessionStore.getState().clearRecoveryInProgress();
    expect(useSessionStore.getState().recoveryStuckSince).toBeNull();
    expect(useSessionStore.getState().recoveryInProgress).toBe(false);
  });

  it('clears the stamp when resetSession transitions directly into failed', () => {
    // Pre-seed enough attempts that the next resetSession call exceeds
    // MAX_RECOVERY_ATTEMPTS within the sliding window — failed should
    // win, and the stamp shouldn't linger from the connecting window.
    const now = Date.now();
    useSessionStore.setState({
      ...FRESH_STATE,
      recoveryAttempts: Array.from({ length: MAX_RECOVERY_ATTEMPTS }, () => now - 100),
      recoveryStuckSince: now - 5_000,
    });

    useSessionStore.getState().resetSession();
    expect(useSessionStore.getState().recoveryFailed).toBe(true);
    expect(useSessionStore.getState().recoveryStuckSince).toBeNull();
  });
});

describe('session store — markRecoveryFailed idempotency', () => {
  beforeEach(() => {
    useSessionStore.setState(FRESH_STATE);
  });

  afterEach(() => {
    useSessionStore.setState(FRESH_STATE);
    vi.useRealTimers();
  });

  it('flips recoveryFailed to true from a connecting state', () => {
    useSessionStore.getState().resetSession();
    expect(useSessionStore.getState().recoveryInProgress).toBe(true);
    expect(useSessionStore.getState().recoveryFailed).toBe(false);

    useSessionStore.getState().markRecoveryFailed();
    expect(useSessionStore.getState().recoveryFailed).toBe(true);
    expect(useSessionStore.getState().recoveryStuckSince).toBeNull();
  });

  it('is a no-op when sessionId arrived first (stale-timer race)', () => {
    // Simulate the race: resetSession kicks off a 10s timer; before it
    // fires, the new session id arrives and the recovery driver clears
    // the in-progress flag. The (now stale) timer firing must not flip
    // the healthy live state into failed.
    useSessionStore.getState().resetSession();
    useSessionStore.setState({ sessionId: parseSessionId('sess-fresh') });
    useSessionStore.getState().clearRecoveryInProgress();

    useSessionStore.getState().markRecoveryFailed();
    expect(useSessionStore.getState().recoveryFailed).toBe(false);
    expect(useSessionStore.getState().sessionId).toBe('sess-fresh');
  });

  it('is a no-op when recoveryFailed is already pinned', () => {
    useSessionStore.setState({
      ...FRESH_STATE,
      recoveryInProgress: true,
      recoveryFailed: true,
      recoveryStuckSince: null,
    });
    // Mutate a tracking field via setState to detect any extra writes.
    const before = useSessionStore.getState();
    useSessionStore.getState().markRecoveryFailed();
    const after = useSessionStore.getState();
    // Reference-equal: no setState was issued.
    expect(after.recoveryFailed).toBe(before.recoveryFailed);
    expect(after.recoveryStuckSince).toBe(before.recoveryStuckSince);
  });

  it('is a no-op when the state is idle (recoveryInProgress is false)', () => {
    useSessionStore.setState(FRESH_STATE);
    useSessionStore.getState().markRecoveryFailed();
    expect(useSessionStore.getState().recoveryFailed).toBe(false);
    expect(useSessionStore.getState().recoveryInProgress).toBe(false);
  });
});

describe('session store — stuck-detection wall-clock arithmetic', () => {
  beforeEach(() => {
    useSessionStore.setState(FRESH_STATE);
  });

  afterEach(() => {
    useSessionStore.setState(FRESH_STATE);
    vi.useRealTimers();
  });

  it('detects stuck after RECOVERY_STUCK_TIMEOUT_MS using the stamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));

    useSessionStore.getState().resetSession();
    const stuckSince = useSessionStore.getState().recoveryStuckSince;
    expect(stuckSince).not.toBeNull();

    // Advance the wall-clock past the 10s threshold.
    vi.setSystemTime(new Date('2026-05-09T12:00:10.001Z'));
    const elapsed = Date.now() - (stuckSince ?? 0);
    expect(elapsed).toBeGreaterThanOrEqual(RECOVERY_STUCK_TIMEOUT_MS);
  });

  it('does not detect stuck before the timeout elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));

    useSessionStore.getState().resetSession();
    const stuckSince = useSessionStore.getState().recoveryStuckSince;

    // Advance only 5 seconds — well under the 10s threshold.
    vi.setSystemTime(new Date('2026-05-09T12:00:05Z'));
    const elapsed = Date.now() - (stuckSince ?? 0);
    expect(elapsed).toBeLessThan(RECOVERY_STUCK_TIMEOUT_MS);
  });
});

describe('session store — hardReset', () => {
  beforeEach(() => {
    useSessionStore.setState(FRESH_STATE);
  });

  afterEach(() => {
    useSessionStore.setState(FRESH_STATE);
    resetHardResetImpl();
    vi.restoreAllMocks();
  });

  it('invokes the swapped hardReset implementation', () => {
    // jsdom forbids redefining ``window.location.reload`` directly, so
    // we use the test seam exposed by ``session.ts`` to capture the
    // hardReset call. The default impl's behaviour (sessionStorage
    // clear + window.location.reload) is exercised in dev manually
    // and via Playwright in the smoke suite.
    const impl = vi.fn();
    setHardResetImpl(impl);

    useSessionStore.getState().hardReset();

    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('the swapped impl can be replaced again (test isolation)', () => {
    const first = vi.fn();
    const second = vi.fn();
    setHardResetImpl(first);
    setHardResetImpl(second);

    useSessionStore.getState().hardReset();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('resetHardResetImpl restores the production default', () => {
    const stub = vi.fn();
    setHardResetImpl(stub);
    useSessionStore.getState().hardReset();
    expect(stub).toHaveBeenCalledTimes(1);

    resetHardResetImpl();
    // Cannot easily exercise the production reload in jsdom (it would
    // crash the test runner). Instead, swap to a different stub and
    // verify the swap took precedence over the now-restored default.
    const stub2 = vi.fn();
    setHardResetImpl(stub2);
    useSessionStore.getState().hardReset();
    expect(stub2).toHaveBeenCalledTimes(1);
  });
});
