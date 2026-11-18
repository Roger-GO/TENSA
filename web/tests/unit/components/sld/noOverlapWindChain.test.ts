/**
 * The control badges of a type-3 wind turbine whose converter names no generator of the case
 * stand where nothing else is.
 *
 * The converter and its electrical control dock beside the bus the converter acts on, and the
 * drive train beside the control (`avr`, `reg`, `ree`). The aerodynamics, pitch control and torque
 * control (`rego`, `rea`, `rep`) are not docked a step further each: a docked badge stands at a
 * fixed offset with no look at what is there, and the third and fourth step of a chain walk into
 * the lines and symbols of IEEE 14. They stay orphan badges in the gutter.
 *
 * What is held here is those three badges. The two that dock beside the bus (the converter and
 * its control) and the drive train after them are not checked for overlaps: they stand over the
 * bar or a neighbouring symbol, which no shipped case reaches (a converter with a generator
 * that is not in the case), and the check for them is not made here.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK engine run in-thread,
 * as in `noOverlap.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import { bothWays, opened, tidied } from '../../helpers/diagramStates';
import { IEEE14 } from '../../helpers/exampleCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

function ctrl(idx: string, kind: string, params: Record<string, number | string>): TopologyEntry {
  return { idx, name: `${kind} ${idx}`, kind, params };
}

/** IEEE 14 with a wind turbine's chain on `bus`, whose converter names a generator that is not there. */
function withWindChain(bus: number): TopologySummary {
  return {
    ...IEEE14,
    controllers: [
      ...(IEEE14.controllers ?? []),
      ctrl('R1', 'REGCA1', { bus, gen: 'GONE' }),
      ctrl('E1', 'REECA1', { reg: 'R1' }),
      ctrl('D1', 'WTDTA1', { ree: 'E1' }),
      ctrl('A1', 'WTARA1', { rego: 'D1' }),
      ctrl('P1', 'WTPTA1', { rea: 'A1' }),
      ctrl('T1', 'WTTQA1', { rep: 'P1' }),
    ],
  };
}

const GUTTER = ['controller-WTARA1-A1', 'controller-WTPTA1-P1', 'controller-WTTQA1-T1'];

describe('a wind turbine chain whose generator is not drawn', () => {
  it.each([14, 5])(
    'keeps the aerodynamics, pitch and torque badges in the gutter, over nothing, with the chain on bus %i',
    async (bus) => {
      const first = await opened(withWindChain(bus));
      for (const id of GUTTER) {
        const node = first.nodes.find((n) => n.id === id)!;
        expect((node.data as { orphan?: boolean }).orphan).toBe(true);
        expect(node.position.x).toBe(24);
      }
      for (const state of [first, tidied(first, false), tidied(first, true)]) {
        const found = bothWays(state).filter((text) => GUTTER.some((id) => text.includes(id)));
        expect(found).toEqual([]);
      }
    },
    60_000,
  );
});
