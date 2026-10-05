/**
 * The tables of the dynamic models (Machines, Exciters, Governors): which
 * devices each holds, the columns a model gets from the topology schema, picking
 * between models of one kind, selecting a device, and changing its values by the
 * route the case allows.
 *
 * The API client is stubbed, so each test reads the requests that went out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useSldStore } from '@/store/sld';
import { captureDownloads, exportAs, type DownloadCapture } from '../../helpers/downloads';
import { makeGridQueryClient, renderWithQuery as render } from '../../helpers/gridQuery';
import { TOPOLOGY_SCHEMA } from '../../helpers/topologySchema';

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

import { ExcitersGrid, GovernorsGrid, MachinesGrid } from '@/components/data-grid/ModelParamsGrid';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [
    { idx: 1, name: 'PV_1', kind: 'PV', params: { bus: 1, p0: 0.4 } },
    {
      idx: 'G1',
      name: 'GENROU_1',
      kind: 'GENROU',
      params: {
        bus: 1,
        gen: 1,
        Sn: 900,
        Vn: 20,
        D: 0,
        M: 13,
        ra: 0,
        xl: 0.06,
        xd: 1.8,
        xq: 1.7,
        xd1: 0.3,
        xq1: 0.55,
        xd2: 0.25,
        xq2: 0.25,
        Td10: 8,
        Td20: 0.03,
        Tq10: 0.4,
        Tq20: 0.05,
      },
    },
    { idx: 'G2', name: 'GENROU_2', kind: 'GENROU', params: { bus: 2, gen: 2, M: 12.35, xd: 1.8 } },
    {
      idx: 'C1',
      name: 'GENCLS_1',
      kind: 'GENCLS',
      params: { bus: 3, gen: 3, M: 6, D: 0.5, xl: 0.1 },
    },
  ],
  loads: [],
  controllers: [
    { idx: 'E1', name: 'E1', kind: 'IEEEX1', params: { syn: 'G1', KA: 200, TA: 0.02, VRMAX: 5 } },
    { idx: 'E2', name: 'E2', kind: 'IEEEX1', params: { syn: 'G2', KA: 150, TA: 0.05 } },
    { idx: 'D1', name: 'D1', kind: 'ESDC2A', params: { syn: 'C1', KA: 46, TA: 0.06 } },
    { idx: 'T1', name: 'T1', kind: 'TGOV1', params: { syn: 'G1', R: 0.05, T1: 0.5 } },
    { idx: 'T2', name: 'T2', kind: 'IEEEG1', params: { syn: 'G2', K: 20, T1: 0.1 } },
    // A stabiliser belongs to no table here.
    { idx: 'P1', name: 'P1', kind: 'IEEEST', params: { avr: 'E1', KS: 1 } },
  ],
};

function cell(grid: string, rowId: string, key: string): HTMLElement {
  return screen.getByTestId(`${grid}-grid-cell-${rowId}-${key}`);
}

function rowIds(grid: string): string[] {
  return screen
    .getAllByRole('row')
    .map((r) => r.getAttribute('data-testid'))
    .filter((id): id is string => id !== null && id.startsWith(`${grid}-grid-row-`))
    .map((id) => id.replace(`${grid}-grid-row-`, ''));
}

function headings(): string[] {
  return screen
    .getAllByRole('columnheader')
    .map((h) => (h.textContent ?? '').replace(/[·▲▼]/g, ''));
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
    selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    selectedElement: null,
    editMode: 'run',
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {} });
  useSldStore.setState({ selectedNodeId: null });
  client.put.mockImplementation(async (path: string) =>
    path.includes('/case/clone/')
      ? { model: 'IEEEX1', idx: 'E1', param: 'KA', new_value: 1, undo_depth: 1, redo_depth: 0 }
      : { idx: '1', name: 'x', kind: 'GENROU', params: {} },
  );
  client.post.mockResolvedValue({ ...TOPOLOGY, state: 'pre-setup' });
});

afterEach(() => {
  cleanup();
  mockTopology = null;
  useCaseStore.setState({ editMode: 'run' });
});

describe('<MachinesGrid />', () => {
  it('holds the dynamic machines, and no static generator', () => {
    render(<MachinesGrid />);
    expect(rowIds('machines')).toEqual(['GENROU-G1', 'GENROU-G2']);
    expect(screen.getByRole('table', { name: 'Machines' })).toBeInTheDocument();
  });

  it('has a chip per model, with how many, and the first is showing', () => {
    render(<MachinesGrid />);
    const group = screen.getByRole('group', { name: 'Model' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['GENROU 2', 'GENCLS 1']);
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
    expect(chips[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('gives a GENROU every parameter the schema lists, in its order, with the unit in the heading', () => {
    render(<MachinesGrid />);
    const schema = TOPOLOGY_SCHEMA.models.GENROU ?? [];
    const expected = schema
      .filter((m) => m.name !== 'idx' && m.name !== 'name')
      .map((m) => (m.unit ? `${m.name} (${m.unit})` : m.name));
    expect(headings()).toEqual(['idx', 'name', ...expected]);
    expect(headings()).toContain('H (MWs/MVA)');
    expect(headings()).toContain('xd1 (pu)');
    expect(headings()).toContain('Td10 (s)');
  });

  it('shows the values as the case holds them, and H as half of M', () => {
    render(<MachinesGrid />);
    expect(cell('machines', 'GENROU-G1', 'M')).toHaveTextContent('13');
    expect(cell('machines', 'GENROU-G1', 'H')).toHaveTextContent('6.5');
    expect(cell('machines', 'GENROU-G1', 'xd1')).toHaveTextContent('0.3');
    expect(cell('machines', 'GENROU-G1', 'Td20')).toHaveTextContent('0.03');
    // A value the case does not carry reads a dash.
    expect(cell('machines', 'GENROU-G2', 'xd1')).toHaveTextContent('—');
    expect(cell('machines', 'GENROU-G2', 'H')).toHaveTextContent('6.175');
    expect(screen.getByTestId('machines-grid-header-H')).toHaveAttribute(
      'title',
      expect.stringContaining('M divided by two'),
    );
  });

  it('switches to another model with its own columns', async () => {
    const user = userEvent.setup();
    render(<MachinesGrid />);
    await user.click(screen.getByTestId('machines-grid-model-GENCLS'));
    expect(rowIds('machines')).toEqual(['GENCLS-C1']);
    // A GENCLS has M and no H.
    expect(headings()).not.toContain('H (MWs/MVA)');
    expect(headings()).toContain('M (MWs/MVA)');
    expect(screen.getByTestId('machines-grid-model-GENCLS')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(cell('machines', 'GENCLS-C1', 'M')).toHaveTextContent('6');
  });

  it('falls back to the first model when the chosen one leaves the case', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MachinesGrid />);
    await user.click(screen.getByTestId('machines-grid-model-GENCLS'));
    mockTopology = {
      ...TOPOLOGY,
      generators: TOPOLOGY.generators.filter((g) => g.kind !== 'GENCLS'),
    };
    rerender(<MachinesGrid />);
    expect(rowIds('machines')).toEqual(['GENROU-G1', 'GENROU-G2']);
  });

  it('opens the numbers to editing and leaves the links and the names alone', () => {
    render(<MachinesGrid />);
    for (const key of ['Sn', 'Vn', 'H', 'M', 'D', 'xd', 'xd1', 'Td10']) {
      expect(cell('machines', 'GENROU-G1', key)).toHaveAttribute('data-editable', 'true');
    }
    for (const key of ['idx', 'name', 'bus', 'gen']) {
      expect(cell('machines', 'GENROU-G1', key)).not.toHaveAttribute('data-editable');
    }
  });

  it('writes the inertia typed as H as H, which the server holds as M', async () => {
    const user = userEvent.setup();
    render(<MachinesGrid />);
    await typeInto(user, cell('machines', 'GENROU-G1', 'H'), '7');
    expect(puts()).toEqual([['/sessions/s1/elements/GENROU/G1', { params: { H: 7 } }]]);
  });

  it('writes a pasted set of reactances in one request, so the order is judged on the set', async () => {
    const user = userEvent.setup();
    render(<MachinesGrid />);
    await user.click(cell('machines', 'GENROU-G1', 'xd'));
    fireEvent.paste(screen.getByTestId('machines-grid'), {
      clipboardData: { getData: () => '1.9\t1.7\t0.28\t0.5\t0.2\t0.2\n' },
    });
    await waitFor(() => expect(client.put).toHaveBeenCalled());
    // xd, xq, xd1, xq1, xd2, xq2 follow each other in the schema.
    expect(puts()).toEqual([
      [
        '/sessions/s1/elements/GENROU/G1',
        { params: { xd: 1.9, xq: 1.7, xd1: 0.28, xq1: 0.5, xd2: 0.2, xq2: 0.2 } },
      ],
    ]);
  });

  describe('a block that covers both H and M', () => {
    /** The text of the first machine's row, as a copy of the table would carry it. */
    async function pasteAtH(user: ReturnType<typeof userEvent.setup>, text: string) {
      // Heading order: idx, name, bus, gen, Sn, Vn, H, D, M, ...
      await user.click(cell('machines', 'GENROU-G1', 'H'));
      fireEvent.paste(screen.getByTestId('machines-grid'), {
        clipboardData: { getData: () => text },
      });
      await waitFor(() => expect(client.put).toHaveBeenCalled());
    }

    it('sends M alone when the two agree, as a pasted copy of the row does', async () => {
      const user = userEvent.setup();
      render(<MachinesGrid />);
      await pasteAtH(user, '6.5\t0.5\t13\n');
      expect(puts()).toEqual([['/sessions/s1/elements/GENROU/G1', { params: { D: 0.5, M: 13 } }]]);
    });

    it('sends H when H was changed beside an M that still reads as held', async () => {
      const user = userEvent.setup();
      render(<MachinesGrid />);
      await pasteAtH(user, '7\t0\t13\n');
      expect(puts()).toEqual([['/sessions/s1/elements/GENROU/G1', { params: { D: 0, H: 7 } }]]);
    });

    it('sends M when M was changed beside an H that still reads as held', async () => {
      const user = userEvent.setup();
      render(<MachinesGrid />);
      await pasteAtH(user, '6.5\t0\t15\n');
      expect(puts()).toEqual([['/sessions/s1/elements/GENROU/G1', { params: { D: 0, M: 15 } }]]);
    });

    it("takes a spreadsheet's rounding of M = 2H as agreement", async () => {
      const user = userEvent.setup();
      render(<MachinesGrid />);
      await pasteAtH(user, '7\t0\t14.000000000000002\n');
      expect(puts()).toEqual([
        ['/sessions/s1/elements/GENROU/G1', { params: { D: 0, M: 14.000000000000002 } }],
      ]);
    });

    it('writes nothing, and says why, when both changed and disagree', async () => {
      const user = userEvent.setup();
      render(<MachinesGrid />);
      await user.click(cell('machines', 'GENROU-G1', 'H'));
      fireEvent.paste(screen.getByTestId('machines-grid'), {
        // G1's block (a reactance that would have been fine) and G2's, whose H and M clash.
        clipboardData: { getData: () => '6.5\t0\t13\n7\t\t15\n' },
      });
      expect(await screen.findByTestId('machines-grid-edit-error')).toHaveTextContent(
        'Could not set H, M of GENROU G2. H and M disagree (M is 2H): H of 7 makes M 14, and M is 15. Change one of them.',
      );
      expect(client.put).not.toHaveBeenCalled();
    });

    it('puts a copy of the whole table back as one accepted request for each machine', async () => {
      const user = userEvent.setup();
      render(<MachinesGrid />);
      const first = cell('machines', 'GENROU-G1', 'idx');
      await user.click(first);
      await user.keyboard('{Control>}a{/Control}');
      const setData = vi.fn();
      fireEvent.copy(screen.getByTestId('machines-grid'), {
        clipboardData: { setData },
      });
      const copied = setData.mock.calls[0]?.[1] as string;
      expect(copied).toContain('6.5');

      await user.click(first);
      fireEvent.paste(screen.getByTestId('machines-grid'), {
        clipboardData: { getData: () => copied },
      });
      await waitFor(() => expect(client.put).toHaveBeenCalledTimes(2));
      const sent = puts();
      expect(sent.map(([path]) => path)).toEqual([
        '/sessions/s1/elements/GENROU/G1',
        '/sessions/s1/elements/GENROU/G2',
      ]);
      for (const [, body] of sent) {
        const params = (body as { params: Record<string, number> }).params;
        expect('H' in params && 'M' in params).toBe(false);
      }
      expect((sent[0]?.[1] as { params: Record<string, number> }).params).toMatchObject({
        M: 13,
        xd: 1.8,
      });
      expect((sent[1]?.[1] as { params: Record<string, number> }).params).toEqual({
        M: 12.35,
        xd: 1.8,
      });
      expect(screen.queryByTestId('machines-grid-edit-error')).not.toBeInTheDocument();
    });
  });

  it('shows the reason when the server keeps a reactance out of order', async () => {
    const user = userEvent.setup();
    const { ProblemDetailsError } = await import('@/api/client');
    client.put.mockRejectedValueOnce(
      new ProblemDetailsError({
        title: 'Unprocessable',
        status: 422,
        detail:
          'GENROU reactances must satisfy xd > xd1 > xd2 > xl; this edit leaves xd=0.2 <= xd1=0.3.',
      } as never),
    );
    render(<MachinesGrid />);
    await typeInto(user, cell('machines', 'GENROU-G1', 'xd'), '0.2');
    expect(await screen.findByTestId('machines-grid-edit-error')).toHaveTextContent(
      'Could not set xd of GENROU G1. GENROU reactances must satisfy xd > xd1 > xd2 > xl',
    );
  });

  it('is locked once a run has started, and Edit mode does not open it (a machine has no copy of the file)', () => {
    mockTopology = { ...TOPOLOGY, state: 'committed' };
    useCaseStore.setState({ editMode: 'edit' });
    render(<MachinesGrid />);
    expect(cell('machines', 'GENROU-G1', 'xd1')).not.toHaveAttribute('data-editable');
    expect(screen.getByTestId('machines-grid-hint')).toHaveTextContent(
      'The case is set up for a run',
    );
    expect(screen.getByTestId('grid-reset-run')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-mode-toggle')).not.toBeInTheDocument();
  });

  it('selects the machine as the generator at its idx, and marks the row of the selected one', async () => {
    const user = userEvent.setup();
    render(<MachinesGrid />);
    await user.click(screen.getByTestId('machines-grid-row-GENROU-G2'));
    expect(useSldStore.getState().selectedNodeId).toBe('generator-G2');
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: 'G2',
      modelClass: 'GENROU',
    });
    expect(screen.getByTestId('machines-grid-row-GENROU-G2')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByTestId('machines-grid-row-GENROU-G1')).toHaveAttribute(
      'data-selected',
      'false',
    );
  });

  it('says what is missing, and how to get it, when the case has no machines', () => {
    mockTopology = { ...TOPOLOGY, generators: TOPOLOGY.generators.filter((g) => g.kind === 'PV') };
    render(<MachinesGrid />);
    expect(screen.getByTestId('machines-grid-empty')).toHaveTextContent(
      'No machines in this case. Open the case with its .dyr file, or an .xlsx that has them.',
    );
    expect(screen.queryByRole('group', { name: 'Model' })).not.toBeInTheDocument();
  });

  it('asks for a case before one is loaded', () => {
    mockTopology = null;
    render(<MachinesGrid />);
    expect(screen.getByTestId('machines-grid-empty')).toHaveTextContent(
      'Load a case to see machines.',
    );
  });

  it('filters the rows of the model on show', async () => {
    const user = userEvent.setup();
    render(<MachinesGrid />);
    await user.type(screen.getByTestId('machines-grid-filter'), 'G2');
    expect(rowIds('machines')).toEqual(['GENROU-G2']);
  });
});

describe('<ExcitersGrid />', () => {
  it('holds the exciters, and no governor or stabiliser', () => {
    render(<ExcitersGrid />);
    expect(rowIds('exciters')).toEqual(['IEEEX1-E1', 'IEEEX1-E2']);
    const chips = within(screen.getByRole('group', { name: 'Model' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['IEEEX1 2', 'ESDC2A 1']);
  });

  it('gives an exciter the parameters of its model', async () => {
    const user = userEvent.setup();
    render(<ExcitersGrid />);
    expect(headings()).toEqual([
      'idx',
      'name',
      ...(TOPOLOGY_SCHEMA.models.IEEEX1 ?? [])
        .filter((m) => m.name !== 'idx' && m.name !== 'name')
        .map((m) => (m.unit ? `${m.name} (${m.unit})` : m.name)),
    ]);
    expect(cell('exciters', 'IEEEX1-E1', 'KA')).toHaveTextContent('200');
    await user.click(screen.getByTestId('exciters-grid-model-ESDC2A'));
    expect(rowIds('exciters')).toEqual(['ESDC2A-D1']);
    expect(headings()).toContain('Switch');
  });

  it('writes to the System in memory before a run, with the Edit mode switch in the bar', async () => {
    const user = userEvent.setup();
    render(<ExcitersGrid />);
    expect(screen.getByTestId('edit-mode-toggle')).toBeInTheDocument();
    expect(cell('exciters', 'IEEEX1-E1', 'KA')).toHaveAttribute('data-editable', 'true');
    // The machine it is on is a link, not a value.
    expect(cell('exciters', 'IEEEX1-E1', 'syn')).not.toHaveAttribute('data-editable');
    await typeInto(user, cell('exciters', 'IEEEX1-E1', 'KA'), '250');
    expect(puts()).toEqual([['/sessions/s1/elements/IEEEX1/E1', { params: { KA: 250 } }]]);
  });

  it('writes to a copy of the case file in Edit mode, after a run too', async () => {
    const user = userEvent.setup();
    mockTopology = { ...TOPOLOGY, state: 'committed' };
    useCaseStore.setState({ editMode: 'edit' });
    render(<ExcitersGrid />);
    await typeInto(user, cell('exciters', 'IEEEX1-E2', 'TA'), '0.04');
    expect(puts()).toEqual([['/sessions/s1/case/clone/params/IEEEX1/E2/TA', { value: 0.04 }]]);
  });

  it('is locked after a run outside Edit mode, and Edit mode unlocks it', async () => {
    const user = userEvent.setup();
    mockTopology = { ...TOPOLOGY, state: 'committed' };
    render(<ExcitersGrid />);
    expect(cell('exciters', 'IEEEX1-E1', 'KA')).not.toHaveAttribute('data-editable');
    expect(screen.getByTestId('exciters-grid-hint')).toHaveTextContent('Turn on Edit mode');
    // Reset run is the other way out.
    expect(screen.getByTestId('grid-reset-run')).toBeInTheDocument();
    await user.click(screen.getByTestId('edit-mode-toggle'));
    expect(useCaseStore.getState().editMode).toBe('edit');
    expect(cell('exciters', 'IEEEX1-E1', 'KA')).toHaveAttribute('data-editable', 'true');
    expect(screen.queryByTestId('grid-reset-run')).not.toBeInTheDocument();
  });

  it('selects a controller by its model and idx, as a click on it in the diagram does', async () => {
    const user = userEvent.setup();
    render(<ExcitersGrid />);
    await user.click(screen.getByTestId('exciters-grid-row-IEEEX1-E2'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'controller',
      subKind: 'exciter',
      modelClass: 'IEEEX1',
      idx: 'E2',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('controller-IEEEX1-E2');
    expect(screen.getByTestId('exciters-grid-row-IEEEX1-E2')).toHaveAttribute(
      'data-selected',
      'true',
    );
  });

  it('marks the row of a controller selected in the diagram', () => {
    useSldStore.setState({ selectedNodeId: 'controller-IEEEX1-E1' });
    render(<ExcitersGrid />);
    expect(screen.getByTestId('exciters-grid-row-IEEEX1-E1')).toHaveAttribute(
      'data-selected',
      'true',
    );
  });

  it('exports the model on show, in a file named for it', async () => {
    const user = userEvent.setup();
    const downloads: DownloadCapture = captureDownloads();
    try {
      render(<ExcitersGrid />);
      await exportAs(user, 'csv');
      expect(downloads.filenames[0]).toContain('exciters-ieeex1');
    } finally {
      downloads.restore();
    }
  });

  it('takes the columns from the entries when the schema does not know the model', () => {
    const client2: QueryClient = makeGridQueryClient();
    const schema = { models: { ...TOPOLOGY_SCHEMA.models } };
    delete (schema.models as Record<string, unknown>)['IEEEX1'];
    client2.setQueryData(queryKeys.topologySchema, schema);
    render(<ExcitersGrid />, client2);
    expect(headings()).toEqual(['idx', 'name', 'syn', 'KA', 'TA', 'VRMAX']);
    // What the entries hold as numbers can be edited only where the schema vouches for it.
    expect(cell('exciters', 'IEEEX1-E1', 'KA')).toHaveTextContent('200');
    expect(cell('exciters', 'IEEEX1-E1', 'KA')).not.toHaveAttribute('data-editable');
  });

  it('says what is missing when the case has no exciters', () => {
    mockTopology = { ...TOPOLOGY, controllers: [] };
    render(<ExcitersGrid />);
    expect(screen.getByTestId('exciters-grid-empty')).toHaveTextContent(
      'No exciters in this case. Open the case with its .dyr file, or an .xlsx that has them.',
    );
  });
});

describe('<GovernorsGrid />', () => {
  it('holds the governors, and no exciter', () => {
    render(<GovernorsGrid />);
    expect(rowIds('governors')).toEqual(['TGOV1-T1']);
    const chips = within(screen.getByRole('group', { name: 'Model' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['TGOV1 1', 'IEEEG1 1']);
  });

  it('switches to the other governor model and writes to it', async () => {
    const user = userEvent.setup();
    render(<GovernorsGrid />);
    await user.click(screen.getByTestId('governors-grid-model-IEEEG1'));
    expect(rowIds('governors')).toEqual(['IEEEG1-T2']);
    await typeInto(user, cell('governors', 'IEEEG1-T2', 'K'), '25');
    expect(puts()).toEqual([['/sessions/s1/elements/IEEEG1/T2', { params: { K: 25 } }]]);
  });

  it('selects a governor as a governor', async () => {
    const user = userEvent.setup();
    render(<GovernorsGrid />);
    await user.click(screen.getByTestId('governors-grid-row-TGOV1-T1'));
    expect(useCaseStore.getState().selectedElement).toMatchObject({
      kind: 'controller',
      subKind: 'governor',
      modelClass: 'TGOV1',
    });
  });
});
