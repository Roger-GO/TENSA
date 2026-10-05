/**
 * The five element tables (Buses, Lines, Generators, Loads, Shunts) as tables
 * whose values can be changed: which cells, which request each sends and in which
 * unit, what a locked table says, the filter and a paste.
 *
 * The API client is stubbed, so each test reads the requests that went out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useSldStore } from '@/store/sld';
import { useUnitsStore } from '@/store/units';
import { renderWithQuery as render } from '../../helpers/gridQuery';

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

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { BusesGrid } from '@/components/data-grid/BusesGrid';
import { GeneratorsGrid } from '@/components/data-grid/GeneratorsGrid';
import { LinesGrid } from '@/components/data-grid/LinesGrid';
import { LoadsGrid } from '@/components/data-grid/LoadsGrid';
import { ShuntsGrid } from '@/components/data-grid/ShuntsGrid';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    {
      idx: 1,
      name: 'Bus1',
      kind: 'Bus',
      params: { Vn: 230, vmin: 0.9, vmax: 1.1, area: 1, zone: 1 },
    },
    {
      idx: 2,
      name: 'Bus2',
      kind: 'Bus',
      params: { Vn: 115, vmin: 0.95, vmax: 1.05, area: 1, zone: 2 },
    },
  ],
  lines: [
    {
      idx: 'L1',
      name: 'Line1-2',
      kind: 'Line',
      params: { bus1: 1, bus2: 2, r: 0.01, x: 0.1, b: 0.02, u: 1, rate_a: 100 },
    },
    // No rating: rate_a is 0.
    {
      idx: 'L2',
      name: 'Line2-3',
      kind: 'Line',
      params: { bus1: 2, bus2: 3, r: 0.02, x: 0.2, b: 0.04, u: 1, rate_a: 0 },
    },
  ],
  transformers: [],
  generators: [
    { idx: 1, name: 'PV_1', kind: 'PV', params: { bus: 1, p0: 0.4, v0: 1.02 } },
    { idx: 2, name: 'Slack_2', kind: 'Slack', params: { bus: 2, p0: 0.7, v0: 1.04 } },
    { idx: 'G1', name: 'GENROU_1', kind: 'GENROU', params: { bus: 1, gen: 1, M: 13 } },
  ],
  loads: [
    { idx: 'PQ_1', name: 'PQ_1', kind: 'PQ', params: { bus: 1, p0: 0.5, q0: 0.1 } },
    { idx: 'Z_1', name: 'Z_1', kind: 'ZIP', params: { bus: 2, p0: 0.3, q0: 0.05 } },
  ],
  shunts: [{ idx: 'S1', name: 'S1', kind: 'Shunt', params: { bus: 2, b: 0.19, g: 0 } }],
};

function cell(grid: string, rowId: string, key: string): HTMLElement {
  return screen.getByTestId(`${grid}-grid-cell-${rowId}-${key}`);
}

function visibleRowIds(grid: string): string[] {
  return screen
    .getAllByRole('row')
    .map((r) => r.getAttribute('data-testid'))
    .filter((id): id is string => id !== null && id.startsWith(`${grid}-grid-row-`))
    .map((id) => id.replace(`${grid}-grid-row-`, ''));
}

/** The `PUT` requests sent so far, as `[path, body]`. */
function puts(): [string, unknown][] {
  return client.put.mock.calls.map((call) => [
    call[0] as string,
    (call[1] as { body: unknown }).body,
  ]);
}

async function typeInto(
  user: ReturnType<typeof userEvent.setup>,
  target: HTMLElement,
  text: string,
) {
  await user.dblClick(target);
  await user.keyboard(`${text}{Enter}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTopology = TOPOLOGY;
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    selectedElement: null,
    editMode: 'run',
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {} });
  useSldStore.setState({ selectedNodeId: null });
  useUnitsStore.setState({ mode: 'pu' });
  client.put.mockResolvedValue({ idx: '1', name: 'x', kind: 'Bus', params: {} });
  client.post.mockResolvedValue({ ...TOPOLOGY, state: 'pre-setup' });
});

afterEach(() => {
  cleanup();
  mockTopology = null;
  useUnitsStore.setState({ mode: 'pu' });
});

describe('<BusesGrid /> editing', () => {
  it("opens the case's own values to editing and leaves the results alone", () => {
    render(<BusesGrid />);
    for (const key of ['vn', 'vmin', 'vmax', 'area', 'zone']) {
      expect(cell('buses', '1', key)).toHaveAttribute('data-editable', 'true');
    }
    for (const key of ['idx', 'name', 'v', 'limit_check', 'theta', 'p_inj', 'q_inj']) {
      expect(cell('buses', '1', key)).not.toHaveAttribute('data-editable');
    }
  });

  it('says how to edit, and offers the filter, Copy and Export', () => {
    render(<BusesGrid />);
    expect(screen.getByTestId('buses-grid-hint')).toHaveTextContent(
      'Double-click a value to change it, or paste values copied from a spreadsheet.',
    );
    expect(screen.getByTestId('buses-grid-filter')).toBeInTheDocument();
    expect(screen.getByTestId('buses-grid-copy')).toBeInTheDocument();
    expect(screen.getByTestId('export-menu-trigger')).toBeInTheDocument();
  });

  it('writes a typed limit to the bus, as the number typed', async () => {
    const user = userEvent.setup();
    render(<BusesGrid />);
    await typeInto(user, cell('buses', '1', 'vmax'), '1.08');
    expect(puts()).toEqual([['/sessions/s1/elements/Bus/1', { params: { vmax: 1.08 } }]]);
  });

  it('writes a limit typed in kV per unit on the rated voltage of its own bus', async () => {
    const user = userEvent.setup();
    useUnitsStore.setState({ mode: 'actual' });
    render(<BusesGrid />);
    // Bus 2 is 115 kV: 120.75 kV is 1.05 pu. Bus 1 is 230 kV: 207 kV is 0.9 pu.
    expect(cell('buses', '2', 'vmax')).toHaveTextContent('120.75');
    await typeInto(user, cell('buses', '2', 'vmax'), '126.5');
    await typeInto(user, cell('buses', '1', 'vmin'), '218.5');
    const [first, second] = puts().map(([, body]) => body as { params: Record<string, number> });
    expect(first?.params.vmax).toBeCloseTo(1.1, 10);
    expect(second?.params.vmin).toBeCloseTo(0.95, 10);
  });

  it('writes the rated voltage, area and zone', async () => {
    const user = userEvent.setup();
    render(<BusesGrid />);
    await typeInto(user, cell('buses', '1', 'vn'), '220');
    await typeInto(user, cell('buses', '2', 'zone'), '3');
    expect(puts()).toEqual([
      ['/sessions/s1/elements/Bus/1', { params: { Vn: 220 } }],
      ['/sessions/s1/elements/Bus/2', { params: { zone: 3 } }],
    ]);
  });

  it('shows why a value was refused, under the bar', async () => {
    const user = userEvent.setup();
    const { ProblemDetailsError } = await import('@/api/client');
    client.put.mockRejectedValueOnce(
      new ProblemDetailsError({
        title: 'Unprocessable',
        status: 422,
        detail: 'no such bus',
      } as never),
    );
    render(<BusesGrid />);
    await typeInto(user, cell('buses', '1', 'vmax'), '1.08');
    expect(await screen.findByTestId('buses-grid-edit-error')).toHaveTextContent(
      'Could not set vmax of Bus 1. no such bus.',
    );
  });

  it('pastes a column of limits from a spreadsheet, a request per bus', async () => {
    const user = userEvent.setup();
    render(<BusesGrid />);
    await user.click(cell('buses', '1', 'vmin'));
    fireEvent.paste(screen.getByTestId('buses-grid'), {
      clipboardData: { getData: () => '0.92\t1.07\n0.96\t1.04\n' },
    });
    await waitFor(() => expect(client.put).toHaveBeenCalledTimes(2));
    expect(puts()).toEqual([
      ['/sessions/s1/elements/Bus/1', { params: { vmin: 0.92, vmax: 1.07 } }],
      ['/sessions/s1/elements/Bus/2', { params: { vmin: 0.96, vmax: 1.04 } }],
    ]);
  });

  it('filters the rows by any cell', async () => {
    const user = userEvent.setup();
    render(<BusesGrid />);
    await user.type(screen.getByTestId('buses-grid-filter'), '115');
    expect(visibleRowIds('buses')).toEqual(['2']);
  });

  it('keeps the grid free of editing before a case is loaded', () => {
    mockTopology = null;
    render(<BusesGrid />);
    expect(screen.queryByTestId('buses-grid-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('buses-grid-empty')).toBeInTheDocument();
  });
});

describe('a table once a run has locked the case', () => {
  beforeEach(() => {
    mockTopology = { ...TOPOLOGY, state: 'committed' };
  });

  it('opens no cell, says why, and resets the run from the bar', async () => {
    const user = userEvent.setup();
    render(<BusesGrid />);
    expect(cell('buses', '1', 'vmax')).not.toHaveAttribute('data-editable');
    await user.dblClick(cell('buses', '1', 'vmax'));
    expect(screen.queryByTestId('buses-grid-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('buses-grid-hint')).toHaveTextContent('The case is set up for a run');
    await user.click(screen.getByTestId('grid-reset-run'));
    expect(client.post).toHaveBeenCalledWith('/sessions/s1/reload', expect.anything());
  });

  it('does not paste, and says why', async () => {
    const user = userEvent.setup();
    render(<BusesGrid />);
    await user.click(cell('buses', '1', 'vmin'));
    fireEvent.paste(screen.getByTestId('buses-grid'), {
      clipboardData: { getData: () => '0.92' },
    });
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        expect.stringMatching(/^Nothing was pasted\. The case is set up for a run/),
      ),
    );
    expect(client.put).not.toHaveBeenCalled();
  });

  it('can still be filtered and copied', async () => {
    const user = userEvent.setup();
    render(<LinesGrid />);
    await user.type(screen.getByTestId('lines-grid-filter'), 'L2');
    expect(visibleRowIds('lines')).toEqual(['line-L2']);
    expect(screen.getByTestId('lines-grid-copy')).toBeEnabled();
  });
});

describe('<LinesGrid /> editing', () => {
  it('opens the line parameters and the rating, and leaves the results alone', () => {
    render(<LinesGrid />);
    for (const key of ['r', 'x', 'b', 'u', 'rate_a']) {
      expect(cell('lines', 'line-L1', key)).toHaveAttribute('data-editable', 'true');
    }
    for (const key of ['p_from', 'loss', 'loading', 'loading_check']) {
      expect(cell('lines', 'line-L1', key)).not.toHaveAttribute('data-editable');
    }
  });

  it('writes the typed value to the line by its idx', async () => {
    const user = userEvent.setup();
    render(<LinesGrid />);
    await typeInto(user, cell('lines', 'line-L1', 'x'), '0.15');
    expect(puts()).toEqual([['/sessions/s1/elements/Line/L1', { params: { x: 0.15 } }]]);
  });

  it('rates an unrated line, which reads a dash, and takes a line out of service', async () => {
    const user = userEvent.setup();
    render(<LinesGrid />);
    expect(cell('lines', 'line-L2', 'rate_a')).toHaveTextContent('—');
    await user.dblClick(cell('lines', 'line-L2', 'rate_a'));
    expect(screen.getByTestId('lines-grid-editor')).toHaveValue('');
    await user.keyboard('150{Enter}');
    await typeInto(user, cell('lines', 'line-L1', 'u'), '0');
    expect(puts()).toEqual([
      ['/sessions/s1/elements/Line/L2', { params: { rate_a: 150 } }],
      ['/sessions/s1/elements/Line/L1', { params: { u: 0 } }],
    ]);
  });
});

describe('<GeneratorsGrid /> editing', () => {
  it('opens the set-points of a static generator, and nothing of a machine', () => {
    render(<GeneratorsGrid />);
    for (const row of ['pv-1', 'slack-2']) {
      expect(cell('generators', row, 'p0')).toHaveAttribute('data-editable', 'true');
      expect(cell('generators', row, 'v0')).toHaveAttribute('data-editable', 'true');
    }
    // A machine has no p0 or v0: its parameters are in the Machines table.
    expect(cell('generators', 'genrou-G1', 'p0')).not.toHaveAttribute('data-editable');
    expect(cell('generators', 'genrou-G1', 'p0')).toHaveTextContent('—');
    expect(cell('generators', 'pv-1', 'p')).not.toHaveAttribute('data-editable');
  });

  it('writes to the model of the row, PV or Slack', async () => {
    const user = userEvent.setup();
    render(<GeneratorsGrid />);
    await typeInto(user, cell('generators', 'pv-1', 'p0'), '0.45');
    await typeInto(user, cell('generators', 'slack-2', 'v0'), '1.05');
    expect(puts()).toEqual([
      ['/sessions/s1/elements/PV/1', { params: { p0: 0.45 } }],
      ['/sessions/s1/elements/Slack/2', { params: { v0: 1.05 } }],
    ]);
  });

  it('filters by kind', async () => {
    const user = userEvent.setup();
    render(<GeneratorsGrid />);
    await user.type(screen.getByTestId('generators-grid-filter'), 'pv');
    expect(visibleRowIds('generators')).toEqual(['pv-1']);
  });
});

describe('<LoadsGrid /> editing', () => {
  it('writes the set-points to the model of the load, PQ or ZIP', async () => {
    const user = userEvent.setup();
    render(<LoadsGrid />);
    expect(cell('loads', 'load-PQ_1', 'p')).not.toHaveAttribute('data-editable');
    await typeInto(user, cell('loads', 'load-PQ_1', 'p0'), '0.55');
    await typeInto(user, cell('loads', 'load-Z_1', 'q0'), '0.06');
    expect(puts()).toEqual([
      ['/sessions/s1/elements/PQ/PQ_1', { params: { p0: 0.55 } }],
      ['/sessions/s1/elements/ZIP/Z_1', { params: { q0: 0.06 } }],
    ]);
  });

  it('labels the set-points per unit, not MW', () => {
    render(<LoadsGrid />);
    expect(screen.getByTestId('loads-grid-header-p0')).toHaveTextContent('p0 (pu)');
    expect(screen.getByTestId('loads-grid-header-p0')).toHaveAttribute(
      'title',
      expect.stringContaining('per unit on the system base'),
    );
  });
});

describe('<ShuntsGrid /> editing', () => {
  it('writes B and G', async () => {
    const user = userEvent.setup();
    render(<ShuntsGrid />);
    await typeInto(user, cell('shunts', 'shunt-S1', 'b'), '0.25');
    await typeInto(user, cell('shunts', 'shunt-S1', 'g'), '0.01');
    expect(puts()).toEqual([
      ['/sessions/s1/elements/Shunt/S1', { params: { b: 0.25 } }],
      ['/sessions/s1/elements/Shunt/S1', { params: { g: 0.01 } }],
    ]);
  });
});
