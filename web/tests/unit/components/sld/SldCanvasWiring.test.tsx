/**
 * Connecting by a drag, as the canvas acts on it.
 *
 * A component dropped on a bus is a draft on that bus, and so is a draft
 * that is dragged onto one; a line is drawn from one bus to another, by the
 * buttons over the diagram, by a command, or by a line of the palette that
 * is dropped on the bus it starts from; and the end of the connector of a
 * device that is dragged to another bus takes the device there: a draft by
 * what it holds, an element of the system by an edit that the server is
 * sent. `SldWiring.test.tsx` holds the pointers and keys of the overlay, and
 * `wiring.test.ts` what is worked out without a canvas.
 *
 * React Flow is replaced by a recorder of what it was asked to draw and of
 * the handlers it was given, as in `SldCanvasDrafts.test.tsx`; the overlay
 * itself is the real one.
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
  data: Record<string, unknown>;
}
interface DrawnEdge {
  id: string;
  type?: string;
  source: string;
  target: string;
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
} = {
  nodes: [],
  edges: [],
  onNodesChange: null,
  onNodeDragStart: null,
  onNodeDragStop: null,
  onNodeClick: null,
  onEdgeClick: null,
};

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
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
      return React.createElement(React.Fragment, null, props.children);
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
import { useEditJournalStore } from '@/store/editJournal';
import { useLayoutStore } from '@/store/layout';
import { useSessionStore } from '@/store/session';
import { __requestSldCommand, useSldStore } from '@/store/sld';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import { TOPOLOGY_SCHEMA } from '../../helpers/topologySchema';

let mockTopology: TopologySummary | null = null;
const editSpy = vi.fn();
let editPending = false;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useGetSidecar: () => ({ data: null, isLoading: false, isError: false, error: null }),
    usePutSidecar: () => ({ mutate: vi.fn() }),
    useCurrentTopology: () => mockTopology,
    useTopologySchema: () => ({ data: TOPOLOGY_SCHEMA }),
    useEditElements: () => ({ mutate: editSpy, isPending: editPending }),
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

/**
 * Four buses, two to a row, with a line from bus 1 to bus 2, a load on bus 4
 * and a generator with its machine on bus 3. Buses 1 to 3 are rated 69 kV
 * and bus 4 is rated 138 kV.
 */
function square(loadBus = 4): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [1, 2, 3, 4].map((i) => entry(i, 'Bus', { Vn: i === 4 ? 138 : 69 })),
    lines: [entry('L12', 'Line', { bus1: 1, bus2: 2 })],
    transformers: [],
    generators: [
      entry(3, 'PV', { bus: 3, Vn: 69 }),
      entry('GENROU_3', 'GENROU', { bus: 3, gen: 3, Vn: 69 }),
    ],
    loads: [entry('PQ_1', 'PQ', { bus: loadBus, Vn: 138 })],
    shunts: [],
    controllers: [],
  };
}

const drafts = (): DraftElement[] => useDraftsStore.getState().byCase[CASE] ?? [];
const node = (id: string) => drawn.nodes.find((n) => n.id === id);
const edge = (id: string) => drawn.edges.find((e) => e.id === id);
const bus = (id: string) => screen.getByTestId(`sld-wire-bus-${id}`);
const note = () => screen.getByTestId('sld-wire-note');

/** A place on the bar of the bus `id`. */
function onBar(id: string): { x: number; y: number } {
  const at = node(id)!.position;
  return { x: at.x + 46, y: at.y + 3 };
}

async function draw() {
  const view = render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
  return view;
}

/** What a row of the palette for `kind` carries while it is dragged. */
function carrying(kind: string) {
  return { getData: (mime: string) => (mime === MIME ? kind : ''), types: [MIME], dropEffect: '' };
}

/** A drag event of `type` over the diagram, with the pointer at `x`, `y`. */
function dragEvent(type: 'dragOver' | 'drop' | 'dragLeave', kind: string, x: number, y: number) {
  const surface = screen.getByTestId('sld-canvas-surface');
  const event = createEvent[type](surface, { dataTransfer: carrying(kind) });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  act(() => {
    fireEvent(surface, event);
  });
}

/** Drop the row of the palette for `kind` with the pointer at `x`, `y` of the diagram. */
const drop = (kind: string, x: number, y: number) => dragEvent('drop', kind, x, y);

/** Drag the node `id` to `to`; `between` is called before it is let go. */
function dragTo(id: string, to: { x: number; y: number }, between?: () => void): void {
  const from = node(id)!.position;
  act(() => drawn.onNodeDragStart!(null, { id, position: from }, [{ id, position: from }]));
  act(() => drawn.onNodesChange!([{ id, type: 'position', position: to, dragging: true }]));
  between?.();
  act(() => drawn.onNodesChange!([{ id, type: 'position', position: to, dragging: false }]));
  act(() => drawn.onNodeDragStop!(null, { id, position: to }, [{ id, position: to }]));
}

const at = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y });

/** Press the handle `testId` at `from`, drag it to `to` and let go. */
function dragHandle(testId: string, from: { x: number; y: number }, to: { x: number; y: number }) {
  const handle = screen.getByTestId(testId);
  fireEvent.pointerDown(handle, at(from.x, from.y));
  fireEvent.pointerMove(handle, at((from.x + to.x) / 2, (from.y + to.y) / 2));
  fireEvent.pointerMove(handle, at(to.x, to.y));
  fireEvent.pointerUp(handle, at(to.x, to.y));
}

/** Click the place to press over the bus `id`. */
function clickBus(id: string): void {
  const place = onBar(id);
  const handle = bus(id);
  fireEvent.pointerDown(handle, at(place.x, place.y));
  fireEvent.pointerUp(handle, at(place.x, place.y));
}

/** Select the node `id`, as a click on it does. */
function select(id: string): void {
  act(() => drawn.onNodeClick!(null, node(id)!));
}

const hadPointerEvent = 'PointerEvent' in window;

beforeEach(() => {
  // jsdom has no `PointerEvent`: a press would arrive without its button or its place.
  if (!hadPointerEvent) {
    class PointerEventStandIn extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    vi.stubGlobal('PointerEvent', PointerEventStandIn);
  }
  Object.assign(drawn, { nodes: [], edges: [] });
  editSpy.mockReset();
  editPending = false;
  mockTopology = square();
  useDraftsStore.setState({ byCase: {}, placements: {}, connected: {}, routes: {} });
  useSldStore.getState().clearSelectedNodeId();
  useSldStore.setState({ pickedNodeIds: [], paletteDragKind: null });
  useLayoutStore.setState({ sldSnapToGrid: false });
  useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
  useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(CASE), addfiles: [] });
  useEditJournalStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useCaseStore.getState().clearCase();
  useSessionStore.setState({ sessionId: null });
  useDraftsStore.setState({ byCase: {}, placements: {}, connected: {}, routes: {} });
});

describe('a component dropped on a bus', () => {
  it('is a draft on that bus from the start: connected, beside the bar, and said so once', async () => {
    const [success, info] = [vi.spyOn(toast, 'success'), vi.spyOn(toast, 'info')];
    await draw();
    const bar = onBar('1');
    drop('PQ', bar.x, bar.y);
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({ id: 'draft-1', kind: 'PQ', values: { bus: '1' } });
    await waitFor(() => expect(edge('stub-draft-1')).toBeDefined());
    expect(edge('stub-draft-1')).toMatchObject({ type: 'stub', source: 'draft-1', target: '1' });
    // It was dropped on the bar and cannot stand on it.
    const stands = node('draft-1')!.position;
    const top = node('1')!.position.y;
    expect(stands.y + H <= top || stands.y >= top + 6).toBe(true);
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    expect(success).toHaveBeenCalledExactlyOnceWith(
      'Draft PQ load PQ_2 connected to bus 1',
      expect.objectContaining({ description: expect.stringContaining('press Add to system') }),
    );
    // Neither that it could not stand on the bar nor that it stands beside the bus.
    await waitFor(() => expect(drafts()[0]!.position).toEqual(node('draft-1')!.position));
    expect(info).not.toHaveBeenCalled();
  });

  it('is connected when it is dropped a little beside the bar, and not when far from it', async () => {
    await draw();
    const bar = onBar('1');
    drop('PQ', bar.x, bar.y + 12);
    expect(drafts()[0]!.values).toEqual({ bus: '1' });
    drop('PQ', bar.x, bar.y + 100);
    expect(drafts()[1]!.values).toEqual({});
  });

  it('is connected when it is dropped on the name of the bus, out of reach of the bar itself', async () => {
    // A drop aimed at "the bus" lands on its name as often as on the thin bar.
    await draw();
    const one = node('1')!;
    const label = (one.data as { labelAt?: { offset: number; side: string } }).labelAt;
    expect(label?.side).toBe('below');
    // In the name under the bar, further from the bar than a drop on it reaches.
    const onName = { x: one.position.x + label!.offset, y: one.position.y + 6 + 16 };
    act(() => useSldStore.getState().setPaletteDragKind('PQ'));
    dragEvent('dragOver', 'PQ', onName.x, onName.y);
    // The bar is marked while the row is over the name, as over the bar.
    expect(screen.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '1');
    drop('PQ', onName.x, onName.y);
    expect(drafts()[0]!.values).toEqual({ bus: '1' });
    // Free ground under the name is still on no bus.
    drop('PQ', onName.x, onName.y + 60);
    expect(drafts()[1]!.values).toEqual({});
  });

  it('leaves a kind that is on no bus a plain draft, clear of the bar', async () => {
    await draw();
    const bar = onBar('2');
    drop('Bus', bar.x, bar.y);
    expect(drafts()[0]).toMatchObject({ kind: 'Bus', values: {} });
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(edge('stub-draft-1')).toBeUndefined();
    // Nor is it told how to be put on one.
    expect(screen.getByTestId('sld-canvas-hint')).not.toHaveAttribute('data-hint');
  });

  it('marks the bus under a row that is dragged over the diagram, for a kind that connects to one', async () => {
    await draw();
    const bar = onBar('3');
    act(() => useSldStore.getState().setPaletteDragKind('PQ'));
    dragEvent('dragOver', 'PQ', bar.x, bar.y - 8);
    expect(screen.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '3');
    // Off the bars: nothing is marked.
    dragEvent('dragOver', 'PQ', bar.x, bar.y - 120);
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    dragEvent('dragOver', 'PQ', bar.x, bar.y);
    expect(screen.getByTestId('sld-wire-target')).toBeInTheDocument();
    dragEvent('dragLeave', 'PQ', -50, -50);
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    // A bus is on no bus: none is marked for it.
    act(() => useSldStore.getState().setPaletteDragKind('Bus'));
    dragEvent('dragOver', 'Bus', bar.x, bar.y);
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    // The mark goes with the drop, and with a drag that is given up over the diagram.
    act(() => useSldStore.getState().setPaletteDragKind('PQ'));
    dragEvent('dragOver', 'PQ', bar.x, bar.y);
    drop('PQ', bar.x, bar.y);
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    dragEvent('dragOver', 'PQ', bar.x, bar.y);
    expect(screen.getByTestId('sld-wire-target')).toBeInTheDocument();
    act(() => useSldStore.getState().setPaletteDragKind(null));
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
  });

  it('starts a line at the bus it is dropped on, and asks for the bus it goes to', async () => {
    const success = vi.spyOn(toast, 'success');
    await draw();
    const bar = onBar('3');
    drop('Line', bar.x, bar.y);
    // Nothing is placed until the line has both its buses.
    expect(drafts()).toHaveLength(0);
    expect(screen.getByTestId('sld-wire-bar')).toHaveAccessibleName('Draw a line');
    expect(note()).toHaveTextContent('From bus 3: now click the bus it goes to. Esc cancels.');
    clickBus('4');
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({ kind: 'Line', values: { bus1: '3', bus2: '4' } });
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    expect(success).toHaveBeenCalledWith(
      'Draft line drawn from bus 3 to bus 4',
      expect.objectContaining({ description: expect.stringContaining('Add to system') }),
    );
  });
});

describe('a draft that is dragged onto a bus', () => {
  it('is connected to it, with the bar marked while it lies on it', async () => {
    const [success, info] = [vi.spyOn(toast, 'success'), vi.spyOn(toast, 'info')];
    await draw();
    drop('PV', 700, 500);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    expect(drafts()[0]!.values).toEqual({});
    // Dropped on no bus, which a generator needs: the notice says so plainly.
    expect(info).toHaveBeenCalledExactlyOnceWith(
      'PV generator 4 is not on a bus yet',
      expect.objectContaining({
        description:
          'Pick its bus in its form in the Inspector, or drag it onto the bar or the name of a bus.',
        action: expect.objectContaining({ label: 'Pick a bus' }),
      }),
    );
    info.mockClear();
    // Picked, and on no bus: the line above the diagram says how it is put on one.
    const hint = screen.getByTestId('sld-canvas-hint');
    expect(hint).toHaveAttribute('data-hint', 'connectable');
    expect(hint).toHaveTextContent(
      /^Draft PV generator 4 is selected and is on no bus yet\. To connect it, drag it onto the bar of a bus/,
    );
    const bar = onBar('2');
    dragTo('draft-1', { x: bar.x - W / 2, y: bar.y - H / 2 }, () => {
      expect(screen.getByTestId('sld-wire-target')).toHaveAttribute('data-bus', '2');
    });
    expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    expect(drafts()[0]!.values).toEqual({ bus: '2' });
    await waitFor(() => expect(edge('stub-draft-1')).toMatchObject({ target: '2' }));
    // Clear of the bar it was let go on, and kept where it came to stand.
    const stands = node('draft-1')!.position;
    const top = node('2')!.position.y;
    expect(stands.y + H <= top || stands.y >= top + 6).toBe(true);
    await waitFor(() => expect(drafts()[0]!.position).toEqual(node('draft-1')!.position));
    expect(success).toHaveBeenCalledExactlyOnceWith(
      'Draft PV generator 4 connected to bus 2',
      expect.anything(),
    );
    // One notice for the drop: not also that it was moved off the bar.
    expect(info).not.toHaveBeenCalled();
    // The form that is open on it is opened afresh, to show the bus.
    expect(useDraftsStore.getState().connected).toEqual({ 'draft-1': 1 });
    // Connected, it has a ring to move it by, and the line says so.
    await waitFor(() =>
      expect(screen.getByTestId('sld-canvas-hint')).toHaveAttribute('data-hint', 'movable'),
    );
  });

  it('goes to another bus when it is dragged onto that one', async () => {
    useDraftsStore.setState({
      byCase: {
        [CASE]: [{ id: 'draft-1', kind: 'PQ', position: { x: 20, y: -110 }, values: { bus: '1' } }],
      },
    });
    await draw();
    await waitFor(() => expect(edge('stub-draft-1')).toMatchObject({ target: '1' }));
    const bar = onBar('3');
    dragTo('draft-1', { x: bar.x - W / 2, y: bar.y - H / 2 });
    expect(drafts()[0]!.values).toEqual({ bus: '3' });
    await waitFor(() => expect(edge('stub-draft-1')).toMatchObject({ target: '3' }));
  });

  it('stays as it is when it is let go on the bar of the bus it is on, or beside the bars', async () => {
    const success = vi.spyOn(toast, 'success');
    useDraftsStore.setState({
      byCase: {
        [CASE]: [{ id: 'draft-1', kind: 'PQ', position: { x: 20, y: -110 }, values: { bus: '1' } }],
      },
    });
    await draw();
    await waitFor(() => expect(edge('stub-draft-1')).toBeDefined());
    const bar = onBar('1');
    dragTo('draft-1', { x: bar.x - W / 2, y: bar.y - H / 2 }, () => {
      expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    });
    dragTo('draft-1', { x: 700, y: 500 });
    expect(drafts()[0]!.values).toEqual({ bus: '1' });
    expect(success).not.toHaveBeenCalled();
    expect(useDraftsStore.getState().connected).toEqual({});
  });

  it('gives a line its start on the first bus and its end on the second, and is then drawn between them', async () => {
    const success = vi.spyOn(toast, 'success');
    await draw();
    drop('Line', 700, 500);
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    const first = onBar('3');
    dragTo('draft-1', { x: first.x - W / 2, y: first.y - H / 2 });
    expect(drafts()[0]!.values).toEqual({ bus1: '3' });
    expect(success).toHaveBeenLastCalledWith(
      'Draft Line L13 starts at bus 3',
      expect.objectContaining({ description: expect.stringContaining('Drop it on the bus') }),
    );
    // Still a symbol: a line is drawn once it names both its buses.
    await waitFor(() => expect(node('draft-1')).toBeDefined());
    const second = onBar('4');
    dragTo('draft-1', { x: second.x - W / 2, y: second.y - H / 2 });
    expect(drafts()[0]!.values).toEqual({ bus1: '3', bus2: '4' });
    await waitFor(() => expect(edge(draftBranchEdgeId('draft-1'))).toBeDefined());
    expect(edge(draftBranchEdgeId('draft-1'))).toMatchObject({ source: '3', target: '4' });
    expect(node('draft-1')).toBeUndefined();
    expect(success).toHaveBeenLastCalledWith(
      'Draft Line L13 runs from bus 3 to bus 4',
      expect.anything(),
    );
  });

  it('leaves a device of the system on its bus when that is dragged onto another bar', async () => {
    await draw();
    const bar = onBar('2');
    dragTo('load-PQ_1', { x: bar.x - 20, y: bar.y - 10 }, () => {
      expect(screen.queryByTestId('sld-wire-target')).toBeNull();
    });
    expect(editSpy).not.toHaveBeenCalled();
    expect(edge('stub-load-PQ_1')).toMatchObject({ target: '4' });
  });
});

describe('a line or a transformer drawn from one bus to another', () => {
  it('has two buttons over the diagram that say what they do', async () => {
    await draw();
    const tools = screen.getByTestId('sld-draw-tools');
    expect(tools).toHaveAccessibleName('Draw between two buses');
    expect(tools).toHaveAttribute('data-export-ignore');
    const line = screen.getByTestId('sld-draw-line');
    expect(line).toHaveTextContent('Draw line');
    expect(line).toHaveAttribute('aria-pressed', 'false');
    expect(line.title).toMatch(/then the bus it starts from and the bus it goes to/);
    expect(line).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('sld-draw-tools-reason')).toBeNull();
    expect(screen.getByTestId('sld-draw-transformer')).toHaveTextContent('Draw transformer');
  });

  it('is drawn by a press of the button and a click on each bus, and placed as a draft', async () => {
    const success = vi.spyOn(toast, 'success');
    await draw();
    fireEvent.click(screen.getByTestId('sld-draw-line'));
    expect(screen.getByTestId('sld-draw-line')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sld-wire-bar')).toHaveAccessibleName('Draw a line');
    expect(bus('1')).toHaveAccessibleName('Start the line at bus 1');
    clickBus('1');
    expect(note()).toHaveTextContent('From bus 1: now click the bus it goes to. Esc cancels.');
    expect(bus('4')).toHaveAccessibleName('End the line at bus 4');
    clickBus('4');
    expect(drafts()).toEqual([
      expect.objectContaining({ id: 'draft-1', kind: 'Line', values: { bus1: '1', bus2: '4' } }),
    ]);
    // Drawn as the dashed branch it will be, picked, with its form in the Inspector.
    const id = draftBranchEdgeId('draft-1');
    await waitFor(() => expect(edge(id)).toBeDefined());
    expect(edge(id)).toMatchObject({ source: '1', target: '4', data: { draft: true } });
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    expect(useCaseStore.getState().selectedElement).toBeNull();
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    expect(screen.getByTestId('sld-draw-line')).toHaveAttribute('aria-pressed', 'false');
    expect(success).toHaveBeenCalledExactlyOnceWith(
      'Draft line drawn from bus 1 to bus 4',
      expect.objectContaining({ description: expect.stringContaining('Add to system') }),
    );
    // Nothing was sent to the server for it.
    expect(editSpy).not.toHaveBeenCalled();
  });

  it('is drawn by a drag from one bus to the other', async () => {
    await draw();
    fireEvent.click(screen.getByTestId('sld-draw-transformer'));
    expect(screen.getByTestId('sld-wire-bar')).toHaveAccessibleName('Draw a transformer');
    dragHandle('sld-wire-bus-2', onBar('2'), onBar('4'));
    expect(drafts()).toEqual([
      expect.objectContaining({ kind: 'Transformer2W', values: { bus1: '2', bus2: '4' } }),
    ]);
    await waitFor(() => expect(edge(draftBranchEdgeId('draft-1'))).toBeDefined());
    expect(edge(draftBranchEdgeId('draft-1'))).toMatchObject({ type: 'transformer' });
  });

  it('is drawn beside a line that joins the two buses already', async () => {
    await draw();
    fireEvent.click(screen.getByTestId('sld-draw-line'));
    clickBus('1');
    clickBus('2');
    const id = draftBranchEdgeId('draft-1');
    await waitFor(() => expect(edge(id)).toBeDefined());
    const route = (which: string) => (edge(which)!.data!.route as { points: number[][] }).points;
    await waitFor(() => expect(route(id).length).toBeGreaterThan(1));
    // Each lands on a tap of its own on either bar.
    expect(route(id)[0]).not.toEqual(route('line-L12')[0]);
    expect(route(id).at(-1)).not.toEqual(route('line-L12').at(-1));
  });

  it('stops on a second press of the button, on Cancel and on Escape, with nothing placed', async () => {
    await draw();
    const button = screen.getByTestId('sld-draw-line');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    fireEvent.click(button);
    clickBus('1');
    fireEvent.click(screen.getByTestId('sld-wire-cancel'));
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(bus('2'), { key: 'Escape' });
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(drafts()).toHaveLength(0);
  });

  it('starts from the command as well', async () => {
    await draw();
    act(() => __requestSldCommand('draw-transformer'));
    expect(screen.getByTestId('sld-wire-bar')).toHaveAccessibleName('Draw a transformer');
    expect(screen.getByTestId('sld-draw-transformer')).toHaveAttribute('aria-pressed', 'true');
  });

  it('stops on Escape wherever the keyboard focus is, and leaves an Escape that something else took', async () => {
    await draw();
    // Started from the command palette, the focus is not in the diagram.
    act(() => __requestSldCommand('draw-line'));
    expect(screen.getByTestId('sld-wire-bar')).toBeInTheDocument();
    // An Escape a dialog or a menu closed on is that one's, not the pick's.
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => void document.body.dispatchEvent(taken));
    expect(screen.getByTestId('sld-wire-bar')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    expect(screen.getByTestId('sld-draw-line')).toHaveAttribute('aria-pressed', 'false');
    expect(drafts()).toHaveLength(0);
  });

  it('says why it cannot be drawn in a system of one bus, on the button and when it is pressed', async () => {
    const info = vi.spyOn(toast, 'info');
    mockTopology = { ...square(), buses: [entry(1, 'Bus', { Vn: 69 })], lines: [], loads: [] };
    mockTopology.generators = [];
    await draw();
    const button = screen.getByTestId('sld-draw-line');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.title).toMatch(/^Draw line: not now\. It runs between two buses/);
    // The reason stands beside the buttons, and is what they are described by.
    expect(screen.getByTestId('sld-draw-tools-reason')).toHaveTextContent('Needs two buses.');
    expect(button).toHaveAccessibleDescription('Needs two buses.');
    fireEvent.click(button);
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    expect(info).toHaveBeenCalledWith(
      'Draw line: not now',
      expect.objectContaining({ description: expect.stringContaining('add buses first') }),
    );
  });
});

describe('a device that is moved to another bus by the end of its connector', () => {
  it('shows a ring where the connector of the selected device meets the bar, and says how it is used', async () => {
    await draw();
    expect(screen.queryByTestId('sld-wire-grip')).toBeNull();
    select('load-PQ_1');
    const ring = await screen.findByTestId('sld-wire-grip');
    expect(ring).toHaveAttribute('data-node', 'load-PQ_1');
    expect(ring).toHaveAttribute('data-bus', '4');
    expect(ring).toHaveAccessibleName(/^Move load PQ_1 to another bus: drag this end/);
    // On the tap its connector lands on.
    const tap = (edge('stub-load-PQ_1')!.data!.route as { points: number[][] }).points.at(-1)!;
    const circle = ring.querySelector('circle')!;
    expect([Number(circle.getAttribute('cx')), Number(circle.getAttribute('cy'))]).toEqual(tap);
    const hint = screen.getByTestId('sld-canvas-hint');
    expect(hint).toHaveAttribute('data-hint', 'movable');
    expect(hint).toHaveTextContent(
      /^Load PQ_1 is selected\. To move it to another bus, drag the ring where its connector meets the bar onto that bus, or click the ring and then the bus\./,
    );
  });

  it('sends the server the edit that puts the device on the bus the ring is dragged onto', async () => {
    const success = vi.spyOn(toast, 'success');
    await draw();
    select('load-PQ_1');
    const ring = await screen.findByTestId('sld-wire-grip');
    const from = { x: Number(ring.querySelector('circle')!.getAttribute('cx')), y: 223 };
    dragHandle('sld-wire-grip', from, onBar('2'));
    expect(editSpy).toHaveBeenCalledTimes(1);
    const [vars, callbacks] = editSpy.mock.calls[0]!;
    // The load is rated for the 138 kV bus it leaves: its rating goes with it.
    expect(vars).toEqual({
      sessionId: 'sess-1',
      edits: [{ model: 'PQ', idx: 'PQ_1', params: { bus: 2, Vn: 69 } }],
    });
    // The bus is no longer being picked.
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    act(() => callbacks.onSuccess());
    expect(success).toHaveBeenCalledExactlyOnceWith(
      'Load PQ_1 moved to bus 2',
      expect.objectContaining({
        description:
          'It was on bus 4. The rated voltage Vn went with the bus, from 138 to 69 kV. Undo (Ctrl+Z or Edit > Undo) takes it back.',
      }),
    );
  });

  it('moves every model of a generating unit, and says how many steps take it back', async () => {
    const success = vi.spyOn(toast, 'success');
    await draw();
    select('generator-3');
    expect(await screen.findByTestId('sld-wire-grip')).toHaveAccessibleName(
      /^Move generator 3 to another bus/,
    );
    // A click on the ring asks for the bus, which is then clicked.
    const ring = screen.getByTestId('sld-wire-grip');
    fireEvent.pointerDown(ring, at(0, 0));
    fireEvent.pointerUp(ring, at(0, 0));
    expect(screen.getByTestId('sld-wire-bar')).toHaveAccessibleName(
      'Move generator 3 to another bus',
    );
    expect(bus('1')).toHaveAccessibleName('Move generator 3 to bus 1');
    clickBus('1');
    expect(editSpy.mock.calls[0]![0]).toEqual({
      sessionId: 'sess-1',
      edits: [
        { model: 'PV', idx: '3', params: { bus: 1 } },
        { model: 'GENROU', idx: 'GENROU_3', params: { bus: 1 } },
      ],
    });
    act(() => editSpy.mock.calls[0]![1].onSuccess());
    expect(success).toHaveBeenCalledWith(
      'Generator 3 moved to bus 1',
      expect.objectContaining({
        description:
          'It was on bus 3. PV 3 and GENROU_3 went together. Undo (Ctrl+Z or Edit > Undo) takes it back, one step for each of the 2.',
      }),
    );
  });

  it('says what the server refused, and leaves the device where it was', async () => {
    const error = vi.spyOn(toast, 'error');
    await draw();
    select('load-PQ_1');
    await screen.findByTestId('sld-wire-grip');
    dragHandle('sld-wire-grip', onBar('4'), onBar('2'));
    act(() => editSpy.mock.calls[0]![1].onError(new Error('the session is busy')));
    expect(error).toHaveBeenCalledExactlyOnceWith('Could not move load PQ_1 to bus 2', {
      description: 'the session is busy',
    });
    expect(edge('stub-load-PQ_1')).toMatchObject({ target: '4' });
  });

  it('does not move it once a run has locked the system, and the ring says why', async () => {
    const info = vi.spyOn(toast, 'info');
    mockTopology = { ...square(), state: 'committed' };
    await draw();
    select('load-PQ_1');
    const ring = await screen.findByTestId('sld-wire-grip');
    expect(ring).toHaveAttribute('aria-disabled', 'true');
    expect(ring).toHaveAccessibleName(
      /^Move load PQ_1 to another bus: not now\. A run has fixed the system\./,
    );
    // The line above the diagram says why, and not how to do what cannot be done.
    const hint = screen.getByTestId('sld-canvas-hint');
    expect(hint).toHaveAttribute('data-hint', 'immovable');
    expect(hint).toHaveTextContent(
      /^Load PQ_1 is selected\. It cannot be moved to another bus now, which is why the ring on its bar is greyed out\. A run has fixed the system\./,
    );
    dragHandle('sld-wire-grip', onBar('4'), onBar('2'));
    expect(editSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sld-wire-bar')).toBeNull();
    expect(info).toHaveBeenCalledWith(
      'Not moved to another bus',
      // The sentence of every place a run has locked, with the way out on the notice.
      expect.objectContaining({
        description: expect.stringMatching(/^A run has fixed the system\. Reset run lets/),
        action: expect.objectContaining({ label: 'Reset run' }),
      }),
    );
  });

  /** Whether the load stands by the bar of the bus `id`, with a connector that drops square onto it. */
  const standsBy = (id: string): boolean => {
    const [stands, bar] = [node('load-PQ_1')!.position, node(id)!.position];
    const route = (edge('stub-load-PQ_1')!.data!.route as { points: number[][] }).points;
    return (
      Math.abs(stands.x - bar.x) < 150 &&
      Math.abs(stands.y - bar.y) < 150 &&
      route.length === 2 &&
      route[0]![0] === route[1]![0]
    );
  };

  it('brings the device beside its new bus once the system has it there', async () => {
    const view = await draw();
    expect(standsBy('4')).toBe(true);
    select('load-PQ_1');
    await screen.findByTestId('sld-wire-grip');
    dragHandle('sld-wire-grip', onBar('4'), onBar('1'));
    act(() => editSpy.mock.calls[0]![1].onSuccess());
    // The edit is in: the load is on bus 1 now, across the diagram.
    mockTopology = square(1);
    view.rerender(<SldCanvas />);
    await waitFor(() => expect(edge('stub-load-PQ_1')).toMatchObject({ target: '1' }));
    await waitFor(() => expect(standsBy('1')).toBe(true));
  });

  it('keeps no route that was made round the connector of a device still on its way to its bus', async () => {
    const view = await draw();
    const routeOf = (id: string) =>
      JSON.stringify((edge(id)!.data!.route as { points: number[][] }).points);
    await waitFor(() => expect(edge('line-L12')?.data?.route).toBeDefined());
    const before = routeOf('line-L12');
    // The diagram opened arranged: no route was made for it since.
    expect(useCaseStore.getState().routeOverrides).toEqual({});
    // For a moment the load is drawn where it stood, by bus 4, on a connector
    // that reaches across the diagram to bus 1, where the line from bus 1 to
    // bus 2 lands: that picture has the line give way.
    act(() => useEditJournalStore.getState().record({ op: 'redo' }));
    mockTopology = square(1);
    view.rerender(<SldCanvas />);
    await waitFor(() => expect(standsBy('1')).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Beside bus 1 it is in no line's way: the line runs as it ran, and the
    // diagram keeps the route it kept.
    expect(routeOf('line-L12')).toBe(before);
    expect(useCaseStore.getState().routeOverrides).toEqual({});
  });

  it('brings it back beside the bus an Undo of that edit puts it on again', async () => {
    mockTopology = square(1);
    const view = await draw();
    expect(standsBy('1')).toBe(true);
    // An edit of the system that the canvas did not make: taken back in the Edit menu.
    act(() => useEditJournalStore.getState().record({ op: 'undo' }));
    mockTopology = square(4);
    view.rerender(<SldCanvas />);
    await waitFor(() => expect(edge('stub-load-PQ_1')).toMatchObject({ target: '4' }));
    await waitFor(() => expect(standsBy('4')).toBe(true));
  });

  it('moves nothing for another system that is drawn for a moment under the same case', async () => {
    const view = await draw();
    const stood = node('load-PQ_1')!.position;
    // No edit was made: the case that is being opened has a load of that name on bus 1.
    mockTopology = square(1);
    view.rerender(<SldCanvas />);
    await waitFor(() => expect(edge('stub-load-PQ_1')).toMatchObject({ target: '1' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(node('load-PQ_1')!.position).toEqual(stood);
  });

  it('moves a draft by the ring as well, with nothing sent to the server', async () => {
    useDraftsStore.setState({
      byCase: {
        [CASE]: [{ id: 'draft-1', kind: 'PQ', position: { x: 20, y: -110 }, values: { bus: '1' } }],
      },
    });
    await draw();
    await waitFor(() => expect(edge('stub-draft-1')).toBeDefined());
    select('draft-1');
    const ring = await screen.findByTestId('sld-wire-grip');
    expect(ring).toHaveAccessibleName(/^Move draft PQ load PQ_2 to another bus/);
    dragHandle('sld-wire-grip', onBar('1'), onBar('3'));
    expect(drafts()[0]!.values).toEqual({ bus: '3' });
    expect(editSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(edge('stub-draft-1')).toMatchObject({ target: '3' }));
  });

  it('draws no ring while the route of a line is moved by hand: its handles reach down to the bar', async () => {
    await draw();
    select('load-PQ_1');
    await screen.findByTestId('sld-wire-grip');
    // A click on the connector picks it, and shows the handles of its route.
    act(() => drawn.onEdgeClick!(null, edge('stub-load-PQ_1')!));
    expect(await screen.findByTestId('sld-route-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-wire-grip')).toBeNull();
    // A click on the device lets go of the route, and the ring is back.
    select('load-PQ_1');
    expect(await screen.findByTestId('sld-wire-grip')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-route-editor')).toBeNull();
  });

  it('lets go of a route that is being moved by hand when a bus is picked for something', async () => {
    await draw();
    act(() => drawn.onEdgeClick!(null, edge('line-L12')!));
    expect(await screen.findByTestId('sld-route-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sld-draw-line'));
    await waitFor(() => expect(screen.queryByTestId('sld-route-editor')).toBeNull());
    expect(screen.getByTestId('sld-wire-bar')).toHaveAccessibleName('Draw a line');
  });

  it('draws no ring for a bus, and none while several nodes are picked', async () => {
    await draw();
    select('1');
    expect(screen.queryByTestId('sld-wire-grip')).toBeNull();
    select('load-PQ_1');
    await screen.findByTestId('sld-wire-grip');
    act(() => useSldStore.getState().setPickedNodeIds(['load-PQ_1', 'generator-3']));
    await waitFor(() => expect(screen.queryByTestId('sld-wire-grip')).toBeNull());
  });
});
