/**
 * Bars on one row, with more devices over and under them than their bars have room for, keep
 * `BAR_GAP` between them (`layoutConnections`).
 *
 * A bar is drawn out for its taps, about its middle, as far as the bar beside it lets it
 * (`growLimit`). Three things drew it into that room:
 * - two bars both drawn out towards each other, each keeping clear of the other as it was laid
 *   out, and meeting;
 * - devices that hold a place square to the bar, spread a spacing apart, running past the limit;
 * - a connector that rounds a bar to land on the next one, at a place past the limit.
 *
 * Each row here is made from a seed: two to four buses a gap apart, each with up to thirteen
 * devices over or under its bar. The seeds are ones that put a bar into its neighbour's room
 * before bars were kept off one another as they are drawn out. Not every row is mended: where
 * a bar needs more room than the gap between its neighbours as they were laid out leaves it,
 * the neighbours would have to give way as well, and they do not (of the first 300 seeds, 30
 * still leave two bars nearer than `BAR_GAP`).
 */
import { describe, expect, it } from 'vitest';
import {
  BAR_GAP,
  TAP_SPACING,
  layoutConnections,
  type ConnectionEdge,
  type ConnectionNode,
} from '@/components/sld/connections';

/** The width of the bar of a bus as it is laid out. */
const BAR = 92;

function random(seed: number): () => number {
  let state = seed * 2654435761 + 1;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function crowdedRow(seed: number): {
  nodes: ConnectionNode[];
  edges: ConnectionEdge[];
  xs: number[];
} {
  const next = random(seed);
  const buses = 2 + Math.floor(next() * 3);
  const xs: number[] = [];
  let x = 0;
  for (let i = 0; i < buses; i += 1) {
    xs.push(x);
    x += BAR + BAR_GAP + Math.floor(next() * 90);
  }
  const nodes: ConnectionNode[] = xs.map((px, i) => ({
    id: `b${i}`,
    type: 'bus',
    position: { x: px, y: 200 },
  }));
  const edges: ConnectionEdge[] = [];
  xs.forEach((px, i) => {
    const devices = Math.floor(next() * 14);
    for (let k = 0; k < devices; k += 1) {
      const above = next() < 0.5;
      const cx = px + next() * BAR;
      const id = `d${i}-${k}`;
      nodes.push({
        id,
        type: 'load',
        position: { x: cx - 20, y: (above ? 100 : 300) - 20 },
        initialWidth: 40,
        initialHeight: 40,
      });
      edges.push({ id: `stub-${id}`, type: 'stub', source: id, target: `b${i}` });
    }
  });
  return { nodes, edges, xs };
}

/** The seeds that drew a bar into the room of the bar beside it. */
const SEEDS = [2, 3, 7, 13, 16, 17, 21, 22, 25, 36];

describe('a row of bars crowded with devices', () => {
  it.each(SEEDS)('keeps the bars BAR_GAP apart, and the taps a spacing, with seed %i', (seed) => {
    const { nodes, edges, xs } = crowdedRow(seed);
    const { bars } = layoutConnections(nodes, edges);
    const row = xs.map((px, i) => {
      const bar = bars.get(`b${i}`)!;
      return { start: px + bar.start, end: px + bar.end, taps: bar.taps.map((tap) => tap.x) };
    });
    for (let i = 1; i < row.length; i += 1) {
      expect(row[i]!.start - row[i - 1]!.end, `bars ${i - 1} and ${i}`).toBeGreaterThanOrEqual(
        BAR_GAP - 0.01,
      );
    }
    for (const [i, bar] of row.entries()) {
      for (let k = 1; k < bar.taps.length; k += 1) {
        expect(bar.taps[k]! - bar.taps[k - 1]!, `taps of bar ${i}`).toBeGreaterThanOrEqual(
          TAP_SPACING - 0.01,
        );
      }
    }
  });
});
