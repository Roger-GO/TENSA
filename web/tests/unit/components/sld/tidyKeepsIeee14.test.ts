/**
 * Tidy diagram leaves no line of IEEE 14 worse off after any of its devices
 * was moved, and gives the lines that went round a device the shorter way
 * back (`holdTidy` in `tests/unit/helpers/tidySweeps.ts`, which says what is
 * moved and what a line is measured by).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { IEEE14 } from '../../helpers/exampleCases';
import { holdTidy } from '../../helpers/tidySweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

holdTidy('IEEE 14', IEEE14, { device: 'generator-2', dx: -160, dy: 0 });
