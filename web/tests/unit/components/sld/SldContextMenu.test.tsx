/**
 * The diagram's right-click menu: which items each kind of target gets, and what
 * the items do.
 *
 * The menu is rendered in a stand-in for the canvas (a trigger and the menu's
 * body), and opened with a real `contextmenu` event, which is what Radix's
 * trigger listens for. React Flow is not involved: how a right-click on a node or
 * an edge becomes a target is covered by `contextTarget.test.ts` and by the
 * canvas tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SldContextMenuBody } from '@/components/sld/SldContextMenu';
import type { SldContextTarget } from '@/components/sld/contextTarget';
import { ROUTE_FOCUS_ATTR } from '@/components/sld/routeEdit';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { usePlotStore } from '@/store/plot';
import { useRunsStore } from '@/store/runs';
import { subscribeUnitExpanded, useSldStore } from '@/store/sld';
import { useSnapshotStore } from '@/store/snapshot';
import { toast } from '@/lib/toast';
import { parseSessionId } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { useSessionStore } from '@/store/session';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 1, name: 'BUS1', kind: 'Bus', params: {} },
    { idx: 2, name: 'BUS2', kind: 'Bus', params: {} },
  ],
  lines: [{ idx: 5, name: 'Line 5', kind: 'Line', params: { bus1: 1, bus2: 2 } }],
  transformers: [],
  generators: [],
  loads: [],
  shunts: [],
};

/** What the session's topology reads as: `TOPOLOGY`, unless a test says a run has locked it. */
let currentTopology: TopologySummary = TOPOLOGY;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => currentTopology };
});

const onFitView = vi.fn();
const onResetLayout = vi.fn();
const onConnectorStyle = vi.fn();
const onArrange = vi.fn();
const onSnapChange = vi.fn();
const onEditRoute = vi.fn();
const onResetRoute = vi.fn();
const onResetManualRoutes = vi.fn();
const onFigure = vi.fn();

/**
 * Opens the menu for `target`. The surface holds a stand-in for the node React
 * Flow draws for bus 1 and for generator 3: a focusable wrapper with the node's
 * id, which is what Move with arrow keys looks for.
 */
function openMenu(
  target: SldContextTarget,
  {
    locked = false,
    connectorStyle,
    snap = false,
    manualRoutes = 0,
  }: {
    locked?: boolean;
    connectorStyle?: 'straight' | 'elbow';
    snap?: boolean;
    manualRoutes?: number;
  } = {},
) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <div data-testid="surface">
            canvas
            <div className="react-flow__node" data-id="1" tabIndex={0} data-testid="node-1" />
            <div
              className="react-flow__node"
              data-id="generator-3"
              tabIndex={0}
              data-testid="node-generator-3"
            />
          </div>
        </ContextMenuTrigger>
        <SldContextMenuBody
          target={target}
          locked={locked}
          onFitView={onFitView}
          onResetLayout={onResetLayout}
          connectorStyle={connectorStyle}
          onConnectorStyle={onConnectorStyle}
          onArrange={onArrange}
          snap={snap}
          onSnapChange={onSnapChange}
          onEditRoute={onEditRoute}
          onResetRoute={onResetRoute}
          manualRoutes={manualRoutes}
          onResetManualRoutes={onResetManualRoutes}
          onFigure={onFigure}
        />
      </ContextMenu>
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(screen.getByTestId('surface'), { clientX: 10, clientY: 10 });
  return screen.findByTestId('sld-context-menu');
}

const BUS: SldContextTarget = { kind: 'bus', idx: '1', name: 'BUS1', nodeId: '1' };
const BRANCH: SldContextTarget = { kind: 'branch', idx: '5', name: 'Line 5', transformer: false };

beforeEach(() => {
  onFitView.mockReset();
  onResetLayout.mockReset();
  onConnectorStyle.mockReset();
  onArrange.mockReset();
  onSnapChange.mockReset();
  onEditRoute.mockReset();
  onResetRoute.mockReset();
  onResetManualRoutes.mockReset();
  onFigure.mockReset();
  currentTopology = TOPOLOGY;
  useSessionStore.setState({ sessionId: parseSessionId('s') });
  useCaseStore.setState({ selectedElement: null, topology: TOPOLOGY });
  useCaseStore.getState().closeAddPanel();
  useSldStore.setState({ selectedNodeId: null, selectedOnDiagram: false });
  useDisturbanceStore.getState().clearDisturbances();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  usePlotStore.getState().clearAll();
  useRunsStore.getState().clearRuns();
  useSnapshotStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useRunsStore.getState().clearRuns();
  vi.restoreAllMocks();
});

describe('menu for a bus', () => {
  it('is titled with the bus, and offers Inspect, Add element here, Fault here and Plot voltage', async () => {
    const menu = await openMenu(BUS);
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(
      'Bus BUS1 (idx 1)',
    );
    expect(within(menu).getByTestId('sld-context-inspect')).toBeInTheDocument();
    expect(within(menu).getByTestId('sld-context-move')).toHaveTextContent('Move with arrow keys');
    expect(within(menu).getByTestId('sld-context-add-element')).toHaveTextContent(
      'Add element here…',
    );
    expect(within(menu).getByTestId('sld-context-fault')).toHaveTextContent('Fault here');
    expect(within(menu).getByTestId('sld-context-plot-voltage')).toBeInTheDocument();
    expect(within(menu).queryByTestId('sld-context-trip-line')).toBeNull();
    expect(within(menu).queryByTestId('sld-context-fit-view')).toBeNull();
  });

  it('Inspect selects the bus and opens an Inspector that was folded away', async () => {
    useLayoutStore.setState({ rightInspectorCollapsed: true });
    await openMenu(BUS);
    await userEvent.click(screen.getByTestId('sld-context-inspect'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '1' });
    expect(useSldStore.getState().selectedNodeId).toBe('1');
    // Picked on the diagram, where the user is looking at it: the zoom stays.
    expect(useSldStore.getState().selectedOnDiagram).toBe(true);
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(false);
  });

  it('Add element here opens the Add element panel on this bus, with the kind still to pick', async () => {
    await openMenu(BUS);
    await userEvent.click(screen.getByTestId('sld-context-add-element'));
    expect(useCaseStore.getState()).toMatchObject({
      addPanelOpen: true,
      addPanelKind: null,
      addPanelBus: '1',
    });
  });

  it('Add element here is greyed out, with the reason, once a run has locked the system', async () => {
    currentTopology = { ...TOPOLOGY, state: 'committed' };
    const menu = await openMenu(BUS);
    const item = within(menu).getByTestId('sld-context-add-element');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('A run has locked the system.');
    expect(item).toHaveTextContent('Reset run');
    // The other items of the bus do not depend on it.
    expect(within(menu).getByTestId('sld-context-fault')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(item);
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });

  it('Fault here opens the Add disturbance dialog on a fault at this bus, and Add schedules it', async () => {
    const success = vi.spyOn(toast, 'success');
    await openMenu(BUS);
    await userEvent.click(screen.getByTestId('sld-context-fault'));
    const dialog = await screen.findByTestId('add-event-dialog');
    expect(within(dialog).getByTestId('fault-spec-form')).toBeInTheDocument();
    expect((within(dialog).getByTestId('bus-idx-select') as HTMLSelectElement).value).toBe('1');
    // Nothing is scheduled until the user has seen the times and pressed Add.
    expect(useDisturbanceStore.getState().disturbances).toHaveLength(0);

    await userEvent.click(within(dialog).getByTestId('add-event-save'));
    const [added] = useDisturbanceStore.getState().disturbances;
    expect(added?.spec).toMatchObject({ kind: 'fault', bus_idx: 1, tf: 1, tc: 1.1 });
    // It says where the fault went: the sidebar may be on its other tab.
    expect(success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining('Disturbances in the left sidebar (Project tab)'),
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('add-event-dialog')).toBeNull());
  });

  it('Cancel in the dialog schedules nothing', async () => {
    await openMenu(BUS);
    await userEvent.click(screen.getByTestId('sld-context-fault'));
    const dialog = await screen.findByTestId('add-event-dialog');
    await userEvent.click(within(dialog).getByTestId('add-event-cancel'));
    expect(useDisturbanceStore.getState().disturbances).toHaveLength(0);
  });

  it('sends a numeric idx as a number and a named one as a string, as the forms do', async () => {
    const named: SldContextTarget = { kind: 'bus', idx: 'BUS_X', name: 'BUS_X', nodeId: 'BUS_X' };
    await openMenu(named);
    await userEvent.click(screen.getByTestId('sld-context-fault'));
    const dialog = await screen.findByTestId('add-event-dialog');
    await userEvent.click(within(dialog).getByTestId('add-event-save'));
    expect(useDisturbanceStore.getState().disturbances[0]?.spec).toMatchObject({
      kind: 'fault',
      bus_idx: 'BUS_X',
    });
  });
});

describe('Move with arrow keys', () => {
  it('selects the bus, hands its node the keyboard focus and says which keys move it', async () => {
    const info = vi.spyOn(toast, 'info');
    useLayoutStore.setState({ rightInspectorCollapsed: true });
    await openMenu(BUS);
    await userEvent.click(screen.getByTestId('sld-context-move'));

    // Selected, which is what lets React Flow's arrow keys move the node.
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '1' });
    expect(useSldStore.getState().selectedNodeId).toBe('1');
    expect(useSldStore.getState().selectedOnDiagram).toBe(true);
    // The keys go to the node that has the focus.
    await waitFor(() => expect(screen.getByTestId('node-1')).toHaveFocus());
    expect(info).toHaveBeenCalledWith(
      'Press the arrow keys to move Bus BUS1 (idx 1)',
      expect.objectContaining({ description: expect.stringContaining('Hold Shift') }),
    );
    // Moving is not inspecting: a folded Inspector stays folded.
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(true);
  });

  it('is offered for a generator, by the id of its node', async () => {
    await openMenu({
      kind: 'device',
      element: { kind: 'generator', idx: '3' },
      name: 'G3',
      nodeId: 'generator-3',
    });
    await userEvent.click(screen.getByTestId('sld-context-move'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'generator', idx: '3' });
    expect(useSldStore.getState().selectedNodeId).toBe('generator-3');
    await waitFor(() => expect(screen.getByTestId('node-generator-3')).toHaveFocus());
  });

  it('is greyed out, with the reason, while the diagram is locked', async () => {
    const info = vi.spyOn(toast, 'info');
    const menu = await openMenu(BUS, { locked: true });
    const item = within(menu).getByTestId('sld-context-move');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('diagram is locked');
    fireEvent.click(item);
    expect(useCaseStore.getState().selectedElement).toBeNull();
    expect(info).not.toHaveBeenCalled();
    // What does not move anything is still there.
    expect(within(menu).getByTestId('sld-context-inspect')).not.toHaveAttribute('aria-disabled');
  });

  it('leaves the focus where the menu puts it after any other item', async () => {
    await openMenu(BUS);
    await userEvent.click(screen.getByTestId('sld-context-inspect'));
    await waitFor(() => expect(screen.queryByTestId('sld-context-menu')).toBeNull());
    expect(screen.getByTestId('node-1')).not.toHaveFocus();
  });
});

describe('Plot voltage', () => {
  function startRun(columns: string[]) {
    useRunsStore.getState().startRun({ runId: 'run-1', tf: 5, columnNames: columns });
  }

  it('says to run TDS first when there is no run, and cannot be chosen', async () => {
    await openMenu(BUS);
    const item = screen.getByTestId('sld-context-plot-voltage');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('run TDS first');
  });

  it('says the bus is not in the run when the run did not record it', async () => {
    startRun(['Bus_2_v']);
    await openMenu(BUS);
    const item = screen.getByTestId('sld-context-plot-voltage');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('not in this run');
  });

  it('adds the voltage to the plot of the run and brings the plot up', async () => {
    startRun(['Bus_1_v', 'Bus_1_a', 'Bus_2_v']);
    usePlotStore.getState().setSelection('run-1', new Set(['Bus_2_v']));
    useLayoutStore.setState({
      bottomDrawerCollapsed: true,
      drawerHasUnreadResults: true,
      activeAnalysisSubTab: 'eig',
    });
    await openMenu(BUS);
    const item = screen.getByTestId('sld-context-plot-voltage');
    expect(item).not.toHaveAttribute('data-disabled');
    await userEvent.click(item);

    // Added to what was already drawn, not in place of it.
    expect([...(usePlotStore.getState().selectedByRun['run-1'] ?? [])].sort()).toEqual([
      'Bus_1_v',
      'Bus_2_v',
    ]);
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('plot');
    expect(layout.bottomDrawerCollapsed).toBe(false);
    expect(layout.drawerHasUnreadResults).toBe(false);
  });

  it('plots into the run that is active, not an older one', async () => {
    useRunsStore.getState().startRun({ runId: 'old', tf: 5, columnNames: ['Bus_1_v'] });
    useRunsStore.getState().startRun({ runId: 'new', tf: 5, columnNames: ['Bus_1_v'] });
    await openMenu(BUS);
    await userEvent.click(screen.getByTestId('sld-context-plot-voltage'));
    expect(usePlotStore.getState().selectedByRun['new']?.has('Bus_1_v')).toBe(true);
    expect(usePlotStore.getState().selectedByRun['old']).toBeUndefined();
  });
});

describe('menu for a line or transformer', () => {
  it('is titled with the branch, and offers Inspect and Trip line', async () => {
    const menu = await openMenu(BRANCH);
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(
      'Line Line 5 (idx 5)',
    );
    expect(within(menu).getByTestId('sld-context-inspect')).toBeInTheDocument();
    expect(within(menu).getByTestId('sld-context-trip-line')).toHaveTextContent('Trip line');
    expect(within(menu).queryByTestId('sld-context-fault')).toBeNull();
    expect(within(menu).queryByTestId('sld-context-plot-voltage')).toBeNull();
  });

  it('names a transformer as one', async () => {
    const menu = await openMenu({ ...BRANCH, transformer: true });
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(/^Transformer /);
  });

  it('Inspect selects the line (a transformer as a transformer)', async () => {
    await openMenu(BRANCH);
    await userEvent.click(screen.getByTestId('sld-context-inspect'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'line', idx: '5' });
    cleanup();
    await openMenu({ ...BRANCH, transformer: true });
    await userEvent.click(screen.getByTestId('sld-context-inspect'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'transformer', idx: '5' });
  });

  it('Trip line opens the dialog on a toggle of this line, and Add schedules it', async () => {
    await openMenu(BRANCH);
    await userEvent.click(screen.getByTestId('sld-context-trip-line'));
    const dialog = await screen.findByTestId('add-event-dialog');
    expect(within(dialog).getByTestId('toggle-spec-form')).toBeInTheDocument();
    expect((within(dialog).getByTestId('toggle-dev-idx') as HTMLSelectElement).value).toBe('5');
    await userEvent.click(within(dialog).getByTestId('add-event-save'));
    const [added] = useDisturbanceStore.getState().disturbances;
    expect(added?.spec).toMatchObject({ kind: 'toggle', model: 'Line', dev_idx: 5, t: 1 });
  });
});

describe('moving the route of a line by hand', () => {
  const LINE: SldContextTarget = { ...BRANCH, edgeId: 'line-5', manual: false };

  it('offers Move route by hand on a line, which picks its edge', async () => {
    const menu = await openMenu(LINE);
    await userEvent.click(within(menu).getByTestId('sld-context-edit-route'));
    expect(onEditRoute).toHaveBeenCalledWith('line-5');
  });

  it('hands the keyboard focus to the longest run of the line as the menu closes', async () => {
    // What the editor draws once the line is picked: the run the keys slide.
    const run = document.createElement('button');
    run.setAttribute(ROUTE_FOCUS_ATTR, '');
    document.body.append(run);
    try {
      const menu = await openMenu(LINE);
      await userEvent.click(within(menu).getByTestId('sld-context-edit-route'));
      await waitFor(() => expect(run).toHaveFocus());
    } finally {
      run.remove();
    }
  });

  it('leaves the focus alone after Reset route, which picks nothing', async () => {
    const run = document.createElement('button');
    run.setAttribute(ROUTE_FOCUS_ATTR, '');
    document.body.append(run);
    try {
      const menu = await openMenu({ ...LINE, manual: true });
      await userEvent.click(within(menu).getByTestId('sld-context-reset-route'));
      await waitFor(() => expect(screen.queryByTestId('sld-context-menu')).toBeNull());
      expect(run).not.toHaveFocus();
    } finally {
      run.remove();
    }
  });

  it('greys Reset route out, with the reason, for a route the diagram made', async () => {
    const menu = await openMenu(LINE);
    const reset = within(menu).getByTestId('sld-context-reset-route');
    expect(reset).toHaveAttribute('data-disabled');
    expect(reset).toHaveTextContent('routed automatically');
  });

  it('resets a route that was drawn by hand', async () => {
    const menu = await openMenu({ ...LINE, manual: true });
    const reset = within(menu).getByTestId('sld-context-reset-route');
    expect(reset).not.toHaveAttribute('data-disabled');
    expect(reset).not.toHaveTextContent('routed automatically');
    await userEvent.click(reset);
    expect(onResetRoute).toHaveBeenCalledWith('line-5');
  });

  it('has the same two for the connector of a device, and nothing about an element', async () => {
    const menu = await openMenu({
      kind: 'connector',
      edgeId: 'stub-load-PQ_1',
      name: 'PQ_1',
      manual: true,
    });
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(
      'Connector of PQ_1',
    );
    expect(within(menu).queryByTestId('sld-context-inspect')).toBeNull();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    await userEvent.click(within(menu).getByTestId('sld-context-reset-route'));
    expect(onResetRoute).toHaveBeenCalledWith('stub-load-PQ_1');
  });

  it('greys both out, and says why, while the diagram is locked', async () => {
    const menu = await openMenu({ ...LINE, manual: true }, { locked: true });
    for (const id of ['sld-context-edit-route', 'sld-context-reset-route']) {
      expect(within(menu).getByTestId(id)).toHaveAttribute('data-disabled');
      expect(within(menu).getByTestId(id)).toHaveTextContent('diagram is locked');
    }
  });

  it('leaves both off the menu of a branch whose edge is not known', async () => {
    const menu = await openMenu(BRANCH);
    expect(within(menu).queryByTestId('sld-context-edit-route')).toBeNull();
    expect(within(menu).queryByTestId('sld-context-reset-route')).toBeNull();
  });

  it('resets every route drawn by hand from the menu of the canvas, which counts them', async () => {
    const menu = await openMenu({ kind: 'canvas' }, { manualRoutes: 3 });
    const item = within(menu).getByTestId('sld-context-reset-manual-routes');
    expect(item).toHaveTextContent('Reset manual routes (3)');
    await userEvent.click(item);
    expect(onResetManualRoutes).toHaveBeenCalledTimes(1);
  });

  it('greys that out, with the reason, while no line is routed by hand', async () => {
    const menu = await openMenu({ kind: 'canvas' });
    const item = within(menu).getByTestId('sld-context-reset-manual-routes');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('no line is routed by hand');
  });
});

describe('menu for a generator, load, shunt or controller', () => {
  it('offers Inspect and Move with arrow keys, and Inspect selects that element', async () => {
    const target: SldContextTarget = {
      kind: 'device',
      element: { kind: 'generator', idx: '3' },
      name: 'G3',
      nodeId: 'generator-3',
    };
    const menu = await openMenu(target);
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(
      'Generator G3 (idx 3)',
    );
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByTestId('sld-context-move')).toBeInTheDocument();
    await userEvent.click(within(menu).getByTestId('sld-context-inspect'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'generator', idx: '3' });
    expect(useSldStore.getState().selectedNodeId).toBe('generator-3');
  });

  it('offers the control chain of a generator that stands for a unit, to draw out or to fold away', async () => {
    const asked = vi.fn();
    const stop = subscribeUnitExpanded(asked);
    const unit = (expanded: boolean): SldContextTarget => ({
      kind: 'device',
      element: { kind: 'generator', idx: '3', modelClass: 'PV' },
      name: 'G3',
      nodeId: 'generator-3',
      unit: { idx: '3', expanded },
    });

    let menu = await openMenu(unit(false));
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3);
    const show = within(menu).getByTestId('sld-context-unit-chain');
    expect(show).toHaveTextContent('Show control chain');
    await userEvent.click(show);
    expect(asked).toHaveBeenLastCalledWith('3', true);
    // Drawing a chain out selects nothing.
    expect(useCaseStore.getState().selectedElement).toBeNull();
    cleanup();

    menu = await openMenu(unit(true));
    const hide = within(menu).getByTestId('sld-context-unit-chain');
    expect(hide).toHaveTextContent('Hide control chain');
    await userEvent.click(hide);
    expect(asked).toHaveBeenLastCalledWith('3', false);
    stop();
  });

  it('names a controller as one, and offers no move: its badge follows what it acts on', async () => {
    const menu = await openMenu({
      kind: 'device',
      element: { kind: 'controller', subKind: 'exciter', modelClass: 'IEEEX1', idx: '1' },
      name: 'EXC1',
      nodeId: 'controller-IEEEX1-1',
    });
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(
      'Controller EXC1 (idx 1)',
    );
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    expect(within(menu).queryByTestId('sld-context-move')).toBeNull();
  });
});

describe('menu for the canvas', () => {
  it('offers Fit view and Reset to auto-layout, which call the canvas', async () => {
    const menu = await openMenu({ kind: 'canvas' });
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent('Diagram');
    await userEvent.click(within(menu).getByTestId('sld-context-fit-view'));
    expect(onFitView).toHaveBeenCalledTimes(1);
    expect(onResetLayout).not.toHaveBeenCalled();

    cleanup();
    const again = await openMenu({ kind: 'canvas' });
    await userEvent.click(within(again).getByTestId('sld-context-reset-layout'));
    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });

  it('offers Add element, which opens the Add element panel on no bus', async () => {
    useCaseStore.setState({ addPanelBus: '1' });
    const menu = await openMenu({ kind: 'canvas' });
    const item = within(menu).getByTestId('sld-context-add-element');
    expect(item).toHaveTextContent('Add element…');
    expect(item).not.toHaveTextContent('here');
    await userEvent.click(item);
    expect(useCaseStore.getState()).toMatchObject({
      addPanelOpen: true,
      addPanelKind: null,
      addPanelBus: null,
    });
  });

  it('offers nothing about a single element', async () => {
    const menu = await openMenu({ kind: 'canvas' });
    expect(within(menu).queryByTestId('sld-context-inspect')).toBeNull();
    expect(within(menu).queryByTestId('sld-context-fault')).toBeNull();
    expect(within(menu).queryByTestId('sld-context-move')).toBeNull();
    // Add element, Fit view, the two tidies, the two resets, Snap to grid,
    // Save snapshot, Figure.
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(9);
  });

  it('offers Figure, which says what it saves and opens the figure of the diagram', async () => {
    const menu = await openMenu({ kind: 'canvas' });
    const item = within(menu).getByTestId('sld-context-figure');
    expect(item).toHaveTextContent('Figure…');
    expect(item).toHaveTextContent('SVG, PDF or PNG');
    await userEvent.click(item);
    expect(onFigure).toHaveBeenCalledTimes(1);
  });

  it('offers no figure on a single element, which a figure is not of', async () => {
    const menu = await openMenu(BUS);
    expect(within(menu).queryByTestId('sld-context-figure')).toBeNull();
  });

  it('offers Tidy diagram and Tidy and re-layout, which run the commands of the same name', async () => {
    const menu = await openMenu({ kind: 'canvas' });
    await userEvent.click(within(menu).getByTestId('sld-context-tidy'));
    expect(onArrange).toHaveBeenCalledWith('tidy');

    cleanup();
    const again = await openMenu({ kind: 'canvas' });
    expect(within(again).getByTestId('sld-context-tidy-relayout')).toHaveTextContent(
      'Tidy and re-layout',
    );
    await userEvent.click(within(again).getByTestId('sld-context-tidy-relayout'));
    expect(onArrange).toHaveBeenLastCalledWith('tidy-relayout');
  });

  it('greys the tidies out, and says why, while the diagram is locked', async () => {
    const menu = await openMenu({ kind: 'canvas' }, { locked: true });
    for (const id of ['sld-context-tidy', 'sld-context-tidy-relayout']) {
      const item = within(menu).getByTestId(id);
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveTextContent('diagram is locked');
    }
    // Fit view and Reset are not arrangements made by hand, and stay.
    expect(within(menu).getByTestId('sld-context-fit-view')).not.toHaveAttribute('aria-disabled');
  });

  it('says whether Snap to grid is on, and turns it the other way', async () => {
    const off = await openMenu({ kind: 'canvas' });
    const item = within(off).getByTestId('sld-context-snap');
    expect(item).toHaveTextContent('Snap to grid: off');
    expect(item).toHaveAttribute('data-state', 'unchecked');
    await userEvent.click(item);
    expect(onSnapChange).toHaveBeenCalledWith(true);

    cleanup();
    const on = await openMenu({ kind: 'canvas' }, { snap: true });
    expect(within(on).getByTestId('sld-context-snap')).toHaveTextContent('Snap to grid: on');
    await userEvent.click(within(on).getByTestId('sld-context-snap'));
    expect(onSnapChange).toHaveBeenLastCalledWith(false);
  });
});

describe('menu for several nodes picked together', () => {
  it('is titled with how many are picked, and offers the six alignments', async () => {
    const menu = await openMenu({ kind: 'selection', count: 2 });
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(
      '2 elements picked',
    );
    for (const [mode, label] of [
      ['left', 'Align left'],
      ['centre', 'Align centre'],
      ['right', 'Align right'],
      ['top', 'Align top'],
      ['middle', 'Align middle'],
      ['bottom', 'Align bottom'],
    ] as const) {
      expect(within(menu).getByTestId(`sld-context-align-${mode}`)).toHaveTextContent(label);
    }
    await userEvent.click(within(menu).getByTestId('sld-context-align-top'));
    expect(onArrange).toHaveBeenCalledWith('align-top');
    // Nothing of the canvas's menu, and nothing about one element.
    expect(screen.queryByTestId('sld-context-fit-view')).toBeNull();
    expect(screen.queryByTestId('sld-context-inspect')).toBeNull();
  });

  it('offers Distribute from three picked, and says so with two', async () => {
    const two = await openMenu({ kind: 'selection', count: 2 });
    const greyed = within(two).getByTestId('sld-context-distribute-horizontal');
    expect(greyed).toHaveAttribute('aria-disabled', 'true');
    expect(greyed).toHaveTextContent('needs three or more');

    cleanup();
    const three = await openMenu({ kind: 'selection', count: 3 });
    const item = within(three).getByTestId('sld-context-distribute-vertical');
    expect(item).not.toHaveAttribute('aria-disabled');
    await userEvent.click(item);
    expect(onArrange).toHaveBeenCalledWith('distribute-vertical');
  });

  it('greys everything out while the diagram is locked', async () => {
    const menu = await openMenu({ kind: 'selection', count: 3 }, { locked: true });
    for (const id of ['sld-context-align-left', 'sld-context-distribute-horizontal']) {
      expect(within(menu).getByTestId(id)).toHaveAttribute('aria-disabled', 'true');
      expect(within(menu).getByTestId(id)).toHaveTextContent('diagram is locked');
    }
  });
});

describe('menu for the canvas: connectors and snapshots', () => {
  it('says how the connectors of devices are drawn, and lets the other way be chosen', async () => {
    const menu = await openMenu({ kind: 'canvas' });
    const straight = within(menu).getByTestId('sld-context-connectors-straight');
    const elbow = within(menu).getByTestId('sld-context-connectors-elbow');
    expect(straight).toHaveTextContent('Straight');
    expect(elbow).toHaveTextContent('Right angle');
    // Straight until something says otherwise.
    expect(straight).toHaveAttribute('aria-checked', 'true');
    expect(elbow).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2);

    await userEvent.click(elbow);
    expect(onConnectorStyle).toHaveBeenCalledTimes(1);
    expect(onConnectorStyle).toHaveBeenCalledWith('elbow');
  });

  it('marks the right angle as chosen when that is how the diagram is drawn', async () => {
    const menu = await openMenu({ kind: 'canvas' }, { connectorStyle: 'elbow' });
    expect(within(menu).getByTestId('sld-context-connectors-elbow')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(menu).getByTestId('sld-context-connectors-straight'));
    expect(onConnectorStyle).toHaveBeenCalledWith('straight');
  });

  it('keeps the connector style off the menu of a single element', async () => {
    const menu = await openMenu(BUS);
    expect(within(menu).queryByTestId('sld-context-connectors-elbow')).toBeNull();
  });

  it('offers Save snapshot, which opens the Save snapshot dialog', async () => {
    const menu = await openMenu({ kind: 'canvas' });
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
    await userEvent.click(within(menu).getByTestId('sld-context-save-snapshot'));
    // The dialog is mounted at the app's root and opens from this flag.
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });
});

describe('opening', () => {
  it('stays closed until there is a right-click', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ContextMenu modal={false}>
          <ContextMenuTrigger asChild>
            <div data-testid="surface">canvas</div>
          </ContextMenuTrigger>
          <SldContextMenuBody target={BUS} onFitView={onFitView} onResetLayout={onResetLayout} />
        </ContextMenu>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('sld-context-menu')).toBeNull();
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('surface'));
    });
    expect(await screen.findByTestId('sld-context-menu')).toBeInTheDocument();
  });
});
