/**
 * Nothing on the diagram of the IEEE 118-bus case is drawn over anything
 * else when a device is moved to another bus, and bringing it beside that
 * bus stays quick: the picture of the whole diagram is asked a few times.
 * (A component dropped on a bus and a line drawn between two are held there
 * by `noOverlapDrafts118.test.ts`: they are drafts.)
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { CASE118 } from '../../helpers/case118';
import { drawn, opened, overlapsOf, pictureTime, settled } from '../../helpers/diagramStates';
import { rehung } from '../../helpers/wiringSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

describe('nothing overlaps on a case of a hundred buses when a device is moved to another bus', () => {
  it('IEEE 118: a load and a generator, to a bus beside theirs and to one across the diagram', async () => {
    const first = settled(await opened(CASE118));
    const buses = first.nodes.filter((n) => n.type === 'bus').map((n) => n.id);
    const devices = [
      first.nodes.find((n) => n.type === 'load')!,
      first.nodes.find((n) => n.type === 'generator')!,
    ];
    const found: string[] = [];
    const took: number[] = [];
    for (const device of devices) {
      const from = (device.data as { parentBus: string }).parentBus;
      const at = buses.indexOf(from);
      for (const bus of [buses[(at + 1) % buses.length]!, buses[(at + 60) % buses.length]!]) {
        const started = performance.now();
        const after = rehung(first, device.id, bus, true);
        took.push(performance.now() - started);
        const what = `${device.id} from bus ${from} to bus ${bus}`;
        expect(after, what).not.toBeNull();
        expect(after!.edges.find((e) => e.id === `stub-${device.id}`)?.target).toBe(bus);
        found.push(...drawn(after!).unrouted.map((id) => `${what}: no route for ${id}`));
        found.push(...overlapsOf(after!).map((text) => `${what}: ${text}`));
      }
    }
    expect(found).toEqual([]);
    // Each a rebuild of the diagram and a place beside the bus, which comes
    // to twenty or thirty pictures of the diagram as it stands: far inside
    // what a person waits for (two hundred are six seconds on a laptop).
    expect(Math.max(...took) / pictureTime(first)).toBeLessThan(200);
  }, 180_000);
});
