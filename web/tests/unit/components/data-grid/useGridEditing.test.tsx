/**
 * Tests for ``useGridEditing``: which route a table's edits take, when they are
 * locked, how they are sent (one request per device, one after another), and what
 * the table is told back.
 *
 * The API client is stubbed, so each test reads the requests that went out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProblemDetailsError } from '@/api/client';
import { parseSessionId } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import type { CellEdit, ColumnConfig, GridEditing } from '@/components/data-grid/DataGrid';
import { cellKey } from '@/components/data-grid/gridCells';
import { useGridEditing, type GridEditTarget } from '@/components/data-grid/useGridEditing';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { renderWithQuery } from '../../helpers/gridQuery';
import { queryKeys } from '@/api/queries';
import { useQuery } from '@tanstack/react-query';

const client = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, andesClient: client };
});

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

interface Row {
  id: string;
  model: string;
}

const TARGET: GridEditTarget<Row> = { model: (r) => r.model, idx: (r) => r.id };
const CONTROLLER_TARGET: GridEditTarget<Row> = { ...TARGET, controllers: true };

let latest: GridEditing<Row>;

function Harness({ target }: { target: GridEditTarget<Row> }) {
  latest = useGridEditing(target);
  return <>{latest.barExtra}</>;
}

function column(param: string, withEdit = true): ColumnConfig<Row> {
  return {
    key: param,
    label: param,
    accessor: () => null,
    ...(withEdit ? { edit: { param } } : {}),
  };
}

function edit(row: Row, param: string, value: number): CellEdit<Row> {
  return { rowId: row.id, row, column: column(param), value };
}

const BUS1: Row = { id: '1', model: 'Bus' };
const BUS2: Row = { id: '2', model: 'Bus' };
const GENROU: Row = { id: 'G1', model: 'GENROU' };
const EXCITER: Row = { id: 'E1', model: 'IEEEX1' };

function topology(state: 'pre-setup' | 'committed'): TopologySummary {
  return { state, buses: [], lines: [], transformers: [], generators: [], loads: [] };
}

/** The `PUT` requests sent so far, as `[path, body]`. */
function puts(): [string, unknown][] {
  return client.put.mock.calls.map((call) => [
    call[0] as string,
    (call[1] as { body: unknown }).body,
  ]);
}

function mount(target: GridEditTarget<Row> = TARGET) {
  return renderWithQuery(<Harness target={target} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTopology = topology('pre-setup');
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({ editMode: 'run' });
  usePflowStore.setState({ isRunning: false });
  useRunsStore.setState({ runs: {} });
  client.put.mockImplementation(async (path: string) => {
    if (path.includes('/case/clone/')) {
      return {
        model: 'IEEEX1',
        idx: 'E1',
        param: 'KA',
        new_value: 1,
        undo_depth: 1,
        redo_depth: 0,
      };
    }
    return { idx: '1', name: 'x', kind: 'Bus', params: {} };
  });
  client.post.mockResolvedValue(topology('pre-setup'));
});

afterEach(() => {
  cleanup();
  mockTopology = null;
  useCaseStore.setState({ editMode: 'run' });
  useRunsStore.setState({ runs: {} });
});

describe('useGridEditing: what can be edited', () => {
  it('opens a column with an edit to a model that has the parameter, as a number', () => {
    mount();
    expect(latest.canEdit(BUS1, column('vmin'))).toBe(true);
    // No `edit` on the column: a result.
    expect(latest.canEdit(BUS1, column('vmin', false))).toBe(false);
    // The model has no such parameter: p0 is a static generator's, not a machine's.
    expect(latest.canEdit(GENROU, column('p0'))).toBe(false);
    // A parameter that is no number (a link to a bus) is not offered.
    expect(latest.canEdit(GENROU, column('bus'))).toBe(false);
    // A model the schema does not know.
    expect(latest.canEdit({ id: 'x', model: 'Nothing' }, column('vmin'))).toBe(false);
  });

  it('says how to edit while the case has not been run', () => {
    mount();
    expect(latest.lockedReason).toBeNull();
    expect(latest.hint).toMatch(/Double-click a value to change it/);
    expect(latest.barExtra).toBeUndefined();
  });
});

describe('useGridEditing: writing before a run', () => {
  it('sends the cells of one device as one request, so a set of reactances is judged as a set', async () => {
    mount();
    let result;
    await act(async () => {
      result = await latest.commit([
        edit(GENROU, 'xd1', 0.2),
        edit(GENROU, 'xd2', 0.15),
        edit(GENROU, 'D', 2),
      ]);
    });
    expect(puts()).toEqual([
      ['/sessions/s1/elements/GENROU/G1', { params: { xd1: 0.2, xd2: 0.15, D: 2 } }],
    ]);
    expect(result).toEqual({ applied: 3, failed: false });
    expect(latest.error).toBeNull();
  });

  it('sends one request per device, in the order given', async () => {
    mount();
    await act(async () => {
      await latest.commit([
        edit(BUS2, 'vmin', 0.9),
        edit(BUS1, 'vmin', 0.91),
        edit(BUS2, 'vmax', 1.1),
      ]);
    });
    expect(puts()).toEqual([
      ['/sessions/s1/elements/Bus/2', { params: { vmin: 0.9, vmax: 1.1 } }],
      ['/sessions/s1/elements/Bus/1', { params: { vmin: 0.91 } }],
    ]);
  });

  it('writes the parameter of the column, not its key', async () => {
    mount();
    const shown: ColumnConfig<Row> = {
      key: 'v_limit_low',
      label: 'vmin',
      accessor: () => null,
      edit: { param: 'vmin' },
    };
    await act(async () => {
      await latest.commit([{ rowId: '1', row: BUS1, column: shown, value: 0.9 }]);
    });
    expect(puts()).toEqual([['/sessions/s1/elements/Bus/1', { params: { vmin: 0.9 } }]]);
  });

  it('keeps the cells pending until the topology has been read again, so they show what was written', async () => {
    let releaseRead: () => void = () => undefined;
    client.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve(topology('pre-setup'));
        }),
    );
    // The table's own read of the topology, which a write marks stale.
    function WithTopology() {
      useQuery({
        queryKey: queryKeys.topology(parseSessionId('s1')),
        queryFn: () => client.get('/sessions/s1/topology'),
        staleTime: Infinity,
        initialData: topology('pre-setup'),
      });
      return <Harness target={TARGET} />;
    }
    renderWithQuery(<WithTopology />);
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = latest.commit([edit(BUS1, 'vmin', 0.9)]);
    });
    await act(async () => {
      await vi.waitFor(() => expect(client.get).toHaveBeenCalledTimes(1));
    });
    // The write is in; the read that follows is still out.
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(latest.pending.has(cellKey('1', 'vmin'))).toBe(true);
    await act(async () => {
      releaseRead();
      await done;
    });
    expect(latest.pending.size).toBe(0);
  });

  it('marks the cells as pending while they are written, and not after', async () => {
    const releases: Array<() => void> = [];
    client.put.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ idx: '1', name: 'x', kind: 'Bus', params: {} }));
        }),
    );
    mount();
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = latest.commit([edit(BUS1, 'vmin', 0.9), edit(BUS2, 'vmin', 0.9)]);
    });
    // Both cells are marked as soon as the write is asked for, the second
    // before its request has even gone out.
    expect(latest.pending.has(cellKey('1', 'vmin'))).toBe(true);
    expect(latest.pending.has(cellKey('2', 'vmin'))).toBe(true);
    await act(async () => {
      await vi.waitFor(() => expect(releases).toHaveLength(1));
    });
    await act(async () => {
      releases[0]?.();
      await act(async () => {
        await vi.waitFor(() => expect(releases).toHaveLength(2));
      });
    });
    expect(latest.pending.size).toBe(2);
    await act(async () => {
      releases[1]?.();
      await done;
    });
    expect(latest.pending.size).toBe(0);
  });

  it('writes one request after another, since the server holds one per session', async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    client.put.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          order.push(`start ${path}`);
          releases.push(() => {
            order.push(`end ${path}`);
            resolve({ idx: '1', name: 'x', kind: 'Bus', params: {} });
          });
        }),
    );
    mount();
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = latest.commit([edit(BUS1, 'vmin', 0.9)]);
      second = latest.commit([edit(BUS2, 'vmin', 0.9)]);
    });
    await act(async () => {
      await vi.waitFor(() => expect(releases).toHaveLength(1));
    });
    expect(order).toEqual(['start /sessions/s1/elements/Bus/1']);
    await act(async () => {
      releases[0]?.();
      await first;
    });
    await act(async () => {
      await vi.waitFor(() => expect(releases).toHaveLength(2));
    });
    await act(async () => {
      releases[1]?.();
      await second;
    });
    expect(order).toEqual([
      'start /sessions/s1/elements/Bus/1',
      'end /sessions/s1/elements/Bus/1',
      'start /sessions/s1/elements/Bus/2',
      'end /sessions/s1/elements/Bus/2',
    ]);
  });

  it('says what the server refused and stops, saying how many were written before it', async () => {
    client.put.mockImplementation(async (path: string) => {
      if (path.endsWith('/Bus/2')) {
        throw new ProblemDetailsError({
          title: 'Unprocessable',
          status: 422,
          detail: 'vmin is above vmax',
        } as never);
      }
      return { idx: '1', name: 'x', kind: 'Bus', params: {} };
    });
    mount();
    let result;
    await act(async () => {
      result = await latest.commit([
        edit(BUS1, 'vmin', 0.9),
        edit(BUS2, 'vmin', 2),
        edit({ id: '3', model: 'Bus' }, 'vmin', 0.9),
      ]);
    });
    expect(result).toEqual({ applied: 1, failed: true });
    // The third device was never tried.
    expect(client.put).toHaveBeenCalledTimes(2);
    expect(latest.error).toBe(
      'Could not set vmin of Bus 2. vmin is above vmax. 1 of 3 values were written before it.',
    );
    expect(latest.pending.size).toBe(0);
  });

  it('names the cell alone when one value is refused, and clears the error on dismiss and on the next write', async () => {
    client.put.mockRejectedValueOnce(new Error('network down'));
    mount();
    await act(async () => {
      await latest.commit([edit(BUS1, 'vmin', 0.9)]);
    });
    expect(latest.error).toBe('Could not set vmin of Bus 1. network down.');
    act(() => latest.dismissError());
    expect(latest.error).toBeNull();

    client.put.mockRejectedValueOnce(new Error('again'));
    await act(async () => {
      await latest.commit([edit(BUS1, 'vmin', 0.9)]);
    });
    expect(latest.error).not.toBeNull();
    await act(async () => {
      await latest.commit([edit(BUS1, 'vmin', 0.9)]);
    });
    expect(latest.error).toBeNull();
  });

  it('is not stopped by an earlier write that failed', async () => {
    client.put.mockRejectedValueOnce(new Error('boom'));
    mount();
    await act(async () => {
      const first = latest.commit([edit(BUS1, 'vmin', 0.9)]);
      const second = latest.commit([edit(BUS2, 'vmin', 0.9)]);
      await Promise.all([first, second]);
    });
    expect(client.put).toHaveBeenCalledTimes(2);
  });
});

describe('useGridEditing: after a run', () => {
  beforeEach(() => {
    mockTopology = topology('committed');
  });

  it('locks every cell, says why, and offers Reset run', async () => {
    const user = userEvent.setup();
    mount();
    expect(latest.canEdit(BUS1, column('vmin'))).toBe(false);
    expect(latest.lockedReason).toMatch(/The case is set up for a run/);
    expect(latest.hint).toBe(latest.lockedReason);
    const reset = screen.getByTestId('grid-reset-run');
    expect(reset).toHaveTextContent('Reset run');
    await user.click(reset);
    expect(client.post).toHaveBeenCalledWith('/sessions/s1/reload', expect.anything());
  });

  it('writes nothing, and says so', async () => {
    mount();
    let result;
    await act(async () => {
      result = await latest.commit([edit(BUS1, 'vmin', 0.9)]);
    });
    expect(client.put).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: 0, failed: true });
    expect(latest.error).toMatch(/cannot be changed now/);
  });

  it('is locked while a power flow runs or a run streams, whatever the state', () => {
    mockTopology = topology('pre-setup');
    usePflowStore.setState({ isRunning: true });
    const { unmount } = mount();
    expect(latest.canEdit(BUS1, column('vmin'))).toBe(false);
    expect(latest.lockedReason).toMatch(/power flow is running/);
    expect(screen.queryByTestId('grid-reset-run')).not.toBeInTheDocument();
    unmount();

    usePflowStore.setState({ isRunning: false });
    useRunsStore.setState({ runs: { r1: { state: 'streaming' } } as never });
    mount();
    expect(latest.canEdit(BUS1, column('vmin'))).toBe(false);
    expect(latest.lockedReason).toMatch(/run is streaming/);
  });

  it('has nothing to say before a case is loaded', () => {
    mockTopology = null;
    mount();
    expect(latest.canEdit(BUS1, column('vmin'))).toBe(false);
    expect(latest.lockedReason).toBeNull();
    expect(latest.hint).toBeUndefined();
  });
});

describe('useGridEditing: controllers', () => {
  it('writes to the System in memory before a run, as any other device, with the Edit mode switch in the bar', async () => {
    mount(CONTROLLER_TARGET);
    expect(screen.getByTestId('edit-mode-toggle')).toBeInTheDocument();
    expect(latest.hint).toMatch(/Edit mode keeps controller changes through a run/);
    await act(async () => {
      await latest.commit([edit(EXCITER, 'KA', 50)]);
    });
    expect(puts()).toEqual([['/sessions/s1/elements/IEEEX1/E1', { params: { KA: 50 } }]]);
  });

  it('writes to a copy of the case file in Edit mode, one request per value, run or not', async () => {
    mockTopology = topology('committed');
    useCaseStore.setState({ editMode: 'edit' });
    mount(CONTROLLER_TARGET);
    expect(latest.canEdit(EXCITER, column('KA'))).toBe(true);
    expect(latest.lockedReason).toBeNull();
    expect(latest.hint).toMatch(/Edit mode: double-click a value/);
    // Setting the case up again shows its values on the system base.
    expect(latest.hint).toMatch(/shown on the system base/);
    let result;
    await act(async () => {
      result = await latest.commit([edit(EXCITER, 'KA', 50), edit(EXCITER, 'TA', 0.1)]);
    });
    expect(puts()).toEqual([
      ['/sessions/s1/case/clone/params/IEEEX1/E1/KA', { value: 50 }],
      ['/sessions/s1/case/clone/params/IEEEX1/E1/TA', { value: 0.1 }],
    ]);
    expect(result).toEqual({ applied: 2, failed: false });
    // The reset button is for a locked table, and this one is not.
    expect(screen.queryByTestId('grid-reset-run')).not.toBeInTheDocument();
  });

  it('is locked after a run outside Edit mode, and says how to unlock it both ways', () => {
    mockTopology = topology('committed');
    mount(CONTROLLER_TARGET);
    expect(latest.canEdit(EXCITER, column('KA'))).toBe(false);
    expect(latest.lockedReason).toMatch(/Turn on Edit mode/);
    expect(screen.getByTestId('edit-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('grid-reset-run')).toBeInTheDocument();
  });

  it('never writes anything but a controller to a copy of the file', async () => {
    useCaseStore.setState({ editMode: 'edit' });
    mount(TARGET);
    await act(async () => {
      await latest.commit([edit(BUS1, 'vmin', 0.9)]);
    });
    expect(puts()).toEqual([['/sessions/s1/elements/Bus/1', { params: { vmin: 0.9 } }]]);
  });
});
