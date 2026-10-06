/**
 * The sides of a bus and of a device, and which side of its two buses a
 * branch leaves from.
 *
 * A leaf module: `connections.ts` (where every connector attaches and runs)
 * and `graph.ts` (the nodes and edges of the diagram) both build on it, and
 * `graph.ts` re-exports its names.
 */

/** Cardinal handle sides exposed by every Bus node. */
export type Side = 'north' | 'east' | 'south' | 'west';

/**
 * Handle id convention. Each Bus exposes a `<side>-source` and a
 * `<side>-target` Handle so an edge can specify exactly which corner to
 * enter / exit. The id is `<side>-<role>`.
 */
export const SOURCE_HANDLE: Record<Side, string> = {
  north: 'north-source',
  east: 'east-source',
  south: 'south-source',
  west: 'west-source',
};
export const TARGET_HANDLE: Record<Side, string> = {
  north: 'north-target',
  east: 'east-target',
  south: 'south-target',
  west: 'west-target',
};

/**
 * Handle ids of a generator, load or shunt node: one port at the middle of
 * each face. The connector to the bus leaves from the port on the face that
 * points at the bus (`connections.ts` works out which, from where the device
 * and its bus sit now).
 */
export const DEVICE_PORT: Record<Side, string> = {
  north: 'port-north',
  east: 'port-east',
  south: 'port-south',
  west: 'port-west',
};

/** The side of a bus each end of a branch leaves from. */
export interface HandleAssignment {
  sourceSide: Side;
  targetSide: Side;
}

/**
 * Pick cardinal handle sides for a single edge based on the geometry
 * of its terminal-bus pair. The dominant axis of the (to - from) vector
 * picks the source side; the target side is the opposite cardinal.
 *
 * - Horizontal-dominant: source = 'east', target = 'west' (or reversed).
 * - Vertical-dominant: source = 'south', target = 'north' (or reversed).
 *
 * Degenerate (same coord): falls back to a reasonable default and emits
 * a single console warning (not per-edge — buses overlapping is itself
 * a bug worth surfacing once).
 *
 * Pure function — no I/O, no React Flow, no React.
 */
export function assignHandles(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { sourceSide: Side; targetSide: Side } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return { sourceSide: 'east', targetSide: 'east' };
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0
      ? { sourceSide: 'east', targetSide: 'west' }
      : { sourceSide: 'west', targetSide: 'east' };
  }
  return dy > 0
    ? { sourceSide: 'south', targetSide: 'north' }
    : { sourceSide: 'north', targetSide: 'south' };
}

/** One branch as the side assignment reads it: its edge id and the bus at each end. */
export interface BranchEnds {
  id: string;
  source: string;
  target: string;
}

function leavesAnEnd(sides: HandleAssignment): boolean {
  return sides.sourceSide === 'east' || sides.sourceSide === 'west';
}

/**
 * How far apart up and down, for each unit across, two buses can be and
 * still stand in a row. Buses in a row are joined end to end; the others
 * are joined by their faces.
 */
const ROW_SLOPE = 1 / 4;

/**
 * The side of its two buses each branch leaves from.
 *
 * A bus is drawn as a horizontal bar. Its two long faces (`north`, `south`)
 * take as many connections as the bar has room for, each at a tap of its
 * own, and the bar grows when they need more room (`connections.ts`). Its
 * two ends (`east`, `west`) are a single point each, so an end takes one
 * branch: a second one leaving the same end would run on top of the first
 * until the two part.
 *
 * So the ends are for two buses that stand in a row (`ROW_SLOPE`): the
 * branch between them leaves the end of each that looks at the other. Any
 * other branch goes down from the south face of the upper bus onto the
 * north face of the lower one, as a feeder is drawn. A branch between two
 * buses of a row whose end is taken, by an earlier branch or by one of
 * `claimedEnds` (`<bus>|east`, `<bus>|west`), goes by the faces as well.
 * Two buses that are exactly level have no face looking at the other; a
 * further branch between them then leaves both by the north face and
 * bridges over, and the one after that by the south face.
 *
 * Branches are taken in the order given, so the result is the same for the
 * same input. One whose bus has no coordinate gets no entry.
 */
export function assignBranchSides(
  branches: readonly BranchEnds[],
  coords: Readonly<Record<string, { x: number; y: number } | undefined>>,
  claimedEnds: Iterable<string> = [],
): Map<string, HandleAssignment> {
  let warnedDegenerate = false;
  const taken = new Set<string>(claimedEnds);
  const bridges = new Map<string, number>();
  const out = new Map<string, HandleAssignment>();
  for (const branch of branches) {
    const from = coords[branch.source];
    const to = coords[branch.target];
    if (!from || !to) continue;
    if (!warnedDegenerate && from.x === to.x && from.y === to.y) {
      console.warn(
        `SLD: bus ${branch.source} and ${branch.target} share the same coordinate; falling back to default handles`,
      );
      warnedDegenerate = true;
    }
    const inARow = Math.abs(to.y - from.y) <= ROW_SLOPE * Math.abs(to.x - from.x);
    // Out of the face of each bus that looks at the other.
    const byFaces = (): HandleAssignment =>
      to.y > from.y
        ? { sourceSide: 'south', targetSide: 'north' }
        : { sourceSide: 'north', targetSide: 'south' };
    let chosen = inARow ? assignHandles(from, to) : byFaces();
    if (
      leavesAnEnd(chosen) &&
      (taken.has(`${branch.source}|${chosen.sourceSide}`) ||
        taken.has(`${branch.target}|${chosen.targetSide}`))
    ) {
      if (to.y === from.y) {
        // Level buses: bridge over the two bars, then under them.
        const pair = [branch.source, branch.target].sort().join('|');
        const nth = bridges.get(pair) ?? 0;
        bridges.set(pair, nth + 1);
        const face: Side = nth % 2 === 0 ? 'north' : 'south';
        chosen = { sourceSide: face, targetSide: face };
      } else {
        chosen = byFaces();
      }
    }
    if (leavesAnEnd(chosen)) {
      taken.add(`${branch.source}|${chosen.sourceSide}`);
      taken.add(`${branch.target}|${chosen.targetSide}`);
    }
    out.set(branch.id, chosen);
  }
  return out;
}
