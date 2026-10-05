/**
 * Keeping results across a reload: what `startResultsPersistence` writes to the
 * browser's archive as the runs and the kept power flows change, and what it
 * puts back when the page loads again.
 *
 * The archive is the real one (`lib/resultsArchive.ts`) on `fake-indexeddb`, an
 * in-memory IndexedDB. A "reload" here is what a reload is to the two slices:
 * they start empty and persistence starts again on the same database.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';
import { NO_ELEMENT_NAMES } from '@/lib/elementNames';
import { openResultsArchive, type ResultsArchive } from '@/lib/resultsArchive';
import { unsavedWork } from '@/lib/unsavedWork';
import { useEditJournalStore } from '@/store/editJournal';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import {
  __resetResultsPersistenceForTests,
  isRunArchived,
  RESULTS_CHANNEL_NAME,
  startResultsPersistence,
  type ResultsChannel,
  type ResultsPersistence,
} from '@/store/resultsPersistence';
import { DEFAULT_MEMORY_BUDGET_BYTES, DEFAULT_RETENTION_LIMIT, useRunsStore } from '@/store/runs';
import { useSweepStore } from '@/store/sweep';
import { finishedRun } from '../helpers/runs';

/**
 * The channel between the tabs of one address, as a test holds it: what one end
 * posts, every other open end receives at once, as a copy.
 */
function channelHub(): { open: () => ResultsChannel } {
  const listeners = new Map<ResultsChannel, (message: unknown) => void>();
  return {
    open: () => {
      const end: ResultsChannel = {
        post: (message) => {
          for (const [other, handler] of [...listeners]) {
            if (other !== end) handler(structuredClone(message));
          }
        },
        listen: (handler) => {
          listeners.set(end, handler);
        },
        close: () => {
          listeners.delete(end);
        },
      };
      return end;
    },
  };
}

let factory: IDBFactory;
let hub: ReturnType<typeof channelHub>;
let persistence: ResultsPersistence | null = null;
const writeErrors: unknown[] = [];

function emptySlices(): void {
  useRunsStore.setState({
    runs: {},
    activeRunId: null,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    overlayRunIds: new Set<string>(),
    retentionLimit: DEFAULT_RETENTION_LIMIT,
    runCount: 0,
  });
  usePflowHistoryStore.getState().clear();
}

async function start(
  open: () => Promise<ResultsArchive | null> = () => openResultsArchive(factory),
  channel: () => ResultsChannel | null = () => hub.open(),
): Promise<ResultsPersistence> {
  persistence = startResultsPersistence({
    open,
    channel,
    onWriteError: (err) => writeErrors.push(err),
  });
  await persistence.ready;
  return persistence;
}

/** Another tab on the same address: its end of the channel, and what it has heard. */
function otherTab(): { channel: ResultsChannel; heard: unknown[] } {
  const channel = hub.open();
  const heard: unknown[] = [];
  channel.listen((message) => heard.push(message));
  return { channel, heard };
}

/** What that tab does to the archive when it deletes a run from its own list. */
async function deleteInOtherTab(tab: { channel: ResultsChannel }, runId: string): Promise<void> {
  const theirs = (await openResultsArchive(factory))!;
  try {
    await theirs.deleteRun(runId);
  } finally {
    theirs.close();
  }
  tab.channel.post({ type: 'run-deleted', runId });
}

/** What a reload does to the tab: the slices start empty and persistence starts again. */
async function reload(): Promise<void> {
  await persistence?.flushed();
  persistence?.stop();
  emptySlices();
  __resetResultsPersistenceForTests();
  await start();
}

/** What the browser holds, read through a connection of its own. */
async function archived() {
  await persistence?.flushed();
  const archive = (await openResultsArchive(factory))!;
  try {
    return await archive.read();
  } finally {
    archive.close();
  }
}

/** Run a short simulation through the store the way a stream does. */
function simulate(runId: string, rows = 3): void {
  useRunsStore.getState().startRun({ runId, tf: 1, columnNames: ['Bus_1_v'] });
  const t = Float64Array.from({ length: rows }, (_, i) => i / 10);
  const v = Float64Array.from({ length: rows }, (_, i) => 1 - i / 100);
  useRunsStore.getState().appendFrame(runId, { t, columns: { Bus_1_v: v } });
}

function finish(runId: string): void {
  useRunsStore.getState().markRunDone(runId, 0.2, true);
}

function pf(id: string, v = 1.02): PflowResult {
  return {
    run_id: parseRunId(id),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': v },
    bus_angles: { '1': 0 },
    line_flows: {},
  };
}

function keepPf(id: string, v?: number): void {
  usePflowHistoryStore
    .getState()
    .record(pf(id, v), { caseName: 'ieee14', names: NO_ELEMENT_NAMES });
}

beforeEach(() => {
  factory = new IDBFactory();
  hub = channelHub();
  writeErrors.length = 0;
  emptySlices();
  __resetResultsPersistenceForTests();
});

afterEach(async () => {
  await persistence?.flushed();
  persistence?.stop();
  persistence = null;
  emptySlices();
  __resetResultsPersistenceForTests();
});

describe('results across a reload: time-domain runs', () => {
  it('brings a finished run back, with its samples, its name, its colour and its pin', async () => {
    await start();
    simulate('r1');
    finish('r1');
    useRunsStore.getState().setRunDisplayName('r1', 'Base case');
    useRunsStore.getState().setRunColorOverride('r1', '#aa3300');
    useRunsStore.getState().addOverlayRun('r1');

    await reload();

    const { runs, overlayRunIds } = useRunsStore.getState();
    expect(Object.keys(runs)).toEqual(['r1']);
    const run = runs.r1!;
    expect(run).toMatchObject({
      state: 'done',
      converged: true,
      seqCount: 3,
      tf: 1,
      displayName: 'Base case',
      colorOverride: '#aa3300',
      ordinal: 1,
    });
    expect(Array.from(run.t)).toEqual([0, 0.1, 0.2]);
    expect(Array.from(run.columns.Bus_1_v!)).toEqual([1, 0.99, 0.98]);
    expect(overlayRunIds.has('r1')).toBe(true);
  });

  it('brings it back as an earlier run, not as the active one', async () => {
    await start();
    simulate('r1');
    finish('r1');
    expect(useRunsStore.getState().activeRunId).toBe('r1');

    await reload();

    expect(useRunsStore.getState().activeRunId).toBeNull();
  });

  it('goes on numbering where the runs left off', async () => {
    await start();
    simulate('r1');
    finish('r1');
    simulate('r2');
    finish('r2');
    useRunsStore.getState().removeRun('r2');

    await reload();
    simulate('r3');

    expect(useRunsStore.getState().runs.r3?.ordinal).toBe(3);
  });

  it('lets a restored run take new frames from nowhere: its arrays are its own length', async () => {
    await start();
    simulate('r1');
    finish('r1');
    await reload();
    const run = useRunsStore.getState().runs.r1!;
    // The store over-allocates while a run streams; what comes back is cut to size.
    expect(run.t).toHaveLength(run.seqCount);
  });

  it('writes a run when it finishes, not while it streams', async () => {
    await start();
    simulate('r1');
    expect((await archived()).runs).toEqual([]);
    expect(isRunArchived('r1')).toBe(false);

    finish('r1');

    expect((await archived()).runs.map((r) => r.runId)).toEqual(['r1']);
    expect(isRunArchived('r1')).toBe(true);
  });

  it('keeps an aborted run and one that ended in an error, with what they had streamed', async () => {
    await start();
    simulate('aborted');
    useRunsStore.getState().markRunAborted('aborted');
    simulate('failed');
    useRunsStore.getState().markRunError('failed', 'diverged at t = 0.2 s');

    await reload();

    const { runs } = useRunsStore.getState();
    expect(runs.aborted?.state).toBe('aborted');
    expect(runs.failed?.state).toBe('error');
    expect(Array.from(runs.failed!.t)).toEqual([0, 0.1, 0.2]);
  });

  it('does not write the server error text of a failed run into the browser', async () => {
    await start();
    simulate('failed');
    useRunsStore.getState().markRunError('failed', 'solver failed in /srv/cases/secret.raw');

    const [kept] = (await archived()).runs;
    expect(kept?.state).toBe('error');
    expect(kept?.errorReason).toBeNull();
    // The tab still has it, for the banner of the run on screen.
    expect(useRunsStore.getState().runs.failed?.errorReason).toContain('secret.raw');
  });

  it('does not keep a run that was still streaming when the page was left', async () => {
    await start();
    simulate('r1');

    await reload();

    expect(useRunsStore.getState().runs).toEqual({});
  });

  it('does not keep a run that ended before it had a row', async () => {
    await start();
    useRunsStore.getState().startRun({ runId: 'r1', tf: 1, columnNames: ['Bus_1_v'] });
    useRunsStore.getState().markRunError('r1', 'could not initialise');
    expect((await archived()).runs).toEqual([]);
  });

  it('writes the samples once: a rename rewrites the record alone', async () => {
    const real = (await openResultsArchive(factory))!;
    const putRun = vi.fn(real.putRun);
    const putRunMeta = vi.fn(real.putRunMeta);
    await start(async () => ({ ...real, putRun, putRunMeta }));
    simulate('r1');
    finish('r1');
    await persistence!.flushed();
    expect(putRun).toHaveBeenCalledTimes(1);

    useRunsStore.getState().setRunDisplayName('r1', 'Base case');
    useRunsStore.getState().addOverlayRun('r1');
    await persistence!.flushed();

    expect(putRun).toHaveBeenCalledTimes(1);
    expect(putRunMeta).toHaveBeenCalledTimes(1);
    expect((await archived()).runs[0]?.displayName).toBe('Base case');
  });

  it('does not write a kept run again while another run streams', async () => {
    const real = (await openResultsArchive(factory))!;
    const putRun = vi.fn(real.putRun);
    const putRunMeta = vi.fn(real.putRunMeta);
    await start(async () => ({ ...real, putRun, putRunMeta }));
    simulate('r1');
    finish('r1');
    simulate('r2');
    for (let i = 0; i < 5; i += 1) {
      useRunsStore.getState().appendFrame('r2', {
        t: new Float64Array([1 + i]),
        columns: { Bus_1_v: new Float64Array([1]) },
      });
    }
    await persistence!.flushed();
    expect(putRun).toHaveBeenCalledTimes(1);
    expect(putRunMeta).not.toHaveBeenCalled();
  });

  it('does not write back what it has just read', async () => {
    await start();
    simulate('r1');
    finish('r1');
    await persistence!.flushed();
    persistence!.stop();
    emptySlices();
    __resetResultsPersistenceForTests();

    const real = (await openResultsArchive(factory))!;
    const putRun = vi.fn(real.putRun);
    const deleteRun = vi.fn(real.deleteRun);
    await start(async () => ({ ...real, putRun, deleteRun }));
    await persistence!.flushed();

    expect(Object.keys(useRunsStore.getState().runs)).toEqual(['r1']);
    expect(putRun).not.toHaveBeenCalled();
    expect(deleteRun).not.toHaveBeenCalled();
    expect(isRunArchived('r1')).toBe(true);
  });

  it('deletes from the browser what Delete, Clear runs and the retention limit take', async () => {
    await start();
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      simulate(id);
      finish(id);
    }
    expect((await archived()).runs).toHaveLength(4);

    useRunsStore.getState().removeRun('r1');
    expect((await archived()).runs.map((r) => r.runId)).toEqual(['r2', 'r3', 'r4']);
    expect(isRunArchived('r1')).toBe(false);

    // Two runs may stay: the active one (r4) and the newest other.
    useRunsStore.getState().setRetentionLimit(2);
    expect((await archived()).runs.map((r) => r.runId)).toEqual(['r3', 'r4']);

    useRunsStore.getState().clearActiveRun();
    useRunsStore.getState().clearFinishedRuns();
    expect((await archived()).runs).toEqual([]);

    await reload();
    expect(useRunsStore.getState().runs).toEqual({});
  });

  it('empties the browser when the session is discarded', async () => {
    await start();
    simulate('r1');
    finish('r1');
    keepPf('pf-1');
    expect((await archived()).runs).toHaveLength(1);

    // What the cascade does when Change case discards the session.
    useRunsStore.getState().clearRuns();
    usePflowHistoryStore.getState().clear();

    const contents = await archived();
    expect(contents.runs).toEqual([]);
    expect(contents.pflow).toEqual([]);
  });

  it('keeps the retention limit, so a reload does not push kept runs out', async () => {
    await start();
    useRunsStore.getState().setRetentionLimit(12);
    simulate('r1');
    finish('r1');

    await reload();

    expect(useRunsStore.getState().retentionLimit).toBe(12);
  });

  it('writes what finished while the archive was still being opened', async () => {
    let release: (archive: ResultsArchive | null) => void = () => {};
    const opening = new Promise<ResultsArchive | null>((resolve) => (release = resolve));
    persistence = startResultsPersistence({ open: () => opening });
    simulate('r1');
    finish('r1');

    release(await openResultsArchive(factory));
    await persistence.ready;

    expect((await archived()).runs.map((r) => r.runId)).toEqual(['r1']);
  });

  it('puts kept runs in front of one that started before they were read', async () => {
    await start();
    simulate('old');
    finish('old');
    await persistence!.flushed();
    persistence!.stop();
    emptySlices();
    __resetResultsPersistenceForTests();

    let release: (archive: ResultsArchive | null) => void = () => {};
    const opening = new Promise<ResultsArchive | null>((resolve) => (release = resolve));
    persistence = startResultsPersistence({ open: () => opening });
    simulate('new');
    release(await openResultsArchive(factory));
    await persistence.ready;

    const { runs, activeRunId } = useRunsStore.getState();
    expect(Object.keys(runs)).toEqual(['old', 'new']);
    expect(activeRunId).toBe('new');
    // The counter is past the kept run's number, whatever the new run took.
    expect(useRunsStore.getState().runCount).toBeGreaterThanOrEqual(1);
  });
});

describe('results across a reload: power flows kept for comparison', () => {
  it('brings them back with their names and which two are compared', async () => {
    await start();
    keepPf('pf-1', 1.02);
    keepPf('pf-2', 0.99);
    keepPf('pf-3', 0.97);
    usePflowHistoryStore.getState().rename('pf-1', 'Base case');
    usePflowHistoryStore.getState().setBaseline('pf-1');

    await reload();

    const state = usePflowHistoryStore.getState();
    expect(state.snapshots.map((s) => [s.id, s.ordinal, s.name])).toEqual([
      ['pf-1', 1, 'Base case'],
      ['pf-2', 2, undefined],
      ['pf-3', 3, undefined],
    ]);
    expect(state.snapshots[2]?.result.bus_voltages).toEqual({ '1': 0.97 });
    expect(state.baselineId).toBe('pf-1');
    expect(state.comparedId).toBeNull();
    // The next one is numbered on from the ones kept.
    keepPf('pf-4');
    expect(usePflowHistoryStore.getState().snapshots.at(-1)?.ordinal).toBe(4);
  });

  it('deletes from the browser the one that is deleted or pushed out', async () => {
    await start();
    keepPf('pf-1');
    keepPf('pf-2');
    usePflowHistoryStore.getState().remove('pf-1');
    expect((await archived()).pflow.map((s) => s.id)).toEqual(['pf-2']);
  });

  it('writes a result once, and a rename writes that result alone', async () => {
    const real = (await openResultsArchive(factory))!;
    const putPflow = vi.fn(real.putPflow);
    await start(async () => ({ ...real, putPflow }));
    keepPf('pf-1');
    keepPf('pf-2');
    await persistence!.flushed();
    expect(putPflow).toHaveBeenCalledTimes(2);

    usePflowHistoryStore.getState().rename('pf-2', 'Line 5 out');
    usePflowHistoryStore.getState().setBaseline('pf-1');
    await persistence!.flushed();

    expect(putPflow).toHaveBeenCalledTimes(3);
    expect(putPflow.mock.calls[2]![0]).toMatchObject({ id: 'pf-2', name: 'Line 5 out' });
    expect((await archived()).pflowState).toEqual({
      count: 2,
      baselineId: 'pf-1',
      comparedId: null,
    });
  });
});

describe('results across a reload: what cannot be kept or read', () => {
  it('keeps nothing, and breaks nothing, where the browser has no IndexedDB', async () => {
    await start(async () => null);
    simulate('r1');
    finish('r1');
    keepPf('pf-1');
    await persistence!.flushed();

    expect(isRunArchived('r1')).toBe(false);
    expect(writeErrors).toEqual([]);
    expect(Object.keys(useRunsStore.getState().runs)).toEqual(['r1']);
  });

  it('survives an archive that cannot be opened at all', async () => {
    await start(async () => {
      throw new Error('blocked');
    });
    simulate('r1');
    finish('r1');
    expect(isRunArchived('r1')).toBe(false);
  });

  it('says so when a write fails, leaves the run unkept, and goes on with the next', async () => {
    const real = (await openResultsArchive(factory))!;
    let full = true;
    await start(async () => ({
      ...real,
      putRun: (run) =>
        full
          ? Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))
          : real.putRun(run),
    }));
    simulate('big');
    finish('big');
    await persistence!.flushed();

    expect(writeErrors).toHaveLength(1);
    expect((writeErrors[0] as DOMException).name).toBe('QuotaExceededError');
    expect(isRunArchived('big')).toBe(false);

    full = false;
    simulate('small');
    finish('small');
    await persistence!.flushed();

    expect(isRunArchived('small')).toBe(true);
    // The failed run is not tried again on every change of the store.
    expect(writeErrors).toHaveLength(1);
    expect((await archived()).runs.map((r) => r.runId)).toEqual(['small']);
  });

  it('deletes what another version of the app left that it cannot read', async () => {
    const real = (await openResultsArchive(factory))!;
    // A run record with no samples behind it.
    await real.putRunMeta(finishedRun('no-samples'));
    real.close();

    await start();

    expect(useRunsStore.getState().runs).toEqual({});
    expect((await archived()).staleRunIds).toEqual([]);
  });

  it('writes nothing more once it is stopped', async () => {
    await start();
    simulate('r1');
    finish('r1');
    await persistence!.flushed();
    persistence!.stop();

    simulate('r2');
    finish('r2');
    useRunsStore.getState().removeRun('r1');

    const archive = (await openResultsArchive(factory))!;
    expect((await archive.read()).runs.map((r) => r.runId)).toEqual(['r1']);
    archive.close();
    expect(isRunArchived('r1')).toBe(false);
  });
});

describe('results across a reload: the unload guard', () => {
  beforeEach(() => {
    useEditJournalStore.getState().reset();
    useSweepStore.getState().clearSweeps();
  });

  it('asks for a run until the browser has it, and not after', async () => {
    await start();
    simulate('r1');
    expect(unsavedWork().runs).toBe(true);
    finish('r1');
    // Finished, but the write has not landed yet.
    expect(unsavedWork().runs).toBe(true);

    await persistence!.flushed();

    expect(unsavedWork().runs).toBe(false);
  });

  it('goes on asking for a run the browser could not keep', async () => {
    const real = (await openResultsArchive(factory))!;
    await start(async () => ({
      ...real,
      putRun: () => Promise.reject(new Error('disk full')),
    }));
    simulate('r1');
    finish('r1');
    await persistence!.flushed();

    expect(unsavedWork().runs).toBe(true);
  });

  it('does not ask for runs that came back from the last visit', async () => {
    await start();
    simulate('r1');
    finish('r1');
    await reload();
    expect(unsavedWork().runs).toBe(false);
  });
});

describe('results across a reload: more than one tab on the archive', () => {
  beforeEach(() => {
    useEditJournalStore.getState().reset();
    useSweepStore.getState().clearSweeps();
  });

  it('tells the other tabs which run it deleted, once it is out of the browser', async () => {
    const other = otherTab();
    await start();
    simulate('r1');
    finish('r1');
    simulate('r2');
    finish('r2');
    await persistence!.flushed();
    // A run that is written is not news to anyone.
    expect(other.heard).toEqual([]);

    useRunsStore.getState().removeRun('r1');
    expect(other.heard).toEqual([]);
    await persistence!.flushed();

    expect(other.heard).toEqual([{ type: 'run-deleted', runId: 'r1' }]);
    expect((await archived()).runs.map((r) => r.runId)).toEqual(['r2']);
  });

  it('asks again for a run that another tab deleted, and does not write it back', async () => {
    const other = otherTab();
    await start();
    simulate('r1');
    finish('r1');
    await persistence!.flushed();
    expect(isRunArchived('r1')).toBe(true);
    expect(unsavedWork().runs).toBe(false);

    // The other tab took the run for its own when it loaded, and now clears its runs.
    await deleteInOtherTab(other, 'r1');

    // It is still listed here, and a reload would no longer bring it back.
    expect(useRunsStore.getState().runs.r1).toBeDefined();
    expect(isRunArchived('r1')).toBe(false);
    expect(unsavedWork().runs).toBe(true);

    // Nothing more of it is written, neither its samples nor a record without them.
    useRunsStore.getState().setRunDisplayName('r1', 'Base case');
    simulate('r2');
    finish('r2');
    const kept = await archived();
    expect(kept.runs.map((r) => r.runId)).toEqual(['r2']);
    expect(kept.staleRunIds).toEqual([]);
    expect(isRunArchived('r1')).toBe(false);
    expect(isRunArchived('r2')).toBe(true);

    // Deleting it here leaves nothing to delete, and nothing to tell.
    useRunsStore.getState().removeRun('r1');
    await persistence!.flushed();
    expect(other.heard).toEqual([]);
    expect(unsavedWork().runs).toBe(false);
    expect(writeErrors).toEqual([]);
  });

  it('does not count as kept a run another tab deletes while the archive is read', async () => {
    const other = otherTab();
    await start();
    simulate('r1');
    finish('r1');
    simulate('r2');
    finish('r2');
    await persistence!.flushed();
    persistence!.stop();
    emptySlices();
    __resetResultsPersistenceForTests();

    await start(async () => {
      const archive = (await openResultsArchive(factory))!;
      return {
        ...archive,
        read: async () => {
          const contents = await archive.read();
          // Between the read and what is done with it.
          await deleteInOtherTab(other, 'r1');
          return contents;
        },
      };
    });

    // Both were read, so both are listed; only one is still in the browser.
    expect(Object.keys(useRunsStore.getState().runs).sort()).toEqual(['r1', 'r2']);
    expect(isRunArchived('r1')).toBe(false);
    expect(isRunArchived('r2')).toBe(true);
    expect(unsavedWork().runs).toBe(true);
    expect((await archived()).runs.map((r) => r.runId)).toEqual(['r2']);
  });

  it('takes nothing else on the channel for a deletion', async () => {
    const other = otherTab();
    await start();
    simulate('r1');
    finish('r1');
    await persistence!.flushed();

    for (const message of [
      null,
      'run-deleted',
      { type: 'run-deleted' },
      { type: 'run-deleted', runId: 7 },
      { type: 'run-written', runId: 'r1' },
    ]) {
      (other.channel.post as (message: unknown) => void)(message);
    }

    expect(isRunArchived('r1')).toBe(true);
    expect(unsavedWork().runs).toBe(false);
  });

  it('keeps results the same way in a browser with no channel between tabs', async () => {
    await start(undefined, () => null);
    simulate('r1');
    finish('r1');
    simulate('r2');
    finish('r2');
    useRunsStore.getState().removeRun('r1');

    expect((await archived()).runs.map((r) => r.runId)).toEqual(['r2']);
    expect(isRunArchived('r2')).toBe(true);
    expect(writeErrors).toEqual([]);
  });

  it("speaks on the browser's own channel when it is given no other", async () => {
    persistence = startResultsPersistence({
      open: () => openResultsArchive(factory),
      onWriteError: (err) => writeErrors.push(err),
    });
    await persistence.ready;
    simulate('r1');
    finish('r1');
    simulate('r2');
    finish('r2');
    await persistence.flushed();
    expect(isRunArchived('r1')).toBe(true);

    const other = new BroadcastChannel(RESULTS_CHANNEL_NAME);
    try {
      const heard: unknown[] = [];
      other.onmessage = (event: MessageEvent<unknown>) => heard.push(event.data);

      other.postMessage({ type: 'run-deleted', runId: 'r1' });
      await vi.waitFor(() => expect(isRunArchived('r1')).toBe(false));

      useRunsStore.getState().removeRun('r2');
      await persistence.flushed();
      await vi.waitFor(() => expect(heard).toEqual([{ type: 'run-deleted', runId: 'r2' }]));
    } finally {
      other.close();
    }
  });
});
