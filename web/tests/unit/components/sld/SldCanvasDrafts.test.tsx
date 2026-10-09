/**
 * Drafts on the diagram, as the canvas draws them and acts on them.
 *
 * A component dropped from the palette is on the diagram at once, as a
 * draft: a symbol of its own where it was dropped, picked, with nothing sent
 * to the server. Given a bus it is connected to it; a line that names both
 * its buses is drawn as the branch it will be. A draft is moved like a
 * device and keeps where it stands, is deleted by a key, is listed over the
 * diagram, and is no part of the layout that is written beside the case. An
 * element that was added from a draft stands where its draft stood.
 *
 * React Flow is replaced by a recorder of what it was asked to draw and of
 * the handlers it was given, as in `SldCanvasArrange.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';

interface DrawnNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  selected?: boolean;
  ariaLabel?: string;
  data: Record<string, unknown>;
}
interface DrawnEdge {
  id: string;
  type?: string;
  source: string;
  target: string;
  ariaLabel?: string;
  data?: Record<string, unknown>;
}
type Change = {
  id: string;
  type: 'position';
  position: { x: number; y: number };
  dragging: boolean;
};
type DragHandler = (
  event: unknown,
  node: Pick<DrawnNode, 'id' | 'position'>,
  nodes: Pick<DrawnNode, 'id' | 'position'>[],
) => void;

const drawn: {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  onNodesChange: ((changes: Change[]) => void) | null;
  onNodeDragStart: DragHandler | null;
  onNodeDragStop: DragHandler | null;
  onNodeClick: ((event: unknown, node: DrawnNode) => void) | null;
  onEdgeClick: ((event: unknown, edge: DrawnEdge) => void) | null;
  onInteractiveChange: ((interactive: boolean) => void) | null;
} = {
  nodes: [],
  edges: [],
  onNodesChange: null,
  onNodeDragStart: null,
  onNodeDragStop: null,
  onNodeClick: null,
  onEdgeClick: null,
  onInteractiveChange: null,
};
const setCenter = vi.fn();

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    // The wrapper of each node and edge is drawn, as React Flow draws it:
    // the keys of the diagram are read off whichever has the focus.
    ReactFlow: (props: {
      nodes: DrawnNode[];
      edges: DrawnEdge[];
      onNodesChange: (changes: Change[]) => void;
      onNodeDragStart: DragHandler;
      onNodeDragStop: DragHandler;
      onNodeClick: (event: unknown, node: DrawnNode) => void;
      onEdgeClick: (event: unknown, edge: DrawnEdge) => void;
      children?: ReactNode;
    }) => {
      Object.assign(drawn, {
        nodes: props.nodes,
        edges: props.edges,
        onNodesChange: props.onNodesChange,
        onNodeDragStart: props.onNodeDragStart,
        onNodeDragStop: props.onNodeDragStop,
        onNodeClick: props.onNodeClick,
        onEdgeClick: props.onEdgeClick,
      });
      return React.createElement(
        React.Fragment,
        null,
        ...props.nodes.map((n) =>
          React.createElement('div', {
            key: `node-${n.id}`,
            className: 'react-flow__node',
            'data-id': n.id,
            'data-testid': `rf-node-${n.id}`,
            tabIndex: 0,
          }),
        ),
        ...props.edges.map((e) =>
          React.createElement('div', {
            key: `edge-${e.id}`,
            className: 'react-flow__edge',
            'data-id': e.id,
            'data-testid': `rf-edge-${e.id}`,
            tabIndex: 0,
          }),
        ),
        props.children,
      );
    },
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    Handle: () => null,
    Background: () => null,
    // The padlock of the controls: a test locks the diagram through it.
    Controls: (props: { onInteractiveChange?: (interactive: boolean) => void }) => {
      drawn.onInteractiveChange = props.onInteractiveChange ?? null;
      return null;
    },
    MiniMap: () => null,
    BaseEdge: () => null,
    BackgroundVariant: { Lines: 'lines', Dots: 'dots', Cross: 'cross' },
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    SelectionMode: { Partial: 'partial', Full: 'full' },
    useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
    useReactFlow: () => ({
      setCenter,
      getZoom: () => 1,
      getNodes: () => [],
      fitView: vi.fn(),
      // The screen is the diagram, one to one.
      screenToFlowPosition: (p: { x: number; y: number }) => p,
      flowToScreenPosition: (p: { x: number; y: number }) => p,
    }),
  };
});

// Two buses to a row, 300 apart, the rows 220 apart.
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async (graph: { children?: { id: string }[] }) => ({
    children: (graph.children ?? []).map((c, i) => ({
      id: c.id,
      x: 300 * (i % 2),
      y: 220 * Math.floor(i / 2),
    })),
  })),
}));

import { SldCanvas } from '@/components/sld/SldCanvas';
import { DRAFT_NODE_SIZE, draftBranchEdgeId } from '@/components/sld/drafts';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useDraftsStore, type DraftElement } from '@/store/drafts';
import { useLayoutStore } from '@/store/layout';
import { useLayoutHistoryStore } from '@/store/layoutHistory';
import { __requestSldCommand, useSldStore } from '@/store/sld';
import { parseWorkspacePath } from '@/api/types';
import type { SidecarLayout, TopologyEntry, TopologySummary } from '@/api/types';
import { TOPOLOGY_SCHEMA } from '../../helpers/topologySchema';

let mockTopology: TopologySummary | null = null;
const mockSidecar: SidecarLayout | null = null;
// The fields of each model: `undefined` while they are still on their way.
let mockSchema: typeof TOPOLOGY_SCHEMA | undefined = TOPOLOGY_SCHEMA;
const putSidecarSpy = vi.fn();

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useGetSidecar: () => ({ data: mockSidecar, isLoading: false, isError: false, error: null }),
    usePutSidecar: () => ({ mutate: putSidecarSpy }),
    useCurrentTopology: () => mockTopology,
    useTopologySchema: () => ({ data: mockSchema }),
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

const CASE = 'square.xlsx';
const MIME = 'application/andes-component-type';
const { width: W, height: H } = DRAFT_NODE_SIZE;

function entry(idx: string | number, kind: string, params: TopologyEntry['params']): TopologyEntry {
  return { idx, name: String(idx), kind, params };
}

/** Four buses, two to a row, with a line from bus 1 to bus 2 and a load on bus 4. */
function square(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [1, 2, 3, 4].map((i) => entry(i, 'Bus', { Vn: 110 })),
    lines: [entry('L12', 'Line', { bus1: 1, bus2: 2 })],
    transformers: [],
    generators: [],
    loads: [entry('PQ_1', 'PQ', { bus: 4 })],
    shunts: [],
    controllers: [],
  };
}

const drafts = (): DraftElement[] => useDraftsStore.getState().byCase[CASE] ?? [];
const node = (id: string) => drawn.nodes.find((n) => n.id === id);
const edge = (id: string) => drawn.edges.find((e) => e.id === id);

async function draw(): Promise<void> {
  render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
}

/** Drop the row of the palette for `kind` with the pointer at `x`, `y` of the diagram. */
function drop(kind: string, x: number, y: number): void {
  const surface = screen.getByTestId('sld-canvas-surface');
  const dataTransfer = {
    getData: (mime: string) => (mime === MIME ? kind : ''),
    types: [MIME],
    dropEffect: 'copy',
  };
  const event = createEvent.drop(surface, { dataTransfer });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  act(() => {
    fireEvent(surface, event);
  });
}

/** Give the draft `id` values, as its form in the Inspector does. */
function give(id: string, values: DraftElement['values']): void {
  act(() => useDraftsStore.getState().setValues(CASE, id, values));
}

/** Drag the node `id` to `to` and let it go. */
function dragTo(id: string, to: { x: number; y: number }): void {
  const from = node(id)!.position;
  act(() => drawn.onNodeDragStart!(null, { id, position: from }, [{ id, position: from }]));
  act(() => drawn.onNodesChange!([{ id, type: 'position', position: to, dragging: true }]));
  act(() => drawn.onNodesChange!([{ id, type: 'position', position: to, dragging: false }]));
  act(() => drawn.onNodeDragStop!(null, { id, position: to }, [{ id, position: to }]));
}

beforeEach(() => {
  Object.assign(drawn, { nodes: [], edges: [] });
  setCenter.mockReset();
  putSidecarSpy.mockReset();
  mockTopology = square();
  mockSchema = TOPOLOGY_SCHEMA;
  useDraftsStore.setState({ byCase: {}, placements: {}, routes: {}, kept: {} });
  useLayoutHistoryStore.getState().clear();
  useSldStore.getState().clearSelectedNodeId();
  useSldStore.setState({ pickedNodeIds: [] });
  useLayoutStore.setState({ sldSnapToGrid: false });
  useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(CASE), addfiles: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCaseStore.getState().clearCase();
  useDraftsStore.setState({ byCase: {}, placements: {}, routes: {} });
});

describe('a component dropped on the diagram', () => {
  it('is on it at once as a draft, where it was dropped, picked, with the list over the diagram', async () => {
    await draw();
    expect(screen.queryByTestId('sld-drafts-indicator')).toBeNull();
    drop('PV', 700, 500);
    expect(drafts()).toEqual([
      { id: 'draft-1', kind: 'PV', position: { x: 700 - W / 2, y: 500 - H / 2 }, values: {} },
    ]);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(node('draft-1')).toMatchObject({
      type: 'draft',
      position: { x: 700 - W / 2, y: 500 - H / 2 },
      selected: true,
      ariaLabel: 'Draft PV generator PV_1: Missing bus, Sn, Vn, p0 and v0',
      data: { draft: true, kind: 'PV', ready: false },
    });
    // Picked on the diagram: the Inspector shows its form, and the view stays.
    expect(useSldStore.getState()).toMatchObject({
      selectedNodeId: 'draft-1',
      selectedOnDiagram: true,
    });
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    const indicator = screen.getByTestId('sld-drafts-indicator');
    expect(indicator).toHaveAttribute('data-draft-count', '1');
    expect(indicator).toHaveAttribute('data-incomplete-count', '1');
  });

  it('stands in the nearest free place when it is dropped on a bar it is not connected to, and a notice says so', async () => {
    const info = vi.spyOn(toast, 'info');
    await draw();
    const bar = node('1')!.position;
    // A bus is on no bus: dropped on a bar, it only has to stand clear of it.
    drop('Bus', bar.x + 46, bar.y + 3);
    const at = drafts()[0]!.position;
    // Clear of the bar it was dropped on.
    expect(at.y + H <= bar.y || at.y >= bar.y + 6 || at.x >= bar.x + 92 || at.x + W <= bar.x).toBe(
      true,
    );
    expect(info).toHaveBeenCalledWith(
      'Draft placed in the nearest free place',
      expect.objectContaining({ description: expect.stringContaining('Drag it to move it.') }),
    );
  });

  it('closes a form that is open with nothing typed, and leaves one that holds something', async () => {
    await draw();
    act(() => useCaseStore.getState().openAddPanel('Bus'));
    drop('PV', 700, 500);
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    act(() => {
      useCaseStore.getState().openAddPanel('Bus');
      useCaseStore.getState().setAddPanelDirty(true);
    });
    drop('PQ', 700, 300);
    expect(useCaseStore.getState().addPanelOpen).toBe(true);
    expect(drafts()).toHaveLength(2);
  });

  it('writes nothing of the draft beside the case', async () => {
    await draw();
    drop('PV', 700, 500);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    const layout = useCaseStore.getState().diagramLayout;
    expect(layout).not.toBeNull();
    expect(JSON.stringify(layout)).not.toContain('draft');
  });
});

describe('a draft that is given a bus', () => {
  it('is connected to it by a dashed connector of its own, like the device it will be', async () => {
    await draw();
    const bus = node('3')!.position;
    // Over bus 3, where a device of that bus would stand.
    drop('PQ', bus.x + 46, bus.y - 90);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(edge('stub-draft-1')).toBeUndefined();
    give('draft-1', { bus: '3' });
    await waitFor(() => expect(edge('stub-draft-1')).toBeDefined());
    const stub = edge('stub-draft-1')!;
    expect(stub).toMatchObject({
      type: 'stub',
      source: 'draft-1',
      target: '3',
      data: { draft: true, draftId: 'draft-1', ready: false, active: true },
    });
    // It leaves the middle of the face that looks at the bus, and lands on the bar.
    const route = (stub.data!.route as { points: [number, number][] }).points;
    const at = node('draft-1')!.position;
    expect(route[0]).toEqual([at.x + W / 2, at.y + H]);
    expect(route.at(-1)![1]).toBe(bus.y + 3);
    expect(node('draft-1')!.data.parentBus).toBe('3');
  });

  it('goes beside that bus when it was dropped far from it, and a notice says so', async () => {
    const info = vi.spyOn(toast, 'info');
    await draw();
    const [one, four] = [node('1')!.position, node('4')!.position];
    // Far to the left of bus 1; bus 4 is across the diagram.
    drop('PQ', one.x - 400, one.y);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    give('draft-1', { bus: '4' });
    await waitFor(() => {
      const at = node('draft-1')!.position;
      expect(Math.abs(at.x + W / 2 - (four.x + 46))).toBeLessThan(200);
    });
    expect(info).toHaveBeenCalledWith(
      'Draft moved next to bus 4',
      expect.objectContaining({ description: expect.stringContaining('Drag it to move it.') }),
    );
    // Where it stands is kept with the draft.
    await waitFor(() => expect(drafts()[0]!.position).toEqual(node('draft-1')!.position));
  });

  it('is drawn as the branch it will be once a line names both its buses, in the place of its symbol', async () => {
    await draw();
    drop('Line', 700, 500);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    give('draft-1', { bus1: '3' });
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    give('draft-1', { bus2: '4' });
    const id = draftBranchEdgeId('draft-1');
    await waitFor(() => expect(edge(id)).toBeDefined());
    expect(node('draft-1')).toBeUndefined();
    expect(edge(id)).toMatchObject({
      source: '3',
      target: '4',
      data: { draft: true, draftId: 'draft-1', active: true },
    });
    // Its route is worked out with the rest, and it is still listed.
    await waitFor(() =>
      expect((edge(id)!.data!.route as { points: unknown[] }).points.length).toBeGreaterThan(1),
    );
    expect(screen.getByTestId('sld-drafts-indicator')).toHaveAttribute('data-draft-count', '1');
  });

  it('a click on the line of a draft picks the draft, and no route to move by hand', async () => {
    useDraftsStore.setState({
      byCase: {
        [CASE]: [
          {
            id: 'draft-1',
            kind: 'Line',
            position: { x: 700, y: 500 },
            values: { bus1: '3', bus2: '4' },
          },
        ],
      },
    });
    await draw();
    const id = draftBranchEdgeId('draft-1');
    await waitFor(() => expect(edge(id)).toBeDefined());
    expect(edge(id)!.data!.active).toBeUndefined();
    act(() => drawn.onEdgeClick!(null, edge(id)!));
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    await waitFor(() => expect(edge(id)!.data!.active).toBe(true));
    expect(screen.queryByTestId('sld-route-editor')).toBeNull();
    // The line of the system beside it is not marked for it.
    expect(edge('line-L12')!.data!.active).toBeUndefined();
  });
});

describe('a draft on the diagram', () => {
  const HELD: DraftElement[] = [
    { id: 'draft-1', kind: 'PV', position: { x: 700, y: 400 }, values: {} },
    { id: 'draft-2', kind: 'Line', position: { x: 700, y: 600 }, values: { bus1: '3', bus2: '4' } },
  ];

  it('is there again when its case is opened again, where it stood', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(node('draft-1')!.position).toEqual({ x: 700, y: 400 });
    expect(edge(draftBranchEdgeId('draft-2'))).toBeDefined();
    // Not picked: nothing was asked about it yet.
    expect(node('draft-1')!.selected).toBe(false);
  });

  it('is moved like a device, and keeps where it was dropped', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    dragTo('draft-1', { x: 760, y: 120 });
    await waitFor(() => expect(node('draft-1')!.position).toEqual({ x: 760, y: 120 }));
    expect(drafts()[0]!.position).toEqual({ x: 760, y: 120 });
  });

  it('is not drawn again for a value typed into its form that changes nothing of what is drawn', async () => {
    useDraftsStore.setState({
      byCase: {
        [CASE]: [{ id: 'draft-1', kind: 'PV', position: { x: 700, y: 400 }, values: { Sn: '1' } }],
      },
    });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    const before = node('draft-1')!.data;
    // More of a number that was begun: the draft holds it, the diagram is as it was.
    give('draft-1', { Sn: '100' });
    expect(drafts()[0]!.values.Sn).toBe('100');
    expect(node('draft-1')!.data).toBe(before);
    // A field that was missing is given: what the draft lacks is said anew.
    give('draft-1', { Vn: '69' });
    await waitFor(() => expect(node('draft-1')!.data).not.toBe(before));
    expect(node('draft-1')!.ariaLabel).toBe('Draft PV generator PV_1: Missing bus, p0 and v0');
  });

  it('writes no layout beside the case for a move of a draft, and one for a move of a bus', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    dragTo('draft-1', { x: 760, y: 120 });
    await waitFor(() => expect(drafts()[0]!.position).toEqual({ x: 760, y: 120 }));
    // Past the delay a write waits out.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(putSidecarSpy).not.toHaveBeenCalled();
    const bus = node('2')!.position;
    dragTo('2', { x: bus.x + 40, y: bus.y - 60 });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalled(), { timeout: 3000 });
    const [{ layout }] = putSidecarSpy.mock.calls.at(-1) as [{ layout: SidecarLayout }];
    expect(JSON.stringify(layout)).not.toContain('draft');
  });

  it('is deleted by Delete or Backspace while it has the focus, its symbol or its line', async () => {
    const info = vi.spyOn(toast, 'info');
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    fireEvent.keyDown(screen.getByTestId('rf-node-draft-1'), { key: 'Delete' });
    expect(drafts().map((d) => d.id)).toEqual(['draft-2']);
    expect(info).toHaveBeenCalledWith(
      'Draft deleted: PV generator PV_1',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
    await waitFor(() => expect(node('draft-1')).toBeUndefined());
    fireEvent.keyDown(screen.getByTestId(`rf-edge-${draftBranchEdgeId('draft-2')}`), {
      key: 'Backspace',
    });
    expect(drafts()).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('sld-drafts-indicator')).toBeNull());
  });

  it('comes back by Undo once the notice of its delete is gone, and goes again by Redo', async () => {
    const info = vi.spyOn(toast, 'info');
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    fireEvent.keyDown(screen.getByTestId('rf-node-draft-1'), { key: 'Delete' });
    await waitFor(() => expect(node('draft-1')).toBeUndefined());
    // Undo, in the Edit menu and by Ctrl+Z, names it and takes it back.
    expect(useLayoutHistoryStore.getState().past.at(-1)?.label).toBe(
      'delete draft PV generator PV_1',
    );
    act(() => __requestSldCommand('undo-layout'));
    expect(drafts()).toEqual(HELD);
    await waitFor(() => expect(node('draft-1')!.position).toEqual({ x: 700, y: 400 }));
    expect(info).toHaveBeenLastCalledWith('Undone: delete draft PV generator PV_1');
    // Back, it is the one that is picked: its form is what the user wants next.
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    act(() => __requestSldCommand('redo-layout'));
    expect(drafts().map((d) => d.id)).toEqual(['draft-2']);
    expect(info).toHaveBeenLastCalledWith('Redone: delete draft PV generator PV_1');
    act(() => __requestSldCommand('undo-layout'));
    expect(drafts()).toEqual(HELD);
  });

  it('comes back by Undo on a locked diagram too: the lock is on the arrangement', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    fireEvent.click(screen.getByTestId('sld-drafts-indicator'));
    fireEvent.click(await screen.findByTestId('sld-drafts-delete-all'));
    expect(drafts()).toEqual([]);
    act(() => drawn.onInteractiveChange!(false));
    expect(screen.getByTestId('sld-canvas-locked')).toBeInTheDocument();
    act(() => __requestSldCommand('undo-layout'));
    expect(drafts()).toEqual(HELD);
  });

  it('says once, with what to do about them, that drafts were kept from an earlier visit', async () => {
    const info = vi.spyOn(toast, 'info');
    // As the store has them when the page starts with drafts in the browser.
    useDraftsStore.setState({
      byCase: { [CASE]: HELD },
      kept: { [CASE]: HELD.map((d) => d.id) },
    });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '2 drafts from an earlier visit are kept in this browser',
      expect.objectContaining({
        description: expect.stringContaining('is not in the system yet'),
        action: expect.objectContaining({ label: 'Show' }),
        secondary: expect.objectContaining({ label: 'Delete all' }),
      }),
    );
    const notice = info.mock.calls[0]![1] as {
      action: { onClick: () => void };
      secondary: { onClick: () => void };
    };
    // Show opens the list over the diagram.
    expect(screen.queryByTestId('sld-drafts-list')).toBeNull();
    act(() => notice.action.onClick());
    expect(await screen.findByTestId('sld-drafts-list')).toBeInTheDocument();
    // Delete all removes them, and Undo brings them back.
    act(() => notice.secondary.onClick());
    expect(drafts()).toEqual([]);
    act(() => __requestSldCommand('undo-layout'));
    expect(drafts()).toEqual(HELD);
    // Said once: not again for the same case in this visit.
    expect(useDraftsStore.getState().takeKept(CASE)).toBe(0);
  });

  it('says nothing of an earlier visit for drafts that were placed in this one', async () => {
    const info = vi.spyOn(toast, 'info');
    useDraftsStore.setState({ byCase: { [CASE]: HELD }, kept: {} });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(info).not.toHaveBeenCalled();
  });

  it('takes nothing of the system out by a key: a bus and a line stay', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    fireEvent.keyDown(screen.getByTestId('rf-node-1'), { key: 'Delete' });
    fireEvent.keyDown(screen.getByTestId('rf-edge-line-L12'), { key: 'Backspace' });
    expect(node('1')).toBeDefined();
    expect(edge('line-L12')).toBeDefined();
    expect(drafts()).toHaveLength(2);
  });

  it('is picked by Enter on its symbol, and by a click on it', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    fireEvent.keyDown(screen.getByTestId('rf-node-draft-1'), { key: 'Enter' });
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    // The bus that was inspected is let go of: the Inspector shows the draft.
    expect(useCaseStore.getState().selectedElement).toBeNull();
    act(() => useSldStore.getState().clearSelectedNodeId());
    act(() => drawn.onNodeClick!(null, node('draft-1')!));
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    await waitFor(() => expect(node('draft-1')!.selected).toBe(true));
  });

  it('is found from the list over the diagram, which brings a line into view by its middle', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(edge(draftBranchEdgeId('draft-2'))?.data?.route).toBeDefined());
    fireEvent.click(screen.getByTestId('sld-drafts-indicator'));
    fireEvent.click(await screen.findByTestId('sld-drafts-row-draft-2'));
    expect(useSldStore.getState()).toMatchObject({
      selectedNodeId: 'draft-2',
      selectedOnDiagram: false,
    });
    await waitFor(() => expect(setCenter).toHaveBeenCalled());
    const route = (
      edge(draftBranchEdgeId('draft-2'))!.data!.route as { points: [number, number][] }
    ).points;
    const xs = route.map((p) => p[0]);
    const [x] = setCenter.mock.calls.at(-1)!;
    expect(x).toBeGreaterThanOrEqual(Math.min(...xs));
    expect(x).toBeLessThanOrEqual(Math.max(...xs));
  });

  it('is deleted from the list, one by its row and all at once', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    fireEvent.click(screen.getByTestId('sld-drafts-indicator'));
    fireEvent.click(await screen.findByTestId('sld-drafts-delete-draft-1'));
    expect(drafts().map((d) => d.id)).toEqual(['draft-2']);
    act(() => {
      useDraftsStore.getState().add(CASE, 'Bus', { x: 900, y: 100 });
    });
    fireEvent.click(await screen.findByTestId('sld-drafts-delete-all'));
    expect(drafts()).toEqual([]);
  });

  it('is not marked as picked once an element of the system is selected', async () => {
    useDraftsStore.setState({ byCase: { [CASE]: HELD } });
    await draw();
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    act(() => drawn.onNodeClick!(null, node('draft-1')!));
    await waitFor(() => expect(node('draft-1')!.selected).toBe(true));
    // Inspect in a right-click menu selects an element and leaves the node.
    act(() => useCaseStore.getState().setSelectedElement({ kind: 'line', idx: 'L12' }));
    await waitFor(() => expect(node('draft-1')!.selected).toBe(false));
  });
});

describe('a line that a draft stands on', () => {
  const routeOf = (id: string) => (edge(id)!.data!.route as { points: [number, number][] }).points;
  /**
   * Where a draft stands on the longest run of the route `points`: across
   * it, and clear of the bars the route ends on.
   */
  function onLongestRun(points: [number, number][]): { x: number; y: number } {
    let best: { x: number; y: number; long: number } | null = null;
    for (let i = 1; i < points.length; i += 1) {
      const [a, b] = [points[i - 1]!, points[i]!];
      const long = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (best === null || long > best.long) {
        best = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, long };
      }
    }
    return { x: best!.x - W / 2, y: best!.y - H + 8 };
  }
  /** Put a draft where no drop or drag would: it came with the case, on a line. */
  function hold(position: { x: number; y: number }): string {
    let id = '';
    act(() => {
      id = useDraftsStore.getState().add(CASE, 'PQ', position)!.id;
    });
    return id;
  }

  it('goes round it while it stands there, and runs as before once the draft is moved off or deleted', async () => {
    await draw();
    await waitFor(() => expect(edge('line-L12')?.data?.route).toBeDefined());
    const before = routeOf('line-L12');
    const kept = useCaseStore.getState().routeOverrides;
    // The routes in the layout a save of the system takes along.
    const saved = () => JSON.stringify(useCaseStore.getState().diagramLayout?.branches);
    const layout = saved();
    expect(layout).toContain('bend_points');
    const onLine = onLongestRun(before);
    const first = hold(onLine);
    await waitFor(() => expect(node(first)).toBeDefined());
    await waitFor(() => expect(routeOf('line-L12')).not.toEqual(before));
    expect(node(first)!.position).toEqual(onLine);
    // Round the draft on the diagram, and nowhere else: the route the
    // diagram keeps, and the layout a save takes along, are as they were.
    expect(useCaseStore.getState().routeOverrides).toEqual(kept);
    expect(saved()).toBe(layout);
    // Moved off the line: it runs as before.
    dragTo(first, { x: 700, y: 500 });
    await waitFor(() => expect(routeOf('line-L12')).toEqual(before));
    // Another on the line, then deleted.
    const second = hold(onLine);
    await waitFor(() => expect(routeOf('line-L12')).not.toEqual(before));
    fireEvent.keyDown(screen.getByTestId(`rf-node-${second}`), { key: 'Delete' });
    await waitFor(() => expect(node(second)).toBeUndefined());
    await waitFor(() => expect(routeOf('line-L12')).toEqual(before));
    expect(useCaseStore.getState().routeOverrides).toEqual(kept);
    expect(saved()).toBe(layout);
  });

  it('is left as it runs by a draft that is dropped on it, or dragged onto it: the draft stands beside it', async () => {
    const info = vi.spyOn(toast, 'info');
    await draw();
    await waitFor(() => expect(edge('line-L12')?.data?.route).toBeDefined());
    const before = routeOf('line-L12');
    const onLine = onLongestRun(before);
    /** Whether a draft at `at` is off every run of the line, by the room a symbol keeps. */
    const beside = (at: { x: number; y: number }): boolean =>
      before.every((b, i) => {
        if (i === 0) return true;
        const a = before[i - 1]!;
        return (
          at.x >= Math.max(a[0], b[0]) + 8 ||
          at.x + W <= Math.min(a[0], b[0]) - 8 ||
          at.y >= Math.max(a[1], b[1]) + 8 ||
          at.y + H <= Math.min(a[1], b[1]) - 8
        );
      });
    expect(beside(onLine)).toBe(false);
    drop('PQ', onLine.x + W / 2, onLine.y + H / 2);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(beside(node('draft-1')!.position)).toBe(true);
    expect(routeOf('line-L12')).toEqual(before);
    // A load goes on a bus and was dropped on none: the notice says that
    // first, since a draft beside a bus looks connected, and then where it
    // came to stand.
    expect(info).toHaveBeenCalledWith(
      'PQ load PQ_2 is not on a bus yet',
      expect.objectContaining({
        description: expect.stringMatching(
          /^It was placed in the nearest free place\. .*Drag it to move it\. Pick its bus in its form in the Inspector, or drag it onto the bar or the name of a bus\.$/,
        ),
        action: expect.objectContaining({ label: 'Pick a bus' }),
      }),
    );
    // Dragged onto the line by hand, with free ground right beside it: there.
    info.mockClear();
    dragTo('draft-1', onLine);
    await waitFor(() => expect(drafts()[0]!.position).toEqual(node('draft-1')!.position));
    expect(node('draft-1')!.position).not.toEqual(onLine);
    expect(routeOf('line-L12')).toEqual(before);
    expect(info).toHaveBeenCalledWith(
      'Moved to the nearest free place',
      expect.objectContaining({ description: expect.stringContaining('dropped on a line') }),
    );
  });

  it('goes round it afresh from the route it keeps when a bus of the line is moved', async () => {
    await draw();
    await waitFor(() => expect(edge('line-L12')?.data?.route).toBeDefined());
    const before = routeOf('line-L12');
    const id = hold(onLongestRun(before));
    await waitFor(() => expect(routeOf('line-L12')).not.toEqual(before));
    // Bus 2 goes down a row: the line is the diagram's to route again, and
    // what it keeps for it is a route for the buses where they stand now.
    const two = node('2')!.position;
    dragTo('2', { x: two.x, y: two.y + 96 });
    await waitFor(() =>
      expect(useCaseStore.getState().routeOverrides['line-L12']?.anchors.target).toEqual({
        x: two.x,
        y: two.y + 96,
      }),
    );
    // With the draft deleted the line is drawn along that route.
    fireEvent.keyDown(screen.getByTestId(`rf-node-${id}`), { key: 'Delete' });
    await waitFor(() => expect(node(id)).toBeUndefined());
    await waitFor(() =>
      expect(routeOf('line-L12')).toEqual(
        useCaseStore.getState().routeOverrides['line-L12']!.points,
      ),
    );
  });
});

describe('a case with drafts that is opened again', () => {
  const routeOf = (id: string) => (edge(id)!.data!.route as { points: [number, number][] }).points;
  const LINE = draftBranchEdgeId('draft-2');
  const kept = () => Object.values(useDraftsStore.getState().routes[CASE] ?? {}).at(-1);

  /**
   * A draft on the line from bus 1 to bus 2, which goes round it, and a
   * draft line from bus 1 to bus 3, each as the diagram came to draw it.
   */
  async function withDraftsOnIt() {
    await draw();
    await waitFor(() => expect(edge('line-L12')?.data?.route).toBeDefined());
    const before = routeOf('line-L12');
    const [a, b] = [before[1]!, before[2]!];
    act(() => {
      const { add } = useDraftsStore.getState();
      add(CASE, 'PQ', { x: (a[0] + b[0]) / 2 - W / 2, y: (a[1] + b[1]) / 2 - H + 8 });
      add(CASE, 'Line', { x: 0, y: 0 }, { bus1: '1', bus2: '3' });
    });
    await waitFor(() => expect(routeOf('line-L12')).not.toEqual(before));
    await waitFor(() => expect(edge(LINE)?.data?.route).toBeDefined());
    // Kept with the drafts once the diagram is at rest.
    await waitFor(() => expect(kept()?.round['line-L12']?.points).toEqual(routeOf('line-L12')));
    await waitFor(() => expect(kept()?.own[LINE]?.points).toEqual(routeOf(LINE)));
    return { before };
  }

  /** Close the case and open it again, as a reload of the page does: the drafts are this browser's still. */
  async function reopen(): Promise<void> {
    cleanup();
    Object.assign(drawn, { nodes: [], edges: [] });
    useCaseStore.getState().clearCase();
    useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(CASE), addfiles: [] });
    await draw();
  }

  it('keeps how the lines run among the drafts with the drafts, and nothing of it in the layout', async () => {
    const { before } = await withDraftsOnIt();
    const system = Object.keys(useDraftsStore.getState().routes[CASE]!);
    expect(system).toHaveLength(1);
    expect(kept()).toMatchObject({
      own: { [LINE]: { anchors: { source: node('1')!.position, target: node('3')!.position } } },
      // In the place of the route the line keeps, which is the one it had.
      round: { 'line-L12': { from: JSON.stringify(before) } },
    });
    expect(kept()!.stand).toContain('draft-1@');
    // The layout a save takes along holds the line as it ran before the draft.
    const saved = useCaseStore.getState().diagramLayout?.branches?.line?.L12?.bend_points;
    expect(saved?.map((point) => [point.x, point.y])).toEqual(before);
    // With the drafts gone nothing is kept for the case.
    act(() => useDraftsStore.getState().removeAll(CASE));
    await waitFor(() => expect(edge(LINE)).toBeUndefined());
    expect(useDraftsStore.getState().routes[CASE]).toBeUndefined();
  });

  it('is drawn from what was kept: every line as it ran, and none routed afresh', async () => {
    await withDraftsOnIt();
    const [round, own] = [routeOf('line-L12'), routeOf(LINE)];
    await reopen();
    await waitFor(() => expect(edge(LINE)?.data?.route).toBeDefined());
    expect(routeOf('line-L12')).toEqual(round);
    expect(routeOf(LINE)).toEqual(own);
    // The line of the draft came with its route: the diagram made none for it.
    expect(useCaseStore.getState().routeOverrides[LINE]).toBeUndefined();
  });

  it('draws a line along the way that was kept for it, where another would be worked out afresh', async () => {
    await withDraftsOnIt();
    const system = Object.keys(useDraftsStore.getState().routes[CASE]!)[0]!;
    const was = kept()!;
    // Another way round the draft than the diagram finds: the run that passes
    // the draft a step farther out, and the line of the draft a tap along.
    const way = was.round['line-L12']!;
    const draft = node('draft-1')!.position;
    const points = way.points.map(([x, y]): [number, number] => [x, y]);
    let run = 1;
    for (let i = 2; i < points.length; i += 1) {
      const long = (j: number) => Math.abs(points[j]![0] - points[j - 1]![0]);
      if (long(i) > long(run)) run = i;
    }
    const out = points[run]![1] < draft.y + H / 2 ? -16 : 16;
    points[run - 1]![1] += out;
    points[run]![1] += out;
    const line = was.own[LINE]!.points.map(([x, y]): [number, number] => [x + 14, y]);
    act(() =>
      useDraftsStore.getState().keepRoutes(CASE, system, {
        ...was,
        own: { [LINE]: { ...was.own[LINE]!, points: line } },
        round: { 'line-L12': { ...way, points } },
      }),
    );
    await reopen();
    await waitFor(() => expect(edge(LINE)?.data?.route).toBeDefined());
    expect(routeOf('line-L12')).toEqual(points);
    expect(routeOf(LINE)).toEqual(line);
  });

  it('works the ways out afresh for drafts that stand somewhere else than they were kept for', async () => {
    const { before } = await withDraftsOnIt();
    // Moved while the case was closed: in another tab, say.
    act(() => useDraftsStore.getState().move(CASE, { 'draft-1': { x: 700, y: 500 } }));
    await reopen();
    await waitFor(() => expect(node('draft-1')?.position).toEqual({ x: 700, y: 500 }));
    await waitFor(() => expect(routeOf('line-L12')).toEqual(before));
    await waitFor(() => expect(kept()?.round['line-L12']).toBeUndefined());
  });

  it('holds what was kept while the fields of the models are still on their way', async () => {
    const info = vi.spyOn(toast, 'info');
    await withDraftsOnIt();
    const [round, own] = [routeOf('line-L12'), routeOf(LINE)];
    const was = useDraftsStore.getState().routes;
    const stood = drafts().map((d) => d.position);
    // Opened again before they are in: the drafts are drawn on no bus.
    mockSchema = undefined;
    info.mockClear();
    await reopen();
    await waitFor(() => expect(node('draft-2')).toBeDefined());
    expect(edge(LINE)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useDraftsStore.getState().routes).toBe(was);
    // Then they arrive, and the diagram is drawn as it was left.
    mockSchema = TOPOLOGY_SCHEMA;
    act(() => useCaseStore.getState().setSelectedElement({ kind: 'bus', idx: '4' }));
    await waitFor(() => expect(edge(LINE)?.data?.route).toBeDefined());
    await waitFor(() => expect(routeOf('line-L12')).toEqual(round));
    expect(routeOf(LINE)).toEqual(own);
    expect(drafts().map((d) => d.position)).toEqual(stood);
    // No draft was taken for one that was just given its bus, and moved.
    expect(info).not.toHaveBeenCalled();
  });
});

describe('an element that was added from a draft', () => {
  it('stands where its draft stood: a bus with the middle of its bar there', async () => {
    await draw();
    // What the Inspector does when the server has taken the add.
    act(() => useDraftsStore.getState().place('5', { x: 900, y: 500 }));
    mockTopology = { ...square(), buses: [...square().buses, entry(5, 'Bus', { Vn: 110 })] };
    cleanup();
    await draw();
    await waitFor(() => expect(node('5')).toBeDefined());
    await waitFor(() => expect(node('5')!.position).toEqual({ x: 900 - 46, y: 500 - 3 }));
    // The place is the diagram's from here on, like one it was dragged to.
    await waitFor(() => expect(useDraftsStore.getState().placements).toEqual({}));
    expect(useCaseStore.getState().dragOverrides['5']).toEqual({ x: 900 - 46, y: 500 - 3 });
    // It is in the layout a save of the system takes along, and adding it
    // wrote no layout file by itself.
    await waitFor(() =>
      expect(useCaseStore.getState().diagramLayout?.coordinates['5']).toEqual({
        x: 900 - 46,
        y: 500 - 3,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });
});

describe('a system with nothing in it', () => {
  it('draws its diagram for a draft, and goes back to the empty page without one', async () => {
    mockTopology = { ...square(), buses: [], lines: [], loads: [] };
    render(<SldCanvas />);
    expect(screen.getByTestId('sld-empty-system')).toBeInTheDocument();
    act(() => {
      useDraftsStore.getState().add(CASE, 'Bus', { x: -48, y: -32 });
    });
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(screen.queryByTestId('sld-empty-system')).toBeNull();
    act(() => useDraftsStore.getState().removeAll(CASE));
    await waitFor(() => expect(screen.getByTestId('sld-empty-system')).toBeInTheDocument());
  });

  it('keeps its diagram between the add of its first bus from a draft and the topology that has the bus', async () => {
    mockTopology = { ...square(), buses: [], lines: [], loads: [] };
    act(() => {
      useDraftsStore.getState().add(CASE, 'Bus', { x: -48, y: -32 });
    });
    render(<SldCanvas />);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    // What the Inspector does when the server has taken the add: the place
    // is kept, and the draft goes. The topology is still the one without it.
    act(() => {
      useDraftsStore.getState().place('1', { x: 0, y: 0 });
      useDraftsStore.getState().remove(CASE, 'draft-1');
    });
    expect(screen.queryByTestId('sld-empty-system')).toBeNull();
    expect(screen.getByTestId('sld-canvas-surface')).toBeInTheDocument();
  });
});
