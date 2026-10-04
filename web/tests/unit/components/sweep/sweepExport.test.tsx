/**
 * The sweep results' CSV export: the file a sweep becomes, and the menu on the
 * progress panel that offers it.
 *
 * Coverage:
 * - One row per iteration, parameter value at full precision, the error text.
 * - The header says what was swept and how far it got, and carries a failure.
 * - A sweep still running exports the iterations it has; with none the menu is off.
 * - The file is named for the case and the sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SweepProgressPanel } from '@/components/sweep/SweepProgressPanel';
import { sweepToCsv } from '@/components/sweep/sweepExport';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useSweepStore, type SweepIteration, type SweepRecord } from '@/store/sweep';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import {
  captureDownloads,
  exportAs,
  readBlob,
  type DownloadCapture,
} from '../../helpers/downloads';

// The panel opens a WebSocket for a sweep that is still running; give it a stub.
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

const ITERATIONS: SweepIteration[] = [
  {
    iteration: 0,
    parameter_value: 0.1 + 0.2,
    converged: true,
    final_t: 5,
    callpert_count: 600,
    error: null,
  },
  {
    iteration: 1,
    parameter_value: 0.4,
    converged: false,
    final_t: 1.25,
    callpert_count: 150,
    error: 'diverged, "singular"',
  },
];

function record(overrides: Partial<SweepRecord> = {}): SweepRecord {
  return {
    sweepId: 'abcdef1234567890',
    parameterKind: 'disturbance.fault.tc',
    parameterTarget: 0,
    snapshotName: 'fault-base',
    total: 4,
    state: 'completed',
    iterations: ITERATIONS,
    truncated: false,
    error: null,
    startedAt: 0,
    ...overrides,
  };
}

describe('sweepToCsv', () => {
  it('writes the header, then one row per iteration', async () => {
    const text = await readBlob(sweepToCsv(record()));
    expect(text.split('\n')).toEqual([
      '# sweep of disturbance.fault.tc, disturbance 0, snapshot fault-base',
      '# 2 of 4 iterations, completed',
      'iteration,parameter_value,converged,final_t,callpert_count,error',
      '0,0.30000000000000004,true,5,600,',
      '1,0.4,false,1.25,150,"diverged, ""singular"""',
      '',
    ]);
  });

  it('carries the failure a sweep ended with', async () => {
    const text = await readBlob(
      sweepToCsv(
        record({
          state: 'error',
          error: { category: 'worker_error', detail: 'boom' },
        }),
      ),
    );
    expect(text.split('\n').slice(0, 3)).toEqual([
      '# sweep of disturbance.fault.tc, disturbance 0, snapshot fault-base',
      '# 2 of 4 iterations, error',
      '# worker_error: boom',
    ]);
  });
});

describe('<SweepProgressPanel /> export', () => {
  let downloads: DownloadCapture;

  beforeEach(() => {
    downloads = captureDownloads();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocket;
    useSweepStore.setState({ sweeps: {}, activeSweepId: null });
    useSessionStore.setState({ sessionId: parseSessionId('test-session') });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/kundur_full.xlsx'), addfiles: [] },
    });
  });

  afterEach(() => {
    downloads.restore();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    cleanup();
    useCaseStore.setState({ selection: null });
    useSessionStore.setState({ sessionId: null });
  });

  function startSweep(received: number) {
    useSweepStore.getState().startSweep({
      sweepId: 'abcdef1234567890',
      parameterKind: 'disturbance.fault.tc',
      parameterTarget: 0,
      snapshotName: 'fault-base',
      total: 4,
    });
    for (const it of ITERATIONS.slice(0, received)) {
      useSweepStore.getState().appendIteration('abcdef1234567890', it);
    }
  }

  it('has the menu off until an iteration has come in', () => {
    startSweep(0);
    render(<SweepProgressPanel />);
    expect(screen.getByTestId('export-menu-trigger')).toBeDisabled();
  });

  it('exports the iterations received so far, from a sweep still running', async () => {
    const user = userEvent.setup();
    startSweep(1);
    render(<SweepProgressPanel />);
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(/^kundur_full_abcdef12_sweep_.*\.csv$/);
    const lines = (await readBlob(downloads.blobs[0]!)).split('\n');
    expect(lines[1]).toBe('# 1 of 4 iterations, running');
    expect(lines.slice(3, 5)).toEqual(['0,0.30000000000000004,true,5,600,', '']);
  });

  it('offers CSV only', async () => {
    const user = userEvent.setup();
    startSweep(2);
    render(<SweepProgressPanel />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('export-menu-csv')).toBeEnabled();
    expect(screen.queryByTestId('export-menu-png')).toBeNull();
  });
});
