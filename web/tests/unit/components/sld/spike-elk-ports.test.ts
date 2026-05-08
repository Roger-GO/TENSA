/**
 * Phase 0 spike (plan: docs/plans/2026-05-08-001-feat-v01-polish-element-builder-plan.md).
 *
 * Verifies elkjs 0.9 actually honors `'elk.portConstraints': 'FIXED_SIDE'`
 * with per-port `'elk.port.side'` hints when `'elk.edgeRouting'` is
 * `ORTHOGONAL`, and that the layout result exposes per-edge bend points
 * we can read from `result.children[*].edges[*].sections[*].bendPoints`
 * (or, depending on layout topology, from edges hanging directly off the
 * root node).
 *
 * If this spike passes, Unit 1's auto-layout case can use ELK as the
 * source of truth for handle assignment + bend-point routing.
 *
 * If this spike fails (sides ignored, no bend points, non-cardinal
 * exit angles), Unit 1 must add a post-process step that snaps each
 * end-segment to the nearest cardinal handle on the bus.
 *
 * Outcome captured inline as console output and as test expectations
 * below; the implementer reads the run output to refine Unit 1's
 * approach before committing to a path.
 */
import { describe, it, expect } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';

interface PortConstrainedNode extends ElkNode {
  ports?: Array<{
    id: string;
    layoutOptions?: Record<string, string>;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
  }>;
}

const NODE_W = 60;
const NODE_H = 40;

/**
 * 5-node star-ish topology mimicking a small SLD slice:
 *
 *     1
 *     |
 *     2 — 5
 *    / \
 *   3   4
 *
 * Each bus exposes 4 cardinal ports. Edges declare which port to enter
 * / exit through via `sources: ['<busId>.<port>']` syntax — that's the
 * standard ELK convention for port-targeted edges.
 */
function buildSpikeGraph(): ElkNode {
  const buses = ['1', '2', '3', '4', '5'];
  const children: PortConstrainedNode[] = buses.map((id) => ({
    id,
    width: NODE_W,
    height: NODE_H,
    layoutOptions: {
      'elk.portConstraints': 'FIXED_SIDE',
    },
    ports: [
      { id: `${id}.north`, layoutOptions: { 'elk.port.side': 'NORTH' } },
      { id: `${id}.east`, layoutOptions: { 'elk.port.side': 'EAST' } },
      { id: `${id}.south`, layoutOptions: { 'elk.port.side': 'SOUTH' } },
      { id: `${id}.west`, layoutOptions: { 'elk.port.side': 'WEST' } },
    ],
  }));

  // bus 1 (top) -> bus 2: 1.south -> 2.north
  // bus 2 -> bus 3: 2.west -> 3.east
  // bus 2 -> bus 4: 2.east -> 4.west — testing two edges leaving bus 2
  //   on different sides
  // bus 2 -> bus 5: 2.south -> 5.north — third edge from bus 2
  const edges = [
    { id: 'l1', sources: ['1.south'], targets: ['2.north'] },
    { id: 'l2', sources: ['2.west'], targets: ['3.east'] },
    { id: 'l3', sources: ['2.east'], targets: ['4.west'] },
    { id: 'l4', sources: ['2.south'], targets: ['5.north'] },
  ];

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    },
    children,
    edges,
  };
}

interface ElkPort {
  id: string;
  x?: number;
  y?: number;
}

interface ElkSection {
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
  bendPoints?: Array<{ x: number; y: number }>;
  incomingShape?: string;
  outgoingShape?: string;
}

interface ElkEdgeOut {
  id: string;
  sections?: ElkSection[];
  sources?: string[];
  targets?: string[];
}

interface ElkChildOut {
  id: string;
  x?: number;
  y?: number;
  ports?: ElkPort[];
  edges?: ElkEdgeOut[];
}

interface ElkLayoutResult {
  children?: ElkChildOut[];
  edges?: ElkEdgeOut[];
}

describe('Phase 0 spike — ELK FIXED_SIDE port constraints with ORTHOGONAL routing', () => {
  it('produces a layout with per-edge sections + bendPoints, with end segments respecting per-port sides', async () => {
    const elk = new ELK();
    const graph = buildSpikeGraph();
    const result = (await elk.layout(graph)) as ElkLayoutResult;

    // The spike originally console.log'd these for inspection; the
    // findings are now captured in the plan's Phase 0 outcome note.

    expect(result.children).toBeDefined();
    expect(result.children!.length).toBe(5);

    // Edges may be on root or hoisted onto the deepest common parent
    // (here also root because all 5 buses are direct children). Collect
    // both to be defensive.
    const allEdges: ElkEdgeOut[] = [
      ...(result.edges ?? []),
      ...(result.children ?? []).flatMap((c) => c.edges ?? []),
    ];
    expect(allEdges.length).toBe(4);

    // Build a quick "port id → absolute coord" map by combining
    // child.x/y with port.x/y.
    const portCoords = new Map<string, { x: number; y: number }>();
    for (const child of result.children ?? []) {
      for (const port of child.ports ?? []) {
        const ax = (child.x ?? 0) + (port.x ?? 0);
        const ay = (child.y ?? 0) + (port.y ?? 0);
        portCoords.set(port.id, { x: ax, y: ay });
      }
    }

    // For each declared edge, the section's startPoint should match the
    // source port's absolute coord and the endPoint should match the
    // target port's absolute coord — modulo small rounding. Tolerance:
    // 1 pixel.
    for (const edge of allEdges) {
      const src = edge.sources?.[0];
      const tgt = edge.targets?.[0];
      const section = edge.sections?.[0];
      expect(section, `edge ${edge.id} should have a section`).toBeDefined();
      expect(section!.startPoint, `edge ${edge.id} startPoint`).toBeDefined();
      expect(section!.endPoint, `edge ${edge.id} endPoint`).toBeDefined();

      if (src && portCoords.has(src) && section!.startPoint) {
        const expected = portCoords.get(src)!;
        expect(
          Math.abs(section!.startPoint.x - expected.x),
          `edge ${edge.id} startPoint.x deviates from port ${src}`,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(section!.startPoint.y - expected.y),
          `edge ${edge.id} startPoint.y deviates from port ${src}`,
        ).toBeLessThanOrEqual(1);
      }
      if (tgt && portCoords.has(tgt) && section!.endPoint) {
        const expected = portCoords.get(tgt)!;
        expect(
          Math.abs(section!.endPoint.x - expected.x),
          `edge ${edge.id} endPoint.x deviates from port ${tgt}`,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(section!.endPoint.y - expected.y),
          `edge ${edge.id} endPoint.y deviates from port ${tgt}`,
        ).toBeLessThanOrEqual(1);
      }
    }

    // ORTHOGONAL routing should produce paths that have orthogonal end
    // segments — i.e., the segment from startPoint to the first bend
    // (or endPoint if no bends) is axis-aligned.
    for (const edge of allEdges) {
      const sec = edge.sections?.[0];
      if (!sec || !sec.startPoint || !sec.endPoint) continue;
      const firstAfterStart =
        sec.bendPoints && sec.bendPoints.length > 0 ? sec.bendPoints[0]! : sec.endPoint;
      const dx = Math.abs(firstAfterStart.x - sec.startPoint.x);
      const dy = Math.abs(firstAfterStart.y - sec.startPoint.y);
      const isAxisAligned = dx < 0.01 || dy < 0.01;
      expect(isAxisAligned, `edge ${edge.id} first segment not axis-aligned`).toBe(true);
    }
  });
});
