/**
 * Run records for tests: a finished run with a few samples, shaped as the runs
 * slice holds one after ``markRunDone``, without going through the store.
 */
import type { RunRecord } from '@/store/runs';

export function finishedRun(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    startedAt: 1_700_000_000_000,
    tf: 1,
    tCurrent: 0.2,
    seqCount: 3,
    t: new Float64Array([0, 0.1, 0.2]),
    columns: {
      Bus_1_v: new Float64Array([1, 0.99, 0.98]),
      Gen_1_omega: new Float64Array([1, 1.001, 1.0005]),
    },
    columnNames: ['Bus_1_v', 'Gen_1_omega'],
    ordinal: 1,
    state: 'done',
    connection: 'connected',
    abortedLocally: false,
    errorReason: null,
    converged: true,
    ...overrides,
  };
}
