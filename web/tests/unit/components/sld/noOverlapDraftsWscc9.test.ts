/**
 * Nothing on the diagram of WSCC 9, with its machines and without them (the
 * network an earlier TENSA seeded), is drawn over anything else with drafts on
 * it: wherever one is dropped, when it is given a bus from its form, drawn
 * as a branch, dragged, and tidied with the rest (`holdDrafts` in
 * `tests/unit/helpers/draftSweeps.ts`, which says how each state is made).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { WSCC9, WSCC9_NETWORK } from '../../helpers/exampleCases';
import { holdDrafts } from '../../helpers/draftSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

// Dragged onto the longest run of a line, a draft sends no line of the case with its
// machines round it (the units stand where the lines would have to go); the network alone does.
holdDrafts('WSCC 9', WSCC9, { linesGoRound: false });
holdDrafts('WSCC 9, the network alone,', WSCC9_NETWORK);
