/**
 * Nothing on the diagram is drawn over anything else after any bus or any
 * device of a case was moved: the sweeps `noOverlap.test.ts` describes,
 * which take long enough that each example case runs them in a test file
 * of its own (`noOverlapMoves*.test.ts`), side by side with the others.
 *
 * - every bus, dragged by a spread of moves: while it is dragged (wherever
 *   the move does not put it on something), dropped, and after a tidy of
 *   that;
 * - every generator, load and shunt, dragged by a spread of moves near its
 *   bus, and by a spread that takes it far from its bus: dropped as the
 *   canvas drops it (`clearDrop`, held to the picture: `drawsClear`), and
 *   after a tidy of that.
 *
 * A test file that calls `holdMoves` mocks `@/components/sld/elkClient`
 * with the ELK engine run in-thread, as `noOverlap.test.ts` does.
 */
import { describe, expect, it } from 'vitest';
import type { TopologySummary } from '@/api/types';
import {
  bothWays,
  dragged,
  draggedWith,
  drawn,
  dropShift,
  moved,
  opened,
  tidied,
  whileDragged,
} from './diagramStates';

/**
 * The moves every bus of an example case is dragged by: along its row and
 * off it, a little way and a long way, among them the ones that once left a
 * line through the symbol of a transformer, the label of a bus on one, and
 * a symbol on a bar.
 */
const BUS_MOVES: readonly (readonly [number, number])[] = [
  [48, 0],
  [-64, 16],
  [16, -16],
  [-120, -120],
  [-120, 40],
  [0, -96],
  [0, -80],
  [16, -96],
  [120, 80],
  [120, 120],
  [160, -40],
  [-80, 80],
];

/** The moves every generator, load and shunt is dragged by. */
const DEVICE_MOVES: readonly (readonly [number, number])[] = [
  [-80, 0],
  [80, 0],
  [0, -60],
  [0, 60],
  [40, 40],
  [-120, 80],
  [100, -100],
  [-40, 140],
];

/**
 * The moves that take a device far from its bus, to where its connector has
 * a long way back: among them the ones that once left it run through the
 * symbol of another bus's device or through a bar, or a line through a bar,
 * and the ones after which a tidy did.
 */
const FAR_DEVICE_MOVES: readonly (readonly [number, number])[] = [
  [-220, 60],
  [-320, 70],
  [-320, 140],
  [-260, 200],
  [-140, -140],
  [-200, -200],
  [260, -140],
  [320, -200],
  [320, -140],
  [320, 70],
  [200, 70],
];

/** The sweeps, for the example case `name` whose topology is `topology`. */
export function holdMoves(name: string, topology: TopologySummary): void {
  describe(`nothing overlaps on ${name} after a bus or a device is moved`, () => {
    it(`after any bus is dragged and dropped, after a tidy of that, and while it is dragged`, async () => {
      const first = await opened(topology);
      const found: string[] = [];
      let clear = 0;
      for (const bus of first.nodes.filter((n) => n.type === 'bus')) {
        for (const [dx, dy] of BUS_MOVES) {
          const what = `bus ${bus.id} by ${dx}, ${dy}`;
          const ids = draggedWith(first, bus.id);
          const there = moved(first, ids, dx, dy);
          // While it is dragged: wherever the move does not put the bus or
          // one of its devices on something, which a drag passes through
          // and a drop does not stay on.
          const shift = dropShift(there, ids, first);
          if (shift === null) {
            clear += 1;
            found.push(
              ...whileDragged(there, first, true).map((text) => `${what}, dragged: ${text}`),
            );
          }
          const dropped = dragged(first, bus.id, dx, dy, shift);
          found.push(...drawn(dropped).unrouted.map((id) => `${what}: no route for ${id}`));
          found.push(...bothWays(dropped).map((text) => `${what}: ${text}`));
          found.push(...bothWays(tidied(dropped, false)).map((text) => `${what}, tidied: ${text}`));
        }
      }
      expect(found).toEqual([]);
      // Most of the moves are clear ones: the drag itself is held to the rule.
      expect(clear).toBeGreaterThan(BUS_MOVES.length);
    }, 600_000);

    it(`after any device is dragged and dropped, after a tidy of that, and while it is dragged`, async () => {
      const first = await opened(topology);
      const found: string[] = [];
      const devices = first.nodes.filter(
        (n) => n.type === 'generator' || n.type === 'load' || n.type === 'shunt',
      );
      for (const device of devices) {
        for (const [dx, dy] of DEVICE_MOVES) {
          const what = `${device.id} by ${dx}, ${dy}`;
          const ids = draggedWith(first, device.id);
          const there = moved(first, ids, dx, dy);
          const shift = dropShift(there, ids, first);
          if (shift === null) {
            found.push(
              ...whileDragged(there, first, true).map((text) => `${what}, dragged: ${text}`),
            );
          }
          const dropped = dragged(first, device.id, dx, dy, shift);
          found.push(...drawn(dropped).unrouted.map((id) => `${what}: no route for ${id}`));
          found.push(...bothWays(dropped).map((text) => `${what}: ${text}`));
          found.push(...bothWays(tidied(dropped, false)).map((text) => `${what}, tidied: ${text}`));
        }
      }
      expect(found).toEqual([]);
    }, 600_000);

    it(`after any device is dropped far from its bus, and after a tidy of that`, async () => {
      const first = await opened(topology);
      const found: string[] = [];
      const devices = first.nodes.filter(
        (n) => n.type === 'generator' || n.type === 'load' || n.type === 'shunt',
      );
      for (const device of devices) {
        for (const [dx, dy] of FAR_DEVICE_MOVES) {
          const what = `${device.id} by ${dx}, ${dy}`;
          const dropped = dragged(first, device.id, dx, dy);
          found.push(...drawn(dropped).unrouted.map((id) => `${what}: no route for ${id}`));
          found.push(...bothWays(dropped).map((text) => `${what}: ${text}`));
          found.push(...bothWays(tidied(dropped, false)).map((text) => `${what}, tidied: ${text}`));
        }
      }
      expect(found).toEqual([]);
    }, 600_000);
  });
}
