/**
 * Tests for `frameOverlay.ts`: the pure helpers that derive the streaming
 * overlay from a TDS run record (`pickFrameIdx`, `getFrameBusOverlay`), and
 * the rAF hook the App root mounts (`useSldFrameOverlay`), shown to tick from
 * an App-like host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  getFrameBusOverlay,
  pickFrameIdx,
  useSldFrameOverlay,
} from '@/components/sld/frameOverlay';
import { parseRunId } from '@/api/types';
import type { RunRecord } from '@/store/runs';
import { useRunsStore } from '@/store/runs';
import { useAnimationStore } from '@/store/animation';
import * as plotModule from '@/store/plot';

/**
 * Build a synthetic RunRecord whose ``columns`` mimic the runs slice's
 * over-allocated typed arrays. The ``columnNames`` list is the
 * authoritative column set the frame-overlay walker iterates.
 */
function makeRun(options: {
  seqCount: number;
  t: number[];
  busColumns: Record<string, number[]>;
  extraColumns?: Record<string, number[]>;
  state?: RunRecord['state'];
}): RunRecord {
  const { seqCount, t, busColumns, extraColumns = {}, state = 'streaming' } = options;
  const columns: Record<string, Float64Array> = {};
  const columnNames: string[] = [];
  for (const [idx, values] of Object.entries(busColumns)) {
    const name = `Bus_${idx}_v`;
    columns[name] = new Float64Array(values);
    columnNames.push(name);
  }
  for (const [name, values] of Object.entries(extraColumns)) {
    columns[name] = new Float64Array(values);
    columnNames.push(name);
  }
  return {
    runId: 'run-test',
    startedAt: 0,
    tf: 10,
    tCurrent: t[t.length - 1] ?? 0,
    seqCount,
    t: new Float64Array(t),
    columns,
    columnNames,
    state,
    connection: 'connected',
    abortedLocally: false,
    errorReason: null,
  };
}

describe('pickFrameIdx', () => {
  it('returns -1 when seqCount is 0', () => {
    const run = makeRun({ seqCount: 0, t: [], busColumns: { '1': [] } });
    expect(pickFrameIdx(run, null)).toBe(-1);
    expect(pickFrameIdx(run, 1.5)).toBe(-1);
  });

  it('live mode (scrubT === null) → seqCount - 1', () => {
    const run = makeRun({
      seqCount: 5,
      t: [0, 0.5, 1, 1.5, 2],
      busColumns: { '1': [1, 1, 1, 1, 1] },
    });
    expect(pickFrameIdx(run, null)).toBe(4);
  });

  it('scrub mode picks the closest frame at-or-before the requested t', () => {
    const run = makeRun({
      seqCount: 5,
      t: [0, 0.5, 1, 1.5, 2],
      busColumns: { '1': [1, 1, 1, 1, 1] },
    });
    expect(pickFrameIdx(run, 1.0)).toBe(2);
    // 1.4 → frame at 1.0 (last <= 1.4 is index 2).
    expect(pickFrameIdx(run, 1.4)).toBe(2);
    // 1.5 lands exactly on frame 3.
    expect(pickFrameIdx(run, 1.5)).toBe(3);
  });

  it('returns the last frame when scrubT > t_max (run extended after seek)', () => {
    const run = makeRun({
      seqCount: 3,
      t: [0, 1, 2],
      busColumns: { '1': [1, 1, 1] },
    });
    // User scrubbed to t=5.0, but the run has only buffered up to t=2.
    expect(pickFrameIdx(run, 5.0)).toBe(2);
  });

  it('returns -1 when scrubT < t[0]', () => {
    const run = makeRun({
      seqCount: 3,
      t: [1, 2, 3],
      busColumns: { '1': [1, 1, 1] },
    });
    expect(pickFrameIdx(run, 0.5)).toBe(-1);
  });
});

describe('getFrameBusOverlay', () => {
  it('returns an empty map when frameIdx is -1 (no buffered frames yet)', () => {
    const run = makeRun({ seqCount: 0, t: [], busColumns: { '1': [] } });
    const overlay = getFrameBusOverlay(run, -1);
    expect(overlay.size).toBe(0);
  });

  it('extracts bus voltages from the chosen frame and classifies bands', () => {
    const run = makeRun({
      seqCount: 3,
      t: [0, 1, 2],
      busColumns: {
        '1': [1.0, 0.96, 0.92],
        '2': [1.0, 1.04, 1.08],
      },
    });
    // Frame 0: both buses at 1.0 → success.
    const f0 = getFrameBusOverlay(run, 0);
    expect(f0.get('1')?.band).toBe('success');
    expect(f0.get('1')?.voltage).toBe(1.0);
    expect(f0.get('2')?.band).toBe('success');

    // Frame 1: 0.96 + 1.04 → warning bands.
    const f1 = getFrameBusOverlay(run, 1);
    expect(f1.get('1')?.band).toBe('warning');
    expect(f1.get('2')?.band).toBe('warning');

    // Frame 2: 0.92 + 1.08 → danger bands.
    const f2 = getFrameBusOverlay(run, 2);
    expect(f2.get('1')?.band).toBe('danger');
    expect(f2.get('1')?.voltage).toBeCloseTo(0.92, 5);
    expect(f2.get('2')?.band).toBe('danger');
  });

  it('classifies each bus on its own limits and falls back to the default for a bus with none', () => {
    const run = makeRun({
      seqCount: 1,
      t: [0],
      busColumns: { '1': [1.07], '2': [1.07], '3': [1.07] },
    });
    const limits = new Map([
      ['1', { vmin: 0.9, vmax: 1.1 }],
      ['2', { vmin: 0.95, vmax: 1.06 }],
    ]);
    const overlay = getFrameBusOverlay(run, 0, limits);
    // Bus 1: inside its wide band. Bus 2: just past its upper limit.
    // Bus 3: not in the map, so the 0.95 / 1.05 default applies.
    expect(overlay.get('1')).toEqual({ band: 'success', side: null, voltage: 1.07 });
    expect(overlay.get('2')).toEqual({ band: 'danger', side: 'high', voltage: 1.07 });
    expect(overlay.get('3')).toEqual({ band: 'danger', side: 'high', voltage: 1.07 });
    // No map at all is the same as every bus on the default.
    expect(getFrameBusOverlay(run, 0).get('1')?.band).toBe('danger');
  });

  it('reports which limit a streamed voltage is near or past', () => {
    const run = makeRun({
      seqCount: 3,
      t: [0, 1, 2],
      busColumns: { '1': [1.0, 0.96, 1.08] },
    });
    expect(getFrameBusOverlay(run, 0).get('1')?.side).toBeNull();
    expect(getFrameBusOverlay(run, 1).get('1')).toMatchObject({ band: 'warning', side: 'low' });
    expect(getFrameBusOverlay(run, 2).get('1')).toMatchObject({ band: 'danger', side: 'high' });
  });

  it('skips non-bus_v columns (Gen_*, Line_*) when building the bus overlay', () => {
    const run = makeRun({
      seqCount: 2,
      t: [0, 1],
      busColumns: { '1': [1.0, 0.99] },
      extraColumns: {
        Gen_g1_omega: [1.0, 1.001],
        Line_l1_p: [50, 51],
        Line_l1_q: [10, 11],
      },
    });
    const overlay = getFrameBusOverlay(run, 1);
    // Only the bus column showed up.
    expect(overlay.size).toBe(1);
    expect(overlay.get('1')?.band).toBe('success');
    expect(overlay.has('g1')).toBe(false);
    expect(overlay.has('l1')).toBe(false);
  });

  it('ignores the bus angle columns that share the bus_v group', () => {
    const run = makeRun({
      seqCount: 2,
      t: [0, 1],
      busColumns: { '1': [1.0, 0.92] },
      extraColumns: { Bus_1_a: [0, -0.4], Bus_2_a: [0, -0.5] },
    });
    const overlay = getFrameBusOverlay(run, 1);
    expect(overlay.size).toBe(1);
    expect(overlay.get('1')).toEqual({ band: 'danger', side: 'low', voltage: 0.92 });
  });

  it("classifies a run's column names once, however often the overlay is read", () => {
    const run = makeRun({
      seqCount: 3,
      t: [0, 1, 2],
      busColumns: { '1': [1.0, 1.0, 0.92], '2': [1.0, 1.04, 1.08] },
      extraColumns: { Gen_g1_omega: [1, 1, 1], Line_l1_p: [50, 51, 52], Bus_1_a: [0, 0, 0] },
    });
    const parse = vi.spyOn(plotModule, 'parseColumnName');
    try {
      for (let i = 0; i < 20; i += 1) getFrameBusOverlay(run, i % 3);
      // The first read parsed each name once; the other 19 parsed nothing.
      expect(parse).toHaveBeenCalledTimes(run.columnNames.length);
    } finally {
      parse.mockRestore();
    }
  });

  it('keeps reading the right columns as the run grows, without parsing again', () => {
    // The runs slice replaces the record on every frame but keeps the one
    // ``columnNames`` array, and replaces a column's array when it grows.
    const run = makeRun({
      seqCount: 1,
      t: [0],
      busColumns: { '1': [1.0] },
      extraColumns: { Gen_g1_omega: [1] },
    });
    expect(getFrameBusOverlay(run, 0).get('1')?.band).toBe('success');
    const parse = vi.spyOn(plotModule, 'parseColumnName');
    try {
      const grown: RunRecord = {
        ...run,
        seqCount: 2,
        t: new Float64Array([0, 1]),
        columns: { ...run.columns, Bus_1_v: new Float64Array([1.0, 0.9]) },
      };
      expect(grown.columnNames).toBe(run.columnNames);
      expect(getFrameBusOverlay(grown, 1).get('1')).toEqual({
        band: 'danger',
        side: 'low',
        voltage: 0.9,
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("keeps each run's columns apart when two runs have different column lists", () => {
    const a = makeRun({ seqCount: 1, t: [0], busColumns: { '1': [0.9] } });
    const b = makeRun({ seqCount: 1, t: [0], busColumns: { '7': [1.0] } });
    expect(Array.from(getFrameBusOverlay(a, 0).keys())).toEqual(['1']);
    expect(Array.from(getFrameBusOverlay(b, 0).keys())).toEqual(['7']);
    expect(Array.from(getFrameBusOverlay(a, 0).keys())).toEqual(['1']);
  });

  it('does not over-read the over-allocated typed-array tail', () => {
    // Simulate a run whose typed arrays have capacity > seqCount (the
    // runs slice grows geometrically; the tail is uninitialised /
    // zero). A request for an out-of-range frame must NOT classify the
    // zero-tail value as 'danger' (which 0 < 0.95 would otherwise be).
    const t = new Float64Array(8);
    t.set([0, 0.5, 1.0]);
    const v = new Float64Array(8);
    v.set([1.0, 1.0, 0.99]);
    const run: RunRecord = {
      runId: 'r',
      startedAt: 0,
      tf: 10,
      tCurrent: 1.0,
      seqCount: 3,
      t,
      columns: { Bus_1_v: v },
      columnNames: ['Bus_1_v'],
      state: 'streaming',
      connection: 'connected',
      abortedLocally: false,
      errorReason: null,
    };
    // frameIdx >= seqCount → no extraction.
    const overlay = getFrameBusOverlay(run, 5);
    expect(overlay.size).toBe(0);
  });

  it('end-to-end happy path: scrubT = 1.5 → bus shows the closest-frame band', () => {
    const run = makeRun({
      seqCount: 5,
      t: [0, 0.5, 1.0, 1.5, 2.0],
      busColumns: { '1': [1.0, 1.0, 1.0, 0.96, 0.92] },
    });
    const idx = pickFrameIdx(run, 1.5);
    const overlay = getFrameBusOverlay(run, idx);
    expect(overlay.get('1')?.band).toBe('warning');
    expect(overlay.get('1')?.voltage).toBeCloseTo(0.96, 5);
  });

  it('end-to-end happy path: scrubT === null → bus shows the latest-frame band', () => {
    const run = makeRun({
      seqCount: 4,
      t: [0, 0.5, 1.0, 1.5],
      busColumns: { '1': [1.0, 1.0, 1.0, 0.92] },
    });
    const idx = pickFrameIdx(run, null);
    const overlay = getFrameBusOverlay(run, idx);
    expect(overlay.get('1')?.band).toBe('danger');
  });
});

describe('useSldFrameOverlay', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set() });
    useAnimationStore.getState().clearOverlayForRun('run-1');
  });

  function withQueryClient(ui: ReactNode) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // No JSX: this file is a .ts module (the helpers it covers are pure), so
    // the provider is built with createElement.
    return createElement(QueryClientProvider, { client }, ui);
  }

  /** The hook as the App root mounts it: once, inside the query provider. */
  function AppLikeHost() {
    useSldFrameOverlay();
    return null;
  }

  it('ticks from the App host: a streaming run writes the per-bus overlay into the animation store', async () => {
    // Drive the rAF loop by hand so the test does not wait on a real clock.
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      callbacks.delete(handle);
    });
    const step = () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const cb of pending) cb(0);
    };

    const run = {
      ...makeRun({
        seqCount: 2,
        t: [0, 0.5],
        busColumns: { '1': [1.0, 0.92] },
      }),
      runId: parseRunId('run-1'),
    };
    useRunsStore.setState({ runs: { 'run-1': run }, activeRunId: parseRunId('run-1') });

    render(withQueryClient(createElement(AppLikeHost)));
    act(step);
    await waitFor(() => {
      const overlay = useAnimationStore.getState().busOverlayByRun['run-1'];
      expect(overlay?.get('1')).toMatchObject({ band: 'danger', voltage: 0.92 });
    });

    // A later frame is picked up on the next tick.
    act(() => {
      useRunsStore.setState({
        runs: {
          'run-1': {
            ...run,
            seqCount: 3,
            t: new Float64Array([0, 0.5, 1]),
            columns: { Bus_1_v: new Float64Array([1.0, 0.92, 1.0]) },
          },
        },
      });
    });
    act(step);
    await waitFor(() => {
      const overlay = useAnimationStore.getState().busOverlayByRun['run-1'];
      expect(overlay?.get('1')).toMatchObject({ band: 'success', voltage: 1.0 });
    });
  });

  it('clears the overlay when the run finishes without a scrub', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      callbacks.delete(handle);
    });
    const step = () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const cb of pending) cb(0);
    };

    const run = {
      ...makeRun({ seqCount: 1, t: [0], busColumns: { '1': [0.92] } }),
      runId: parseRunId('run-1'),
    };
    useRunsStore.setState({ runs: { 'run-1': run }, activeRunId: parseRunId('run-1') });
    render(withQueryClient(createElement(AppLikeHost)));
    act(step);
    expect(useAnimationStore.getState().busOverlayByRun['run-1']?.size).toBe(1);

    act(() => {
      useRunsStore.setState({ runs: { 'run-1': { ...run, state: 'done' } } });
    });
    act(step);
    expect(useAnimationStore.getState().busOverlayByRun['run-1']).toBeUndefined();
  });
});
