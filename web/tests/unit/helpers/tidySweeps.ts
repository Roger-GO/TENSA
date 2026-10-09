/**
 * Tidy diagram leaves no line worse off: a line or a transformer whose route
 * holds as the diagram draws it (on nothing, and found by the router) has
 * after a tidy the route it had, or one that is no longer, has no more
 * bends and is crossed in no more places (`planTidy`).
 *
 * `holdTidy` holds an example case to that after any of its generators,
 * loads and shunts was moved: the diagram is laid out again with the values
 * of a power flow on it, one device is dragged by a spread of moves (beside
 * its bus, across it, away from it), and the diagram is tidied. It also
 * holds a tidy to being of use: a device is put in the way of lines and
 * taken away again, and the lines that went round it are the ones a tidy
 * changes, back to the way they had. Each example case runs both in a test
 * file of its own (`tidyKeeps*.test.ts`), side by side with the others.
 *
 * A test file that calls it mocks `@/components/sld/elkClient` with the ELK
 * engine run in-thread, as `noOverlap.test.ts` does.
 */
import { describe, expect, it } from 'vitest';
import type { TopologySummary } from '@/api/types';
import type { Point } from '@/components/sld/connections';
import { crossingsByLine } from '@/components/sld/overlapCheck';
import { drawnDiagram, type PictureOptions } from '@/components/sld/picture';
import { planTidy } from '@/components/sld/tidyPlan';
import {
  dragged,
  drawn,
  opened,
  overlapsOf,
  tidied,
  typicalWidths,
  type Diagram,
} from './diagramStates';

/** How a tidy looks at a diagram: with the values of a power flow, or without. */
export type Shown = Pick<PictureOptions, 'values' | 'labelWidths'>;

/** What a line is measured by: how long it is, how many bends it has, and in how many places it is crossed. */
export interface Measure {
  length: number;
  bends: number;
  crossings: number;
  points: readonly Point[];
}

/** Every line and transformer of `diagram` as it is drawn, measured, by edge id. */
export function measured(diagram: Diagram, shown: Shown): Map<string, Measure> {
  const picture = drawn(diagram, shown);
  const { lines } = drawnDiagram(diagram.nodes, picture, shown);
  const crossed = crossingsByLine(lines);
  const branches = new Set(diagram.edges.filter((e) => e.type !== 'stub').map((e) => e.id));
  const out = new Map<string, Measure>();
  for (const { id, points } of lines) {
    if (!branches.has(id)) continue;
    let length = 0;
    for (let i = 1; i < points.length; i += 1) {
      length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    }
    let crossings = 0;
    for (const times of crossed.get(id)?.values() ?? []) crossings += times;
    out.set(id, { length, bends: points.length - 2, crossings, points });
  }
  return out;
}

/**
 * The lines of `after` that are worse off than in `before`, as text: longer
 * (by more than half a unit), with more bends, or crossed in more places.
 */
export function worseOff(before: Diagram, after: Diagram, shown: Shown): string[] {
  const [was, now] = [measured(before, shown), measured(after, shown)];
  const found: string[] = [];
  for (const [id, old] of was) {
    const made = now.get(id)!;
    if (
      made.length > old.length + 0.5 ||
      made.bends > old.bends ||
      made.crossings > old.crossings
    ) {
      found.push(
        `${id}: ${Math.round(old.length)} long, ${old.bends} bends, ${old.crossings} crossings` +
          ` -> ${Math.round(made.length)} long, ${made.bends} bends, ${made.crossings} crossings`,
      );
    }
  }
  return found;
}

/** Whether two routes run through the same points. */
function sameRoute(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);
}

/**
 * The moves every generator, load and shunt is dragged by: to either side,
 * over and under, across its bus to the far face (a device stands some 70
 * above or under its bar), and away from it.
 */
const DEVICE_MOVES: readonly (readonly [number, number])[] = [
  [-120, 0],
  [80, 0],
  [0, -120],
  [0, 120],
  [30, 111],
  [-30, -111],
  [-120, 80],
  [100, -100],
];

/**
 * A device of an example case and a move that puts it in the way of lines:
 * they go round it, and keep the way round when it is moved back.
 */
export interface InTheWay {
  device: string;
  dx: number;
  dy: number;
}

/** The sweep, for the example case `name` whose topology is `topology`. */
export function holdTidy(name: string, topology: TopologySummary, inTheWay: InTheWay): void {
  describe(`Tidy diagram leaves no line of ${name} worse off`, () => {
    it('and gives the lines that went round a device the shorter way back once the device has gone', async () => {
      const first = await opened(topology);
      const shown: Shown = { values: false };
      const { device, dx, dy } = inTheWay;
      const home = first.nodes.find((n) => n.id === device)!.position;
      const there = dragged(first, device, dx, dy);
      const stood = there.nodes.find((n) => n.id === device)!.position;
      const back = dragged(there, device, home.x - stood.x, home.y - stood.y);
      expect(back.nodes.find((n) => n.id === device)!.position).toEqual(home);
      // The lines that went round the device keep the way round: it holds.
      const [atFirst, was] = [measured(first, shown), measured(back, shown)];
      // (A line that is only crossed by one of them runs as it ran.)
      const worse = worseOff(first, back, shown).map((text) => text.slice(0, text.indexOf(':')));
      const wentRound = worse.filter(
        (id) => !sameRoute(atFirst.get(id)!.points, was.get(id)!.points),
      );
      expect(wentRound.length).toBeGreaterThan(0);
      expect(overlapsOf(back, shown)).toEqual([]);

      const plan = planTidy({ nodes: back.nodes, edges: back.edges }, topology, {
        relayout: false,
        barLengths: back.barLengths,
        shown,
      });
      const after = tidied(back, false, shown);
      // Each is as short and as straight again as before the device came,
      // and no other line was touched.
      expect(worseOff(first, after, shown)).toEqual([]);
      expect(worseOff(back, after, shown)).toEqual([]);
      const now = measured(after, shown);
      const changed = [...was]
        .filter(([id, { points }]) => !sameRoute(points, now.get(id)!.points))
        .map(([id]) => id);
      expect(changed.sort()).toEqual(wentRound.sort());
      expect([...(plan.left ?? [])].sort()).toEqual(
        [...was.keys()].filter((id) => !changed.includes(id)).sort(),
      );
      expect(overlapsOf(after, shown)).toEqual([]);
    }, 60_000);

    it('after any device was moved on a diagram that was laid out again', async () => {
      const first = await opened(topology);
      const shown: Shown = { values: true, labelWidths: typicalWidths(first) };
      const laid = tidied(first, true, shown);
      const found: string[] = [];
      const devices = laid.nodes.filter(
        (n) => n.type === 'generator' || n.type === 'load' || n.type === 'shunt',
      );
      for (const device of devices) {
        for (const [dx, dy] of DEVICE_MOVES) {
          const what = `${device.id} by ${dx}, ${dy}`;
          const dropped = dragged(laid, device.id, dx, dy);
          // Every route holds after the drop: each is one to keep or to better.
          expect(overlapsOf(dropped, shown), what).toEqual([]);
          expect(drawn(dropped, shown).unrouted, what).toEqual([]);
          const after = tidied(dropped, false, shown);
          found.push(...worseOff(dropped, after, shown).map((text) => `${what}: ${text}`));
          found.push(...overlapsOf(after, shown).map((text) => `${what}, tidied: ${text}`));
        }
      }
      expect(found).toEqual([]);
    }, 240_000);
  });
}
