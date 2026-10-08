/**
 * Drafts on the diagram, as pure data: what a draft still lacks, by the rule
 * the form of its kind adds by, and what the diagram draws for it. A draft is
 * a symbol of its own until it names a bus of the case, which wires it: a
 * device by a connector to its bus, a line or a transformer that names both
 * its buses as the branch it will be. Nothing of a draft is written to the
 * layout beside the case.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAFT_NODE_SIZE,
  DRAFT_NODE_TYPE,
  addedElement,
  addedNodeId,
  draftBranchEdgeId,
  draftGraph,
  draftIdOf,
  draftName,
  draftReservedIdxs,
  draftRows,
  draftStatus,
  draftStrokeStyle,
  draftSummary,
} from '@/components/sld/drafts';
import { buildGraph } from '@/components/sld/graph';
import { captureLayout } from '@/components/sld/sidecar';
import { GRID_STEP } from '@/components/sld/tidy';
import type { DraftElement } from '@/store/drafts';
import { IEEE14 } from '../../helpers/exampleCases';
import { TOPOLOGY_SCHEMA } from '../../helpers/topologySchema';

const draft = (
  kind: string,
  values: DraftElement['values'] = {},
  id = 'draft-1',
  position = { x: 40, y: 60 },
): DraftElement => ({ id, kind, position, values });

const BUS_POSITIONS = new Map(
  IEEE14.buses.map((bus, i) => [String(bus.idx), { x: 200 * i, y: 0 }]),
);
const graphOf = (drafts: DraftElement[], routes?: Parameters<typeof draftGraph>[1]['routes']) =>
  draftGraph(drafts, {
    schema: TOPOLOGY_SCHEMA,
    topology: IEEE14,
    busPositions: BUS_POSITIONS,
    routes,
  });

describe('what a draft still lacks', () => {
  it('is everything required that a form of its kind opens without', () => {
    const status = draftStatus(draft('PV'), TOPOLOGY_SCHEMA, IEEE14);
    expect(status?.ready).toBe(false);
    expect(status?.missing).toEqual(['bus', 'Sn', 'Vn', 'p0', 'v0']);
    expect(status?.refused).toEqual([]);
    // The idx is the next free one of the case, and a generator is named after it.
    expect(status?.values).toMatchObject({ idx: '6', name: '6' });
    expect(draftSummary(status)).toBe('Missing bus, Sn, Vn, p0 and v0');
    expect(draftName(draft('PV'), status)).toBe('PV generator 6');
  });

  it('is nothing once every required field is given, and the values are the ones to send', () => {
    const status = draftStatus(
      draft('PV', { bus: '4', Sn: '100', Vn: '69', p0: '0.4', v0: '1.02' }),
      TOPOLOGY_SCHEMA,
      IEEE14,
    );
    expect(status).toMatchObject({ ready: true, missing: [], refused: [] });
    expect(status?.params).toMatchObject({
      idx: '6',
      name: '6',
      bus: '4',
      Sn: 100,
      Vn: 69,
      p0: 0.4,
      v0: 1.02,
    });
    expect(draftSummary(status)).toBe('Ready to add');
  });

  it('names a value that cannot be used apart from one that is missing', () => {
    const status = draftStatus(
      draft('PQ', { idx: 'PQ_1', bus: '99', Vn: 'abc' }),
      TOPOLOGY_SCHEMA,
      IEEE14,
    );
    expect(status?.missing).toEqual(['name', 'p0', 'q0']);
    // An idx the case has, a bus it does not, a number that is not one.
    expect(status?.refused).toEqual(['idx', 'bus', 'Vn']);
    expect(draftSummary(status)).toBe('Missing name, p0 and q0; check idx, bus and Vn');
  });

  it('sends what the kind itself sets: a transformer keeps its tap', () => {
    const status = draftStatus(
      draft('Transformer2W', { name: 'T9', bus1: '1', bus2: '2', r: '0', x: '0.1' }),
      TOPOLOGY_SCHEMA,
      IEEE14,
    );
    expect(status?.ready).toBe(true);
    expect(status?.params).toMatchObject({ tap: 1.05, bus1: '1', bus2: '2' });
  });

  it('is not known while the schema is not in, or for a kind the app has no form for', () => {
    expect(draftStatus(draft('PV'), undefined, IEEE14)).toBeNull();
    expect(draftStatus(draft('NoSuchKind'), TOPOLOGY_SCHEMA, IEEE14)).toBeNull();
    expect(draftSummary(null)).toBe('Checking');
  });
});

describe('the idx each draft opens with', () => {
  it('is the next free one past the drafts of its model that were placed before', () => {
    // IEEE 14 has loads PQ_1 to PQ_11: three loads dropped in a row.
    const loads = [draft('PQ'), draft('PQ', {}, 'draft-2'), draft('PQ', {}, 'draft-3')];
    const reserved = draftReservedIdxs(loads, IEEE14);
    expect(reserved.get('draft-1')).toEqual([]);
    expect(reserved.get('draft-2')).toEqual(['PQ_12']);
    expect(reserved.get('draft-3')).toEqual(['PQ_12', 'PQ_13']);
    expect(draftRows(loads, TOPOLOGY_SCHEMA, IEEE14).map((row) => row.name)).toEqual([
      'PQ load PQ_12',
      'PQ load PQ_13',
      'PQ load PQ_14',
    ]);
  });

  it('keeps off an idx that was typed into another draft, wherever that one stands', () => {
    const loads = [draft('PQ'), draft('PQ', { idx: 'PQ_12' }, 'draft-2')];
    expect(draftReservedIdxs(loads, IEEE14).get('draft-1')).toEqual(['PQ_12']);
    expect(draftRows(loads, TOPOLOGY_SCHEMA, IEEE14).map((row) => row.name)).toEqual([
      'PQ load PQ_13',
      'PQ load PQ_12',
    ]);
  });

  it('counts a line and a transformer as one model, and other models apart', () => {
    const mixed = [
      draft('Line'),
      draft('Transformer2W', {}, 'draft-2'),
      draft('PQ', {}, 'draft-3'),
      draft('NoSuchKind', {}, 'draft-4'),
    ];
    const reserved = draftReservedIdxs(mixed, IEEE14);
    expect(reserved.get('draft-2')).toEqual([reserved.get('draft-1'), ['Line_21']].flat());
    expect(reserved.get('draft-3')).toEqual([]);
    expect(reserved.has('draft-4')).toBe(false);
    const names = draftRows(mixed, TOPOLOGY_SCHEMA, IEEE14).map((row) => row.name);
    expect(names.slice(0, 2)).toEqual(['Line Line_21', 'Transformer (2W) Line_22']);
  });

  it('proposes none to a draft whose idx was emptied, and reserves none for it', () => {
    const loads = [draft('PQ', { idx: '' }), draft('PQ', {}, 'draft-2')];
    expect(draftReservedIdxs(loads, IEEE14).get('draft-2')).toEqual([]);
    const [first, second] = draftRows(loads, TOPOLOGY_SCHEMA, IEEE14);
    expect(first?.summary).toMatch(/^Missing idx/);
    expect(second?.name).toBe('PQ load PQ_12');
  });

  it('is what the status of a draft is worked out with', () => {
    const status = draftStatus(draft('PQ'), TOPOLOGY_SCHEMA, IEEE14, ['PQ_12', 'PQ_13']);
    expect(status?.values.idx).toBe('PQ_14');
  });
});

describe('the rows of the list of drafts', () => {
  it('say of each draft what it is, whether it can be added, and what it lacks', () => {
    const rows = draftRows(
      [
        draft('PV', { bus: '4', Sn: '100', Vn: '69', p0: '0.4', v0: '1.02' }),
        draft('Bus', {}, 'draft-2'),
      ],
      TOPOLOGY_SCHEMA,
      IEEE14,
    );
    expect(rows).toEqual([
      { id: 'draft-1', kind: 'PV', name: 'PV generator 6', ready: true, summary: 'Ready to add' },
      { id: 'draft-2', kind: 'Bus', name: 'Bus 15', ready: false, summary: 'Missing name and Vn' },
    ]);
  });

  it('are not known to be ready while the schema is not in', () => {
    expect(draftRows([draft('PV')], undefined, IEEE14)).toEqual([
      { id: 'draft-1', kind: 'PV', name: 'PV generator', ready: false, summary: 'Checking' },
    ]);
  });
});

describe('what the diagram draws for a draft', () => {
  it('is a symbol of its own where it was placed, in a box of one size', () => {
    const { nodes, edges } = graphOf([draft('PV'), draft('Bus', {}, 'draft-2', { x: 0, y: 0 })]);
    expect(edges).toEqual([]);
    expect(nodes.map((n) => [n.id, n.type, n.position])).toEqual([
      ['draft-1', DRAFT_NODE_TYPE, { x: 40, y: 60 }],
      ['draft-2', DRAFT_NODE_TYPE, { x: 0, y: 0 }],
    ]);
    expect(nodes[0]).toMatchObject({
      initialWidth: DRAFT_NODE_SIZE.width,
      initialHeight: DRAFT_NODE_SIZE.height,
      ariaLabel: 'Draft PV generator 6: Missing bus, Sn, Vn, p0 and v0',
      data: { draft: true, idx: 'draft-1', kind: 'PV', caption: 'PV 6', ready: false },
    });
    expect(nodes[0]?.data.parentBus).toBeUndefined();
  });

  it('has a box of whole grid steps, so a draft on the grid has its ports on it', () => {
    expect(DRAFT_NODE_SIZE.width % (2 * GRID_STEP)).toBe(0);
    expect(DRAFT_NODE_SIZE.height % (2 * GRID_STEP)).toBe(0);
  });

  it('wires a device that names a bus of the case to it, like the device it will be', () => {
    const { nodes, edges } = graphOf([draft('PQ', { bus: '4' })]);
    expect(nodes[0]?.data.parentBus).toBe('4');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: 'stub-draft-1',
      type: 'stub',
      source: 'draft-1',
      target: '4',
      data: { draft: true, draftId: 'draft-1', ready: false },
    });
    // The words a connector of the case is named by end the name of this one.
    expect(edges[0]?.ariaLabel).toMatch(/, connection to bus 4$/);
  });

  it('does not wire a draft to a bus the case does not have', () => {
    const { nodes, edges } = graphOf([draft('PQ', { bus: '99' })]);
    expect(edges).toEqual([]);
    expect(nodes[0]?.data.parentBus).toBeUndefined();
  });

  it('draws a line that names both its buses as the branch it will be, in the place of its symbol', () => {
    const { nodes, edges } = graphOf([draft('Line', { bus1: '6', bus2: '8' })]);
    expect(nodes).toEqual([]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: draftBranchEdgeId('draft-1'),
      type: 'topology',
      source: '6',
      target: '8',
      data: { draft: true, draftId: 'draft-1' },
    });
    expect(edges[0]?.ariaLabel).toMatch(/, bus 6 to bus 8$/);
    // A transformer is drawn with its symbol.
    const trafo = graphOf([draft('Transformer2W', { bus1: '6', bus2: '8' })]).edges[0];
    expect(trafo).toMatchObject({ type: 'transformer', data: { winding: '2w' } });
  });

  it('keeps a line that names one bus, or the same bus twice, as a symbol', () => {
    const held: DraftElement['values'][] = [
      { bus1: '6' },
      { bus1: '6', bus2: '6' },
      { bus1: '6', bus2: '99' },
    ];
    for (const values of held) {
      const { nodes, edges } = graphOf([draft('Line', values)]);
      expect(edges).toEqual([]);
      expect(nodes).toHaveLength(1);
    }
  });

  it('keeps the route chosen for a draft branch only while its buses stand where they stood', () => {
    const id = draftBranchEdgeId('draft-1');
    const points: [number, number][] = [
      [1000, 0],
      [1000, -40],
      [1400, -40],
      [1400, 0],
    ];
    const drafts = [draft('Line', { bus1: '6', bus2: '8' })];
    const here = { source: { ...BUS_POSITIONS.get('6')! }, target: { ...BUS_POSITIONS.get('8')! } };
    const kept = graphOf(drafts, { [id]: { points, anchors: here } }).edges[0];
    expect(kept).toMatchObject({ type: 'routed', data: { bendPoints: points, bendAnchors: here } });
    const moved = { ...here, target: { x: here.target.x + 16, y: here.target.y } };
    const dropped = graphOf(drafts, { [id]: { points, anchors: moved } }).edges[0];
    expect(dropped?.type).toBe('topology');
    expect(dropped?.data?.bendPoints).toBeUndefined();
  });

  it('says of a node or an edge which draft it is drawn for', () => {
    const device = graphOf([draft('PQ', { bus: '4' })]);
    expect(draftIdOf(device.nodes[0])).toBe('draft-1');
    expect(draftIdOf(device.edges[0])).toBe('draft-1');
    expect(draftIdOf({ data: { idx: '4' } })).toBeNull();
    expect(draftIdOf(undefined)).toBeNull();
  });

  it('draws the line of a draft dashed, in the colour of its badge', () => {
    expect(draftStrokeStyle(false)).toMatchObject({
      stroke: 'var(--color-warning)',
      strokeDasharray: '6 4',
    });
    expect(draftStrokeStyle(true).stroke).toBe('var(--color-success)');
    expect(draftStrokeStyle(true, true)).toMatchObject({
      stroke: 'var(--color-primary)',
      strokeDasharray: '6 4',
    });
  });

  it('leaves nothing of a draft in the layout that is written beside the case', () => {
    const coords = Object.fromEntries(BUS_POSITIONS);
    const base = buildGraph(IEEE14, coords);
    const drafted = graphOf([
      draft('PV'),
      draft('PQ', { bus: '4' }, 'draft-2'),
      draft('Line', { bus1: '6', bus2: '8' }, 'draft-3'),
    ]);
    const withDrafts = {
      nodes: [...base.nodes, ...drafted.nodes],
      edges: [...base.edges, ...drafted.edges],
    };
    // But for the time each was captured at, which is a clock's.
    const captured = (graph: typeof base) => ({
      ...captureLayout(graph, IEEE14, null),
      last_modified: '',
    });
    expect(captured(withDrafts)).toEqual(captured(base));
    expect(JSON.stringify(captured(withDrafts))).not.toContain('draft');
  });
});

describe('what a draft becomes once it is added', () => {
  it('is drawn on a node of its own for a bus, a static generator, a load and a shunt', () => {
    expect(addedNodeId('Bus', '15')).toBe('15');
    expect(addedNodeId('PV', '6')).toBe('generator-6');
    expect(addedNodeId('Slack', '1')).toBe('generator-1');
    expect(addedNodeId('PQ', 'PQ_12')).toBe('load-PQ_12');
    expect(addedNodeId('Shunt', 'SH3')).toBe('shunt-SH3');
    // A line is an edge, a machine joins its generator, a controller is named on it.
    for (const model of ['Line', 'GENROU', 'ESD1', 'TGOV1', 'ZIP']) {
      expect(addedNodeId(model, '1')).toBeNull();
    }
  });

  it('is selected as the element the Inspector shows for its model', () => {
    expect(addedElement('Bus', { idx: '15' })).toEqual({ kind: 'bus', idx: '15' });
    expect(addedElement('PV', { idx: 6 })).toEqual({
      kind: 'generator',
      idx: '6',
      modelClass: 'PV',
    });
    expect(addedElement('PQ', { idx: 'PQ_12' })).toMatchObject({ kind: 'load', idx: 'PQ_12' });
    expect(addedElement('Shunt', { idx: 'SH3' })).toEqual({ kind: 'shunt', idx: 'SH3' });
    expect(addedElement('TGOV1', { idx: 'TGOV1_3' })).toEqual({
      kind: 'controller',
      subKind: 'governor',
      modelClass: 'TGOV1',
      idx: 'TGOV1_3',
    });
    expect(addedElement('Bus', {})).toBeNull();
  });

  it('is listed with the transformers for a line with a tap or a phase shift', () => {
    expect(addedElement('Line', { idx: 'L1' })).toEqual({ kind: 'line', idx: 'L1' });
    expect(addedElement('Line', { idx: 'L1', tap: 1 })).toEqual({ kind: 'line', idx: 'L1' });
    expect(addedElement('Line', { idx: 'T1', tap: 1.05 })).toEqual({
      kind: 'transformer',
      idx: 'T1',
    });
    expect(addedElement('Line', { idx: 'T1', phi: 0.1 })).toEqual({
      kind: 'transformer',
      idx: 'T1',
    });
  });
});
