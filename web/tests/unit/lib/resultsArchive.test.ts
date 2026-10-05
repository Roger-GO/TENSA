/**
 * The archive of results in the browser's IndexedDB: what it writes of a run
 * and of a kept power flow, what it reads back, and what it does with a record
 * it cannot read. Run against `fake-indexeddb`, an in-memory IndexedDB.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRunId } from '@/api/types';
import { NO_ELEMENT_NAMES } from '@/lib/elementNames';
import {
  openResultsArchive,
  RESULTS_DB_NAME,
  RESULTS_DB_VERSION,
  runDataOf,
  runFromArchive,
  runMetaOf,
  type ResultsArchive,
} from '@/lib/resultsArchive';
import type { PflowSnapshot } from '@/store/pflowHistory';
import { finishedRun } from '../helpers/runs';

function snapshot(
  id: string,
  ordinal: number,
  overrides: Partial<PflowSnapshot> = {},
): PflowSnapshot {
  return {
    id,
    ordinal,
    takenAt: 1_000 * ordinal,
    caseName: 'ieee14',
    result: {
      run_id: parseRunId(id),
      converged: true,
      iterations: 3,
      mismatch: 1e-9,
      bus_voltages: { '1': 1.02 },
      bus_angles: { '1': 0 },
      line_flows: {},
    },
    names: { ...NO_ELEMENT_NAMES, buses: { '1': 'North' } },
    ...overrides,
  };
}

/** Write a raw record straight into a store, as another version of the app might have. */
async function putRaw(factory: IDBFactory, store: string, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(RESULTS_DB_NAME, RESULTS_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction([store], 'readwrite');
      transaction.objectStore(store).put(value);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

describe('resultsArchive', () => {
  let factory: IDBFactory;
  let archive: ResultsArchive;

  beforeEach(async () => {
    factory = new IDBFactory();
    archive = (await openResultsArchive(factory))!;
  });

  afterEach(() => archive.close());

  it('opens, and reads nothing from a new database', async () => {
    expect(archive).not.toBeNull();
    expect(await archive.read()).toEqual({
      runs: [],
      runsState: null,
      pflow: [],
      pflowState: null,
      staleRunIds: [],
      stalePflowIds: [],
    });
  });

  it('gives back a run as it was written: its record and its samples', async () => {
    const run = finishedRun('r1', {
      displayName: 'Base case',
      colorOverride: '#aa3300',
      scenario: 'fault bus 7',
      bases: { busKv: { '1': 230 }, freqHz: 60 },
    });
    await archive.putRun(run);

    const { runs } = await archive.read();
    expect(runs).toHaveLength(1);
    const back = runs[0]!;
    expect(runMetaOf(back)).toEqual(runMetaOf(run));
    expect(back).toMatchObject({
      displayName: 'Base case',
      colorOverride: '#aa3300',
      scenario: 'fault bus 7',
      bases: { busKv: { '1': 230 }, freqHz: 60 },
      state: 'done',
      converged: true,
      ordinal: 1,
      tf: 1,
    });
    // Still typed arrays of doubles, not plain arrays or strings.
    expect(Object.prototype.toString.call(back.t)).toBe('[object Float64Array]');
    expect(back.t.BYTES_PER_ELEMENT).toBe(8);
    expect(Array.from(back.t)).toEqual([0, 0.1, 0.2]);
    expect(Array.from(back.columns.Bus_1_v!)).toEqual([1, 0.99, 0.98]);
    expect(Array.from(back.columns.Gen_1_omega!)).toEqual([1, 1.001, 1.0005]);
  });

  it('leaves the server error text of a failed run out of what it stores', async () => {
    const run = finishedRun('r1', { state: 'error', errorReason: 'failed in /srv/cases/x.raw' });
    expect(runMetaOf(run).errorReason).toBeNull();
    await archive.putRun(run);
    const back = (await archive.read()).runs[0]!;
    expect(back.state).toBe('error');
    expect(back.errorReason).toBeNull();
  });

  it('stores only the rows a run holds, not the spare room of its arrays', async () => {
    // The store doubles its arrays as a run grows: 3 rows in room for 256.
    const t = new Float64Array(256);
    t.set([0, 0.1, 0.2]);
    const v = new Float64Array(256);
    v.set([1, 0.99, 0.98]);
    const run = finishedRun('r1', { t, columns: { Bus_1_v: v }, columnNames: ['Bus_1_v'] });

    expect(runDataOf(run).t).toHaveLength(3);
    await archive.putRun(run);
    const back = (await archive.read()).runs[0]!;
    expect(back.t).toHaveLength(3);
    expect(back.columns.Bus_1_v).toHaveLength(3);
    expect(Array.from(back.columns.Bus_1_v!)).toEqual([1, 0.99, 0.98]);
  });

  it('reads the runs back oldest first', async () => {
    await archive.putRun(finishedRun('late', { startedAt: 300 }));
    await archive.putRun(finishedRun('early', { startedAt: 100 }));
    await archive.putRun(finishedRun('middle', { startedAt: 200 }));
    expect((await archive.read()).runs.map((r) => r.runId)).toEqual(['early', 'middle', 'late']);
  });

  it('rewrites a run record without touching its samples', async () => {
    const run = finishedRun('r1');
    await archive.putRun(run);
    // A record whose arrays are not the stored ones: only the name may be taken from it.
    await archive.putRunMeta({
      ...run,
      displayName: 'Renamed',
      t: new Float64Array(3),
      columns: { Bus_1_v: new Float64Array(3), Gen_1_omega: new Float64Array(3) },
    });
    const back = (await archive.read()).runs[0]!;
    expect(back.displayName).toBe('Renamed');
    expect(Array.from(back.t)).toEqual([0, 0.1, 0.2]);
  });

  it('deletes a run, record and samples', async () => {
    await archive.putRun(finishedRun('r1'));
    await archive.putRun(finishedRun('r2', { startedAt: 2 }));
    await archive.deleteRun('r1');
    const contents = await archive.read();
    expect(contents.runs.map((r) => r.runId)).toEqual(['r2']);
    expect(contents.staleRunIds).toEqual([]);
  });

  it('keeps the run counter, the overlay pins and the retention limit', async () => {
    await archive.putRunsState({ runCount: 7, overlayRunIds: ['r1', 'r2'], retentionLimit: 12 });
    expect((await archive.read()).runsState).toEqual({
      runCount: 7,
      overlayRunIds: ['r1', 'r2'],
      retentionLimit: 12,
    });
  });

  it('keeps the power flows, in the order they were solved, and which two are compared', async () => {
    await archive.putPflow(snapshot('pf-2', 2, { name: 'Line 5 out' }));
    await archive.putPflow(snapshot('pf-1', 1));
    await archive.putPflowState({ count: 2, baselineId: 'pf-1', comparedId: null });

    const contents = await archive.read();
    expect(contents.pflow.map((s) => s.id)).toEqual(['pf-1', 'pf-2']);
    expect(contents.pflow[1]).toEqual(snapshot('pf-2', 2, { name: 'Line 5 out' }));
    expect(contents.pflowState).toEqual({ count: 2, baselineId: 'pf-1', comparedId: null });

    await archive.deletePflow('pf-1');
    expect((await archive.read()).pflow.map((s) => s.id)).toEqual(['pf-2']);
  });

  it('is still there when the database is opened again, as after a reload', async () => {
    await archive.putRun(finishedRun('r1'));
    await archive.putPflow(snapshot('pf-1', 1));
    archive.close();

    archive = (await openResultsArchive(factory))!;
    const contents = await archive.read();
    expect(contents.runs.map((r) => r.runId)).toEqual(['r1']);
    expect(contents.pflow.map((s) => s.id)).toEqual(['pf-1']);
  });

  describe('a record it cannot read', () => {
    it('is left out and reported, so it can be deleted: a run with no samples', async () => {
      await archive.putRun(finishedRun('whole'));
      await putRaw(factory, 'runs', runMetaOf(finishedRun('no-samples')));
      const contents = await archive.read();
      expect(contents.runs.map((r) => r.runId)).toEqual(['whole']);
      expect(contents.staleRunIds).toEqual(['no-samples']);
    });

    it('samples with no record, and a record that is not a run', async () => {
      await putRaw(factory, 'run-data', runDataOf(finishedRun('orphan')));
      await putRaw(factory, 'runs', { runId: 'other-version', shape: 2 });
      const contents = await archive.read();
      expect(contents.runs).toEqual([]);
      expect(contents.staleRunIds.sort()).toEqual(['orphan', 'other-version']);
    });

    it('a power flow that is not one, and state that is not state', async () => {
      await archive.putPflow(snapshot('pf-1', 1));
      await putRaw(factory, 'pflow', { id: 'odd', result: { converged: false } });
      // Written by hand under the keys the state uses.
      await new Promise<void>((resolve, reject) => {
        const request = factory.open(RESULTS_DB_NAME, RESULTS_DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(['state'], 'readwrite');
          transaction.objectStore('state').put({ runCount: 'seven' }, 'runs');
          transaction.objectStore('state').put('nothing', 'pflow');
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
      const contents = await archive.read();
      expect(contents.pflow.map((s) => s.id)).toEqual(['pf-1']);
      expect(contents.stalePflowIds).toEqual(['odd']);
      expect(contents.runsState).toBeNull();
      expect(contents.pflowState).toBeNull();
    });

    it('a power flow whose iteration count or mismatch is not a number', async () => {
      await archive.putPflow(snapshot('pf-1', 1));
      const whole = snapshot('pf-2', 2);
      await putRaw(factory, 'pflow', {
        ...whole,
        id: 'text-iterations',
        result: { ...whole.result, iterations: '<b>3</b>' },
      });
      await putRaw(factory, 'pflow', {
        ...whole,
        id: 'no-mismatch',
        result: { ...whole.result, mismatch: undefined },
      });
      const contents = await archive.read();
      expect(contents.pflow.map((s) => s.id)).toEqual(['pf-1']);
      expect(contents.stalePflowIds.sort()).toEqual(['no-mismatch', 'text-iterations']);
    });
  });
});

describe('runFromArchive', () => {
  const run = finishedRun('r1');
  const meta = runMetaOf(run);
  const data = runDataOf(run);

  it('puts a record and its samples back together', () => {
    const back = runFromArchive(meta, data);
    expect(back?.runId).toBe('r1');
    expect(back?.t).toBe(data.t);
  });

  it.each([
    ['a run that had not finished', { ...meta, state: 'streaming' }, data],
    ['samples of another run', meta, { ...data, runId: 'r2' }],
    ['a time column of another length', meta, { ...data, t: new Float64Array(2) }],
    ['a missing column', meta, { ...data, columns: { Bus_1_v: data.columns.Bus_1_v } }],
    [
      'a column that is not a typed array',
      meta,
      { ...data, columns: { ...data.columns, Bus_1_v: [1, 2, 3] } },
    ],
    ['a row count that is not a count', { ...meta, seqCount: -1 }, data],
    ['no record', undefined, data],
    ['no samples', meta, undefined],
  ])('refuses %s', (_what, m, d) => {
    expect(runFromArchive(m, d)).toBeNull();
  });
});

describe('openResultsArchive without a usable IndexedDB', () => {
  it('gives null where the browser has none', async () => {
    expect(await openResultsArchive(null)).toBeNull();
  });

  it('gives null when the database will not open', async () => {
    const refusing = {
      open: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    } as unknown as IDBFactory;
    expect(await openResultsArchive(refusing)).toBeNull();
  });
});
