/**
 * Tests for `<SweepProgressPanel />` (Unit 18 of the v2.0 plan).
 *
 * Covers:
 * - Empty-state when no sweep is in progress.
 * - Progress bar percentage matches iteration count / total.
 * - Per-iteration row rendered for every entry in the store.
 * - Error state: shows the error band when the sweep failed.
 *
 * The WS subscription is mocked out via the global ``WebSocket``
 * shim (jsdom provides a minimal one); the panel only opens the
 * stream when the active sweep is in pending/running state. We
 * assert on rendered output rather than the WS flow here — the
 * sweep store tests cover the data path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { SweepProgressPanel } from '@/components/sweep/SweepProgressPanel';
import { useSweepStore } from '@/store/sweep';
import { useSessionStore } from '@/store/session';
import { useAuthStore } from '@/store/auth';
import { parseSessionId } from '@/api/types';

// Stub the WebSocket so the panel's stream effect doesn't try to open
// a real connection in jsdom (which would warn or noop). The panel's
// useEffect captures the constructor at render time, so we restore
// the original WS in afterEach.
const originalWebSocket = globalThis.WebSocket;

class StubWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 0;
  send = vi.fn();
  close = vi.fn();
  constructor(_url: string) {}
}

beforeEach(() => {
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
  useSessionStore.setState({ sessionId: parseSessionId('test-session') });
  useAuthStore.setState({ token: 'test-token' });
  // Replace the global WebSocket so the panel's stream effect doesn't
  // attempt a live connection.
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocket;
});

afterEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  cleanup();
});

describe('<SweepProgressPanel />', () => {
  it('renders the empty state when no sweep is active', () => {
    render(<SweepProgressPanel />);
    expect(screen.getByTestId('sweep-progress-empty')).toBeInTheDocument();
  });

  it('renders progress percentage and per-iteration rows', () => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 4,
    });
    useSweepStore.getState().appendIteration('sw1', {
      iteration: 0,
      parameter_value: 1.0,
      converged: true,
      final_t: 0.5,
      callpert_count: 60,
      error: null,
    });
    useSweepStore.getState().appendIteration('sw1', {
      iteration: 1,
      parameter_value: 1.1,
      converged: false,
      final_t: 0.3,
      callpert_count: 36,
      error: null,
    });
    render(<SweepProgressPanel />);
    expect(screen.getByTestId('sweep-progress-panel')).toHaveAttribute(
      'data-sweep-id',
      'sw1',
    );
    // 2/4 iterations → 50%.
    const bar = screen.getByTestId('sweep-progress-bar');
    expect(bar.getAttribute('style')).toContain('width: 50%');
    // Both iteration rows.
    expect(screen.getByTestId('sweep-progress-iter-0')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-progress-iter-1')).toBeInTheDocument();
    // Iteration 0 converged='true', iteration 1 converged='false'.
    expect(screen.getByTestId('sweep-progress-iter-0')).toHaveAttribute(
      'data-iter-converged',
      'true',
    );
    expect(screen.getByTestId('sweep-progress-iter-1')).toHaveAttribute(
      'data-iter-converged',
      'false',
    );
  });

  it('renders the error band when the sweep failed', () => {
    useSweepStore.getState().startSweep({
      sweepId: 'sw1',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'snap-A',
      total: 5,
    });
    useSweepStore.getState().markSweepFinished('sw1', 'error', {
      error: { category: 'worker_error', detail: 'boom' },
    });
    // Re-activate so the panel renders the failed sweep.
    useSweepStore.getState().setActiveSweep('sw1');
    render(<SweepProgressPanel />);
    expect(screen.getByTestId('sweep-progress-error')).toHaveTextContent(
      /worker_error: boom/,
    );
    expect(screen.getByTestId('sweep-progress-panel')).toHaveAttribute(
      'data-sweep-state',
      'error',
    );
  });
});
