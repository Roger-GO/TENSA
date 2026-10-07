/**
 * useAutoLayout — ELK runs when the graph's shape changes, not when the
 * topology object does, and not at all when a stored or curated layout
 * already places every bus. With no layout at all the diagram is arranged
 * around the buses ELK placed: the devices beside their bars and the
 * branches routed.
 *
 * `elkLayout` is stubbed with a layout that spreads the buses out, and
 * counted: a layout costs one call, since ELK places the buses and the
 * routes are made here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { useAutoLayout } from '@/components/sld/useAutoLayout';
import { elkLayout } from '@/components/sld/elkClient';
import { startTidy } from '@/components/sld/tidyClient';
import { GRID_STEP } from '@/components/sld/tidy';
import type { SidecarLayout, TopologyEntry, TopologySummary } from '@/api/types';

vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async (graph: ElkNode) => ({
    children: (graph.children ?? []).map((c, i) => ({ id: c.id, x: 203 * i, y: 187 * i })),
  })),
}));

vi.mock('@/components/sld/tidyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/sld/tidyClient')>();
  return { ...actual, startTidy: vi.fn(actual.startTidy) };
});

const PASSES_PER_LAYOUT = 1;

function bus(idx: number | string): TopologyEntry {
  return { idx, name: `b${idx}`, kind: 'Bus', params: {} };
}

function line(idx: number, bus1: number, bus2: number): TopologyEntry {
  return { idx, name: `l${idx}`, kind: 'Line', params: { bus1, bus2 } };
}

function topology(buses: TopologyEntry[], lines: TopologyEntry[]): TopologySummary {
  return { state: 'pre-setup', buses, lines, transformers: [], generators: [], loads: [] };
}

function sidecar(busIdxs: number[]): SidecarLayout {
  return {
    schema_version: '1',
    andes_version: '2.0.0',
    last_modified: '2026-01-01T00:00:00Z',
    coordinates: Object.fromEntries(busIdxs.map((i) => [String(i), { x: i, y: i }])),
    non_bus_coordinates: {},
  };
}

interface Props {
  topology: TopologySummary;
  base: SidecarLayout | null;
}

function render(initial: Props) {
  return renderHook((props: Props) => useAutoLayout(props.topology, props.base), {
    initialProps: initial,
  });
}

beforeEach(() => {
  vi.mocked(elkLayout).mockClear();
  vi.mocked(startTidy).mockClear();
});

describe('useAutoLayout', () => {
  it('arranges the whole diagram for a topology with no stored layout', async () => {
    const t: TopologySummary = {
      ...topology([bus(1), bus(2)], [line(1, 1, 2)]),
      loads: [{ idx: 'PQ_1', name: 'PQ 1', kind: 'PQ', params: { bus: 2 } }],
    };
    const { result } = render({ topology: t, base: null });
    expect(result.current).toMatchObject({ coords: null, arrangement: null, needed: true });
    await waitFor(() => expect(result.current.coords).not.toBeNull());
    const { coords, arrangement } = result.current;
    expect(Object.keys(coords ?? {}).sort()).toEqual(['1', '2']);
    // The buses stand on the grid, not where ELK left them.
    for (const at of Object.values(coords ?? {})) {
      expect(at.x % GRID_STEP).toBe(0);
      expect(at.y % GRID_STEP).toBe(0);
    }
    // The line has its route, for the places of its two buses, and the load its place.
    const [id] = [...(arrangement?.routes.keys() ?? [])];
    expect(arrangement?.routes.size).toBe(1);
    expect(arrangement?.routes.get(id!)?.length).toBeGreaterThanOrEqual(2);
    expect(arrangement?.anchors.get(id!)).toEqual({ source: coords?.['1'], target: coords?.['2'] });
    expect([...(arrangement?.devices.keys() ?? [])]).toEqual(['PQ|PQ_1']);
    expect(elkLayout).toHaveBeenCalledTimes(PASSES_PER_LAYOUT);
  });

  it('still opens the diagram where ELK put the buses when arranging it fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(startTidy).mockImplementationOnce(() => ({
      done: Promise.reject(new Error('worker lost')),
      cancel: () => {},
    }));
    const t = topology([bus(1), bus(2)], [line(1, 1, 2)]);
    const { result } = render({ topology: t, base: null });
    await waitFor(() => expect(result.current.coords).not.toBeNull());
    expect(result.current.coords).toEqual({ '1': { x: 0, y: 0 }, '2': { x: 203, y: 187 } });
    expect(result.current.arrangement).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'SLD auto-layout: arranging the diagram failed',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('calls the arranging off when the diagram goes before it is done', async () => {
    const cancel = vi.fn();
    vi.mocked(startTidy).mockImplementationOnce(() => ({
      done: new Promise(() => {}),
      cancel,
    }));
    const t = topology([bus(1), bus(2)], [line(1, 1, 2)]);
    const { unmount } = render({ topology: t, base: null });
    await waitFor(() => expect(startTidy).toHaveBeenCalled());
    expect(cancel).not.toHaveBeenCalled();
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not lay out again for a new topology object of the same shape', async () => {
    const first = topology([bus(1), bus(2)], [line(1, 1, 2)]);
    const { result, rerender } = render({ topology: first, base: null });
    await waitFor(() => expect(result.current.coords).not.toBeNull());
    const coords = result.current.coords;
    const arrangement = result.current.arrangement;

    // What a power-flow run or a parameter edit produces: a new object with
    // another state and other numbers, the same buses and branch terminals.
    const refetched: TopologySummary = {
      ...topology(
        [
          { ...bus(1), params: { v: 1.04 } },
          { ...bus(2), params: { v: 1.01 } },
        ],
        [{ ...line(1, 1, 2), params: { bus1: 1, bus2: 2, x: 0.2 } }],
      ),
      state: 'committed',
    };
    rerender({ topology: refetched, base: null });
    rerender({ topology: { ...refetched }, base: null });

    // The result stays available the whole time: no flash back to "computing".
    expect(result.current.coords).toBe(coords);
    expect(result.current.arrangement).toBe(arrangement);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(elkLayout).toHaveBeenCalledTimes(PASSES_PER_LAYOUT);
  });

  it('lays out again when a bus is added, and withholds the old coords meanwhile', async () => {
    const first = topology([bus(1), bus(2)], [line(1, 1, 2)]);
    const { result, rerender } = render({ topology: first, base: null });
    await waitFor(() => expect(result.current.coords).not.toBeNull());

    rerender({ topology: topology([bus(1), bus(2), bus(3)], [line(1, 1, 2)]), base: null });
    expect(result.current.coords).toBeNull();
    expect(result.current.needed).toBe(true);
    await waitFor(() => expect(result.current.coords).not.toBeNull());
    expect(Object.keys(result.current.coords ?? {}).sort()).toEqual(['1', '2', '3']);
    expect(elkLayout).toHaveBeenCalledTimes(2 * PASSES_PER_LAYOUT);
  });

  it('lays out again when a branch is rewired', async () => {
    const first = topology([bus(1), bus(2), bus(3)], [line(1, 1, 2)]);
    const { result, rerender } = render({ topology: first, base: null });
    await waitFor(() => expect(result.current.coords).not.toBeNull());

    rerender({ topology: topology([bus(1), bus(2), bus(3)], [line(1, 1, 3)]), base: null });
    await waitFor(() => expect(elkLayout).toHaveBeenCalledTimes(2 * PASSES_PER_LAYOUT));
  });

  it('never calls ELK when the stored layout covers every bus', async () => {
    const t = topology([bus(1), bus(2)], [line(1, 1, 2)]);
    const { result, rerender } = render({ topology: t, base: sidecar([1, 2]) });
    expect(result.current).toEqual({ coords: null, arrangement: null, needed: false });
    rerender({ topology: { ...t, state: 'committed' }, base: sidecar([1, 2]) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.needed).toBe(false);
    expect(elkLayout).not.toHaveBeenCalled();
  });

  it('still covers the buses when the stored layout has extra ones', () => {
    const t = topology([bus(1)], []);
    const { result } = render({ topology: t, base: sidecar([1, 2, 3]) });
    expect(result.current.needed).toBe(false);
    expect(elkLayout).not.toHaveBeenCalled();
  });

  it('lays out when the stored layout misses a bus, and arranges nothing else', async () => {
    const t = topology([bus(1), bus(2), bus(3)], [line(1, 1, 2)]);
    const { result } = render({ topology: t, base: sidecar([1, 2]) });
    expect(result.current.needed).toBe(true);
    await waitFor(() => expect(result.current.coords).not.toBeNull());
    expect(result.current.coords?.['3']).toBeDefined();
    // The layout places the rest itself: only the coordinates are read.
    expect(result.current.arrangement).toBeNull();
    expect(startTidy).not.toHaveBeenCalled();
  });

  it('lays out once a bus the stored layout lacks is added', async () => {
    const stored = sidecar([1, 2]);
    const { result, rerender } = render({
      topology: topology([bus(1), bus(2)], [line(1, 1, 2)]),
      base: stored,
    });
    expect(result.current.needed).toBe(false);

    rerender({ topology: topology([bus(1), bus(2), bus(3)], [line(1, 1, 2)]), base: stored });
    expect(result.current.needed).toBe(true);
    await waitFor(() => expect(result.current.coords).not.toBeNull());
    expect(elkLayout).toHaveBeenCalledTimes(PASSES_PER_LAYOUT);
  });

  it('stops needing ELK once a layout covering every bus appears', async () => {
    const t = topology([bus(1), bus(2)], [line(1, 1, 2)]);
    const { result, rerender } = render({ topology: t, base: null });
    await waitFor(() => expect(result.current.coords).not.toBeNull());

    // The first drag saves a sidecar that covers every bus.
    rerender({ topology: t, base: sidecar([1, 2]) });
    expect(result.current).toEqual({ coords: null, arrangement: null, needed: false });
    expect(elkLayout).toHaveBeenCalledTimes(PASSES_PER_LAYOUT);
  });

  it('ignores a layout that finishes after the shape has changed', async () => {
    let releaseFirst: () => void = () => {};
    vi.mocked(elkLayout).mockImplementationOnce(
      (graph: ElkNode) =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              id: 'root',
              children: (graph.children ?? []).map((c) => ({ id: c.id, x: 1, y: 1 })),
            });
        }),
    );
    const { result, rerender } = render({ topology: topology([bus(1)], []), base: null });
    rerender({ topology: topology([bus(1), bus(2)], []), base: null });
    await waitFor(() => expect(result.current.coords).not.toBeNull());
    expect(Object.keys(result.current.coords ?? {}).sort()).toEqual(['1', '2']);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Object.keys(result.current.coords ?? {}).sort()).toEqual(['1', '2']);
  });
});
