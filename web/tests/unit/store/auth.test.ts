/**
 * Tests for the auth slice + cross-slice cascade.
 *
 * Strategy: each test resets the stores via `__resetCascadeForTests`,
 * mutates state via the public hooks' `setState`/`getState`, then
 * asserts on observable behavior (other slices cleared on token clear,
 * persistFailed on storage write failure, etc.).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('auth store', () => {
  beforeEach(async () => {
    // Re-import each test to get a fresh module-state for cascade flag,
    // and to start from cleared sessionStorage.
    sessionStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('setToken persists to sessionStorage and clears persistFailed', async () => {
    const { useAuthStore } = await import('@/store/auth');

    useAuthStore.getState().setToken('a'.repeat(64));
    expect(useAuthStore.getState().token).toBe('a'.repeat(64));
    expect(useAuthStore.getState().persistFailed).toBe(false);
    expect(sessionStorage.getItem('andes-app:auth-token')).toBe('a'.repeat(64));
  });

  it('clearToken removes from sessionStorage and resets state', async () => {
    const { useAuthStore } = await import('@/store/auth');

    useAuthStore.getState().setToken('a'.repeat(64));
    useAuthStore.getState().clearToken();
    expect(useAuthStore.getState().token).toBeNull();
    expect(sessionStorage.getItem('andes-app:auth-token')).toBeNull();
  });

  it('reads persisted token on first read (lazy bootstrap)', async () => {
    sessionStorage.setItem('andes-app:auth-token', 'b'.repeat(64));
    const { useAuthStore } = await import('@/store/auth');
    expect(useAuthStore.getState().token).toBe('b'.repeat(64));
  });

  it('sessionStorage write failure → persistFailed=true, token still set in memory', async () => {
    // jsdom's sessionStorage is host-implementation-sealed; spying on
    // its setItem doesn't intercept. Replace `window.sessionStorage`
    // wholesale with a throw-on-write stub for the duration of the test.
    const original = window.sessionStorage;
    const throwingStub: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('QuotaExceeded', 'QuotaExceededError');
      },
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => throwingStub,
    });

    try {
      const { useAuthStore } = await import('@/store/auth');
      useAuthStore.getState().setToken('c'.repeat(64));
      expect(useAuthStore.getState().token).toBe('c'.repeat(64));
      expect(useAuthStore.getState().persistFailed).toBe(true);
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => original,
      });
    }
  });

  it('sessionStorage read failure → bootstrap token is null', async () => {
    const original = window.sessionStorage;
    const throwingStub: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => {
        throw new DOMException('SecurityError', 'SecurityError');
      },
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => throwingStub,
    });

    try {
      const { useAuthStore } = await import('@/store/auth');
      expect(useAuthStore.getState().token).toBeNull();
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => original,
      });
    }
  });

  it('clearToken cascades to session, case, and pflow slices', async () => {
    // Importing the index module wires the cascade.
    const storeIndex = await import('@/store');
    storeIndex.__resetCascadeForTests();
    storeIndex.wireStoreCascade();

    const { useAuthStore, useSessionStore, useCaseStore, usePflowStore } = storeIndex;

    // Seed every slice with non-default state.
    useAuthStore.getState().setToken('d'.repeat(64));
    useSessionStore
      .getState()
      .setSessionId(
        'session-1' as Parameters<ReturnType<typeof useSessionStore.getState>['setSessionId']>[0],
      );
    useCaseStore.getState().setCase({
      primaryPath: 'foo.xlsx' as Parameters<
        ReturnType<typeof useCaseStore.getState>['setCase']
      >[0]['primaryPath'],
      addfiles: [],
    });
    usePflowStore.getState().setRunning(true);

    expect(useSessionStore.getState().sessionId).not.toBeNull();
    expect(useCaseStore.getState().selection).not.toBeNull();
    expect(usePflowStore.getState().isRunning).toBe(true);

    useAuthStore.getState().clearToken();

    expect(useAuthStore.getState().token).toBeNull();
    expect(useSessionStore.getState().sessionId).toBeNull();
    expect(useCaseStore.getState().selection).toBeNull();
    expect(usePflowStore.getState().isRunning).toBe(false);
    expect(usePflowStore.getState().lastRun).toBeNull();
  });

  it('case selection change clears pflow state', async () => {
    const storeIndex = await import('@/store');
    storeIndex.__resetCascadeForTests();
    storeIndex.wireStoreCascade();

    const { useCaseStore, usePflowStore } = storeIndex;

    useCaseStore.getState().setCase({
      primaryPath: 'first.xlsx' as Parameters<
        ReturnType<typeof useCaseStore.getState>['setCase']
      >[0]['primaryPath'],
      addfiles: [],
    });
    usePflowStore.setState({
      lastRun: {
        run_id: 'r1',
        converged: true,
        iterations: 3,
        mismatch: 1e-6,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
      },
      isRunning: false,
      error: null,
    });

    // Switching case clears pflow.
    useCaseStore.getState().setCase({
      primaryPath: 'second.xlsx' as Parameters<
        ReturnType<typeof useCaseStore.getState>['setCase']
      >[0]['primaryPath'],
      addfiles: [],
    });

    expect(usePflowStore.getState().lastRun).toBeNull();
  });
});
