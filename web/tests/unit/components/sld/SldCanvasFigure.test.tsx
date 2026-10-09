/**
 * The figure of the diagram, from the canvas: the ways to it, what it is made
 * of, and where its choices are kept.
 *
 * The figure itself is held in `figure/drawFigure.test.ts` and the dialog in
 * `SldFigureDialog.test.tsx`. Here the two are tied to the canvas: the
 * dialog opens from the diagram's export menu and from the command the menus
 * and the palette send, it draws the diagram the canvas holds (the nodes
 * where they stand, the values of the power flow, the nodes picked
 * together), and a choice made in it is a setting of the diagram, kept like
 * the connector style: in the store for the visit, in the layout every save
 * sends, and in the file beside the case.
 *
 * The canvas is rendered against the stand-in for React Flow that
 * `SldCanvasConnections.test.tsx` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

interface DrawnNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

const drawn: { nodes: DrawnNode[] } = { nodes: [] };

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: { nodes: DrawnNode[] }) => {
    drawn.nodes = props.nodes;
    return null;
  },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  Handle: () => null,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  BaseEdge: () => null,
  BackgroundVariant: { Lines: 'lines', Dots: 'dots', Cross: 'cross' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  SelectionMode: { Partial: 'partial', Full: 'full' },
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
  useReactFlow: () => ({
    setCenter: vi.fn(),
    getZoom: () => 1,
    getNodes: () => [],
    fitView: vi.fn(),
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}));

vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async () => ({ children: [] })),
}));

import { SldCanvas } from '@/components/sld/SldCanvas';
import {
  __clearAllPendingForTests,
  buildSidecarLayout,
  CONNECTOR_STYLE_SETTING,
} from '@/components/sld/sidecar';
import { useCaseStore } from '@/store/case';
import { useDraftsStore } from '@/store/drafts';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { __requestSldCommand, useSldStore } from '@/store/sld';
import { parseRunId, parseSessionId, parseWorkspacePath } from '@/api/types';
import type { SidecarLayout, TopologyEntry, TopologySummary } from '@/api/types';
import { captureDownloads, readBlob, type DownloadCapture } from '../../helpers/downloads';

let mockTopology: TopologySummary | null = null;
let mockSidecar: SidecarLayout | null = null;
const putSidecarSpy = vi.fn();
let downloads: DownloadCapture;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useGetSidecar: () => ({ data: mockSidecar, isLoading: false, isError: false, error: null }),
    usePutSidecar: () => ({ mutate: putSidecarSpy }),
    useCurrentTopology: () => mockTopology,
    // The fields of each model: only a draft on the diagram is checked against them.
    useTopologySchema: () => ({ data: undefined }),
    useEditElements: () => ({ mutate: vi.fn(), isPending: false }),
    useConnectivity: () => ({
      data: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

function entry(idx: string | number, kind: string, params: TopologyEntry['params']): TopologyEntry {
  return { idx, name: kind === 'Bus' ? `BUS${idx}` : String(idx), kind, params };
}

/** Three buses in a column, two lines between them, a load on the second and on the third. */
function column(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [entry(1, 'Bus', {}), entry(2, 'Bus', {}), entry(3, 'Bus', {})],
    lines: [entry('L12', 'Line', { bus1: 1, bus2: 2 }), entry('L23', 'Line', { bus1: 2, bus2: 3 })],
    transformers: [],
    generators: [],
    loads: [entry('PQ_A', 'PQ', { bus: 2 }), entry('PQ_B', 'PQ', { bus: 3 })],
    shunts: [],
    controllers: [],
  };
}

function placed(figure: SidecarLayout['figure'] = {}): SidecarLayout {
  return buildSidecarLayout(
    { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 }, '3': { x: 0, y: 400 } },
    { sections: { figure } },
  );
}

function open(casePath: string | null): void {
  useCaseStore.getState().setCase({
    primaryPath: casePath === null ? null : parseWorkspacePath(casePath),
    addfiles: [],
  });
}

async function draw(): Promise<void> {
  render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
}

/** Open the figure the way a user does: the diagram's Export menu, then its Figure entry. */
async function openFigure(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(within(screen.getByTestId('sld-canvas')).getByTestId('export-menu-trigger'));
  await user.click(await screen.findByTestId('export-menu-figure'));
  return await screen.findByTestId('sld-figure-dialog', undefined, { timeout: 5000 });
}

/** The SVG the preview shows. */
function previewSvg(): string {
  const src = screen.getByTestId('sld-figure-preview').getAttribute('src') ?? '';
  return decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
}

/** What the figure says: the content of every text of it. */
function said(): string[] {
  const doc = new DOMParser().parseFromString(previewSvg(), 'image/svg+xml');
  return [...doc.querySelectorAll('text')].map((el) => el.textContent ?? '');
}

function solve(): void {
  act(() =>
    usePflowStore.setState({
      lastRun: {
        run_id: parseRunId('pf-1'),
        converged: true,
        iterations: 3,
        mismatch: 1e-6,
        bus_voltages: { '1': 1.02, '2': 0.99, '3': 0.98 },
        bus_angles: { '1': 0, '2': -0.03, '3': -0.05 },
        line_flows: {},
        load_consumption: {
          PQ_A: { p: 120.5, q: 30.2, bus: 2 },
          PQ_B: { p: 80, q: 12, bus: 3 },
        },
      },
      isRunning: false,
      error: null,
    }),
  );
}

beforeEach(() => {
  mockTopology = column();
  mockSidecar = placed();
  putSidecarSpy.mockClear();
  downloads = captureDownloads();
  drawn.nodes = [];
  useSessionStore.setState({ sessionId: parseSessionId('sess-figure') });
  useCaseStore.getState().clearCase();
  useSldStore.getState().clearSelectedNodeId();
  useSldStore.setState({ pickedNodeIds: [], pickedCount: 0 });
  usePflowStore.setState({ lastRun: null });
});

afterEach(() => {
  cleanup();
  downloads.restore();
  __clearAllPendingForTests();
  useCaseStore.getState().clearCase();
  useSldStore.setState({ pickedNodeIds: [], pickedCount: 0 });
});

describe('the ways to the figure of the diagram', () => {
  it('is in the export menu over the diagram, whose button says so before it is opened', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();

    const trigger = within(screen.getByTestId('sld-canvas')).getByTestId('export-menu-trigger');
    // What is shown is the word a user looks for; what it is called says what is behind it.
    expect(trigger).toHaveTextContent('Export');
    expect(trigger).toHaveAccessibleName(
      'Export: a figure of the diagram for a paper (SVG, PDF or PNG), or a PNG of this view',
    );
    // Nothing of the figure is on the page, or fetched, before it is asked for.
    expect(screen.queryByTestId('sld-figure-dialog')).toBeNull();

    await user.click(trigger);
    const menu = await screen.findByTestId('export-menu');
    expect(within(menu).getByTestId('export-menu-png')).toHaveTextContent('PNG');
    const entry = within(menu).getByTestId('export-menu-figure');
    // The same words as the entry of the top bar's Export menu.
    expect(entry).toHaveTextContent(/^Figure for a paper…$/);

    await user.click(entry);

    const dialog = await screen.findByTestId('sld-figure-dialog', undefined, { timeout: 5000 });
    expect(within(dialog).getByRole('heading', { name: 'Figure for a paper' })).toBeVisible();
    // The menu it came from is gone from over it.
    expect(screen.queryByTestId('export-menu')).toBeNull();
  });

  it('opens from the command the Export menu of the top bar, the right-click menu and the palette send', async () => {
    open('column.xlsx');
    await draw();
    act(() => __requestSldCommand('figure'));
    expect(
      await screen.findByTestId('sld-figure-dialog', undefined, { timeout: 5000 }),
    ).toBeVisible();
  });

  it('closes with its Close button, and opens again', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    await user.click(screen.getByTestId('sld-figure-close'));
    await waitFor(() => expect(screen.queryByTestId('sld-figure-dialog')).toBeNull());
    expect(await openFigure(user)).toBeVisible();
  });
});

describe('what the figure is made of', () => {
  it('is the diagram the canvas holds: its buses, its devices and its lines', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);

    expect(said().sort()).toEqual(['BUS1', 'BUS2', 'BUS3', 'PQ_A', 'PQ_B']);
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent('5 buses and devices');
    const doc = new DOMParser().parseFromString(previewSvg(), 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    // Black on white, as it opens.
    const colours = new Set(
      [...doc.querySelectorAll('[fill], [stroke]')].flatMap((el) =>
        [el.getAttribute('fill'), el.getAttribute('stroke')].filter(
          (value): value is string => value !== null && value !== 'none',
        ),
      ),
    );
    expect([...colours].sort()).toEqual(['#000000', '#ffffff']);
  });

  it('leaves out the drafts: an element that was placed and is not in the system yet', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    act(() =>
      useDraftsStore.setState({
        byCase: {
          'column.xlsx': [
            { id: 'draft-1', kind: 'PV', position: { x: 600, y: 40 }, values: {} },
            {
              id: 'draft-2',
              kind: 'Line',
              position: { x: 600, y: 200 },
              values: { bus1: '1', bus2: '3' },
            },
          ],
        },
      }),
    );
    await draw();
    await waitFor(() => expect(drawn.nodes.some((n) => n.id === 'draft-1')).toBe(true));
    await openFigure(user);
    // The same figure as without them: no symbol and no line of a draft.
    expect(said().sort()).toEqual(['BUS1', 'BUS2', 'BUS3', 'PQ_A', 'PQ_B']);
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent('5 buses and devices');
    act(() => useDraftsStore.setState({ byCase: {}, routes: {} }));
  });

  it('has the values of the power flow once one has run, and says what to do before', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    // Before a power flow there is nothing to show of one, and the choices say why.
    for (const id of ['voltages', 'angles', 'flows', 'powers', 'limit-marks']) {
      expect(screen.getByTestId(`sld-figure-${id}`)).toBeDisabled();
      expect(screen.getByTestId(`sld-figure-${id}`)).not.toBeChecked();
    }
    expect(screen.getByTestId('sld-figure-no-pflow')).toHaveTextContent(
      'The five below come from a power flow, and none has run yet. Close this, press Run PF, and open the figure again to choose them.',
    );
    expect(said().some((text) => / pu$/.test(text))).toBe(false);
    await user.click(screen.getByTestId('sld-figure-close'));

    solve();
    await openFigure(user);
    expect(screen.getByTestId('sld-figure-voltages')).toBeEnabled();
    // What was chosen for it all along: it was only not on the figure yet.
    expect(screen.getByTestId('sld-figure-voltages')).toBeChecked();
    expect(screen.queryByTestId('sld-figure-no-pflow')).toBeNull();
    expect(said()).toEqual(
      expect.arrayContaining(['1.020 pu', '0.990 pu', '120.5 MW', '30.2 MVAr']),
    );
  });

  it('is of the nodes picked together when that is chosen, and of the whole diagram otherwise', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    // With nothing picked the choice is there, greyed out, with how to pick.
    expect(screen.getByTestId('sld-figure-part-picked')).toBeDisabled();
    expect(screen.getByTestId('sld-figure-part-hint')).toHaveTextContent(
      /Nothing is selected\..*hold Shift and drag a box round the part.*hold Ctrl and click each bus/,
    );
    await user.click(screen.getByTestId('sld-figure-close'));

    act(() => useSldStore.getState().setPickedNodeIds(['2', '3']));
    await openFigure(user);
    const part = screen.getByTestId('sld-figure-part-picked');
    expect(part).toBeEnabled();
    expect(part.closest('label')).toHaveTextContent('Selection only (2 picked)');
    // The whole diagram until the part is asked for.
    expect(said()).toContain('BUS1');

    await user.click(part);

    // The two buses with their loads, and the line between them.
    expect(said().sort()).toEqual(['BUS2', 'BUS3', 'PQ_A', 'PQ_B']);
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent('4 buses and devices');
    await user.click(screen.getByTestId('sld-figure-part-all'));
    expect(said()).toContain('BUS1');
  });

  it('saves what it shows, under the name of the case', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    const shown = previewSvg();

    await user.click(screen.getByTestId('sld-figure-download-svg'));

    await waitFor(() => expect(downloads.filenames).toHaveLength(1));
    const [filename] = downloads.filenames;
    const [blob] = downloads.blobs;
    expect(filename).toMatch(/^column_figure_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.svg$/);
    expect(blob!.type).toBe('image/svg+xml;charset=utf-8');
    expect(await readBlob(blob!)).toBe(shown);
    expect(screen.getByTestId('sld-figure-status')).toHaveTextContent(`Saved ${filename}`);
  });
});

describe('the choices of a figure are settings of the diagram', () => {
  it('keeps a choice in the store, in the layout every save sends, and in the file beside the case', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);

    await user.click(screen.getByTestId('sld-figure-style-colour'));
    await user.selectOptions(screen.getByTestId('sld-figure-font'), 'serif');

    expect(useCaseStore.getState().figureSettings).toMatchObject({
      monochrome: false,
      font: 'serif',
    });
    expect(useCaseStore.getState().diagramLayout?.figure).toMatchObject({
      monochrome: false,
      font: 'serif',
      font_size: 10,
    });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalled(), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls.at(-1) as [{ casePath: string; layout: SidecarLayout }];
    expect(vars.casePath).toBe('column.xlsx');
    expect(vars.layout.figure).toMatchObject({ monochrome: false, font: 'serif' });
    // With the placement, which a layout that only held the choices would lose.
    expect(Object.keys(vars.layout.coordinates)).toEqual(['1', '2', '3']);
  });

  it('opens with what the saved layout holds, and with the default where that is no setting', async () => {
    mockSidecar = placed({
      [CONNECTOR_STYLE_SETTING]: 'elbow',
      monochrome: false,
      font: 'mono',
      font_size: 8,
      bus_names: false,
      dpi: 600,
      // Written by hand, or by another build: not a width a figure has.
      line_width: 'heavy',
    });
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);

    expect(screen.getByTestId('sld-figure-style-colour')).toBeChecked();
    expect(screen.getByTestId('sld-figure-font')).toHaveValue('mono');
    expect(screen.getByTestId('sld-figure-font-size')).toHaveValue('8');
    expect(screen.getByTestId('sld-figure-bus-names')).not.toBeChecked();
    expect(screen.getByTestId('sld-figure-dpi')).toHaveValue('600');
    expect(screen.getByTestId('sld-figure-line-width')).toHaveValue('1.5');
    expect(said().sort()).toEqual(['PQ_A', 'PQ_B']);
    // Nothing was chosen in this visit, and nothing is written for looking.
    expect(useCaseStore.getState().figureSettings).toBeNull();
    cleanup();
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('leaves the connector style, which shares the section, where it is', async () => {
    mockSidecar = placed({ [CONNECTOR_STYLE_SETTING]: 'elbow' });
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    await user.click(screen.getByTestId('sld-figure-chips'));
    expect(useCaseStore.getState().diagramLayout?.figure).toMatchObject({
      [CONNECTOR_STYLE_SETTING]: 'elbow',
      chips: false,
    });
  });

  it('keeps the choices when the placement is reset', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    await user.selectOptions(screen.getByTestId('sld-figure-dpi'), '150');
    await user.click(screen.getByTestId('sld-figure-close'));
    __clearAllPendingForTests();
    putSidecarSpy.mockClear();

    act(() => __requestSldCommand('reset-layout'));

    expect(putSidecarSpy).toHaveBeenCalledTimes(1);
    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    expect(vars.layout.coordinates).toEqual({});
    expect(vars.layout.figure).toMatchObject({ dpi: 150, monochrome: true });
  });

  it('goes back to the defaults, and keeps that as it keeps any choice', async () => {
    mockSidecar = placed({ font: 'serif', flows: false });
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    expect(screen.getByTestId('sld-figure-font')).toHaveValue('serif');

    await user.click(screen.getByTestId('sld-figure-reset'));

    expect(screen.getByTestId('sld-figure-font')).toHaveValue('sans');
    expect(useCaseStore.getState().diagramLayout?.figure).toMatchObject({
      font: 'sans',
      flows: true,
    });
  });

  it('keeps them for a system built from scratch, which has no file to write them beside', async () => {
    mockSidecar = null;
    mockTopology = { ...column(), lines: [] };
    const user = userEvent.setup();
    open(null);
    await draw();
    await openFigure(user);
    await user.click(screen.getByTestId('sld-figure-style-colour'));
    expect(useCaseStore.getState().diagramLayout?.figure).toMatchObject({
      monochrome: false,
    });
    cleanup();
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('forgets them with the case they were made for', async () => {
    const user = userEvent.setup();
    open('column.xlsx');
    await draw();
    await openFigure(user);
    await user.click(screen.getByTestId('sld-figure-style-colour'));
    expect(useCaseStore.getState().figureSettings).not.toBeNull();
    act(() => open('other.xlsx'));
    expect(useCaseStore.getState().figureSettings).toBeNull();
  });
});
