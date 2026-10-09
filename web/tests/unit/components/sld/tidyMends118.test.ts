/**
 * Tidy diagram mends every line that does not hold on a diagram of a
 * hundred buses, in one press.
 *
 * The IEEE 118-bus case is drawn here the way a layout has it that was
 * saved with the places of its buses and devices and without the routes of
 * its lines, or with half of them. The diagram routes such a line as it is
 * drawn, a few at a time (`routeDiagram`), which on a diagram this size
 * leaves some on a symbol, on a bar or beside another line, and some drawn
 * the plain way for want of a route. Routing every line afresh clears all
 * of that; a tidy that leaves the routes that hold as they are
 * (`planTidy`) must clear it as well, though it plans more than once
 * within the steps it has. The three example cases are too small for a tidy
 * to run short of steps on them (`tidyKeeps*.test.ts`); this one is not.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { planTidy } from '@/components/sld/tidyPlan';
import { CASE118 } from '../../helpers/case118';
import { drawn, opened, overlapsOf, withPlan, type Diagram } from '../../helpers/diagramStates';
import { measured, type Shown } from '../../helpers/tidySweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

/** `diagram` without the routes of the lines and transformers `out` picks, counted from 0. */
function withoutRoutes(diagram: Diagram, out: (nth: number) => boolean): Diagram {
  let nth = 0;
  const edges = diagram.edges.map((edge) => {
    if (edge.type === 'stub') return edge;
    nth += 1;
    if (!out(nth - 1)) return edge;
    return { ...edge, data: { ...edge.data, bendPoints: undefined, bendAnchors: undefined } };
  });
  return { ...diagram, edges };
}

/** Which routes the layout came without. */
const TAKEN_OUT: readonly (readonly [string, (nth: number) => boolean])[] = [
  ['every route', () => true],
  ['every other route', (nth) => nth % 2 === 1],
];

describe('Tidy diagram mends the lines of a hundred buses that do not hold', () => {
  for (const [what, out] of TAKEN_OUT) {
    it(`IEEE 118 with ${what} taken out: after one tidy nothing is drawn over anything else, and no line the plain way`, async () => {
      const before = withoutRoutes(await opened(CASE118), out);
      const shown: Shown = { values: false };
      // What a tidy is for: lines on something, and lines no way was found for.
      expect(overlapsOf(before, shown)).not.toEqual([]);
      expect(drawn(before, shown).unrouted).not.toEqual([]);

      const graph = { nodes: before.nodes, edges: before.edges };
      const options = { relayout: false, barLengths: before.barLengths };
      const plan = planTidy(graph, CASE118, { ...options, shown });
      expect(plan.refused).toBeUndefined();
      // It leaves no more lines without a way than routing every line afresh does.
      const afresh = planTidy(graph, CASE118, options);
      expect(plan.tidied.unrouted.length).toBeLessThanOrEqual(afresh.tidied.unrouted.length);

      const after = withPlan(before, plan);
      expect(drawn(after, shown).unrouted).toEqual([]);
      expect(overlapsOf(after, shown)).toEqual([]);
      // And the lines it says it left run as they ran.
      const [was, now] = [measured(before, shown), measured(after, shown)];
      expect(plan.left?.length).toBeGreaterThan(0);
      for (const id of plan.left ?? [])
        expect(now.get(id)!.points, id).toEqual(was.get(id)!.points);
    }, 120_000);
  }
});
