/**
 * Nothing on the diagram is drawn over anything else on the WECC 179-bus case, the largest of
 * the dynamic cases of the gallery (`wecc/wecc_full.xlsx`), as it opens, tidied, laid out again,
 * and with the values of a power flow shown.
 *
 * What the case showed that the smaller ones did not: the lines of two buses that stand level
 * (129 and 108) each had a tap past a tip of its bar, taken in turn, so the two bars were drawn
 * out towards each other to 10 px apart, which reads as one bar with a break in it. A route
 * that comes late in a crowd takes the first way the search finds, and the price of the fault
 * was no help to it, so the router now keeps the bars `BAR_GAP` apart as a rule and takes the
 * fault only for a branch that has no way without it (`tidy.ts`).
 *
 * It also holds that every machine control of the case stands on the symbol of its unit: four of
 * the stabilisers work through an ESST3A exciter, and a stabiliser whose exciter the topology
 * does not list is a badge in the gutter marked as orphaned.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK engine run in-thread,
 * as in `noOverlap.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { BAR_GAP } from '@/components/sld/connections';
import { bothWays, drawn, opened, tidied } from '../../helpers/diagramStates';
import { WECC179 } from '../../helpers/case179';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

/** A case of this size takes the layout a few seconds a state, on a slow runner more. */
const TIME = 120_000;

describe('nothing overlaps on WECC 179', () => {
  it(
    'as it opens, tidied, and laid out again, with and without values',
    async () => {
      const first = await opened(WECC179);
      expect(bothWays(first)).toEqual([]);
      expect(bothWays(tidied(first, false))).toEqual([]);
      expect(bothWays(tidied(first, true))).toEqual([]);
    },
    TIME,
  );

  it(
    'keeps the bars of buses 129 and 108, which stand level, a gap apart',
    async () => {
      const first = await opened(WECC179);
      const bars = drawn(first).connections.bars;
      const [west, east] = [
        first.nodes.find((n) => n.id === '129')!,
        first.nodes.find((n) => n.id === '108')!,
      ];
      expect(west.position.y).toBe(east.position.y);
      expect(west.position.x).toBeLessThan(east.position.x);
      const gap =
        east.position.x + bars.get('108')!.start - (west.position.x + bars.get('129')!.end);
      expect(gap).toBeGreaterThanOrEqual(BAR_GAP);
    },
    TIME,
  );

  it(
    'puts every machine control on the symbol of its unit, with no badge in the gutter',
    async () => {
      const first = await opened(WECC179);
      // Every one of the 87 exciters, governors and stabilisers names a machine or an exciter the
      // topology lists, so none is drawn as a badge of its own.
      expect(WECC179.controllers).toHaveLength(87);
      expect(first.nodes.filter((n) => n.type === 'controller').map((n) => n.id)).toEqual([]);
    },
    TIME,
  );
});
