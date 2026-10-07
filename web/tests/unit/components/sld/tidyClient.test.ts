/**
 * Tidy diagram within the call for a small diagram and in a worker for a
 * large one (`tidyClient.ts`), and the worker itself (`tidy.worker.ts`).
 *
 * jsdom has no `Worker`. A stand-in records what it is sent and lets a test
 * answer, fail or never answer, which is all the client sees of a real one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import { buildGraph, defaultBarLengths } from '@/components/sld/graph';
import { TIDY_AT_ONCE, startTidy } from '@/components/sld/tidyClient';
import { planTidy, type TidyPlan } from '@/components/sld/tidyPlan';

function entry(idx: string | number, kind: string, params: TopologyEntry['params']): TopologyEntry {
  return { idx, name: `${kind} ${idx}`, kind, params };
}

/** A chain of `buses` buses, each joined to the next by a line, with a load on the last. */
function chain(buses: number): TopologySummary {
  const idx = Array.from({ length: buses }, (_, i) => i + 1);
  return {
    state: 'pre-setup',
    buses: idx.map((i) => entry(i, 'Bus', {})),
    lines: idx.slice(1).map((i) => entry(`L${i}`, 'Line', { bus1: i - 1, bus2: i })),
    transformers: [],
    generators: [],
    loads: [entry('PQ', 'PQ', { bus: buses })],
    shunts: [],
    controllers: [],
  };
}

/** `topology` drawn with its buses in a row of four to a line. */
function drawn(topology: TopologySummary) {
  const coords = Object.fromEntries(
    topology.buses.map((bus, i) => [
      String(bus.idx),
      { x: 240 * (i % 4), y: 160 * Math.floor(i / 4) },
    ]),
  );
  const barLengths = defaultBarLengths(topology);
  return { graph: buildGraph(topology, coords, { barLengths }), barLengths };
}

class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<TidyPlan>) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: unknown[] = [];
  terminated = 0;
  constructor(
    readonly url: URL,
    readonly options: { type?: string; name?: string },
  ) {
    FakeWorker.made.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated += 1;
  }
}

/** Whether `promise` has settled by the time the pending microtasks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return done;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.made = [];
});

describe('startTidy', () => {
  it('plans a small diagram within the call', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const topology = chain(4);
    const { graph, barLengths } = drawn(topology);
    const job = startTidy(graph, topology, { relayout: false, barLengths });
    expect(FakeWorker.made).toHaveLength(0);
    expect(job.plan).toBeDefined();
    expect(job.plan!.tidied.unrouted).toEqual([]);
    expect(job.plan!.tidied.routes.size).toBe(3);
    await expect(job.done).resolves.toBe(job.plan);
    // Nothing to call off: it is done.
    expect(() => job.cancel()).not.toThrow();
  });

  it('sends a large diagram to a worker, and answers with the plan the worker makes', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const topology = chain(TIDY_AT_ONCE + 2);
    const { graph, barLengths } = drawn(topology);
    const options = { relayout: true, barLengths };

    const job = startTidy(graph, topology, options);

    expect(job.plan).toBeUndefined();
    const [worker] = FakeWorker.made;
    expect(FakeWorker.made).toHaveLength(1);
    expect(worker!.url.pathname).toMatch(/\/tidy\.worker\.ts$/);
    expect(worker!.options).toEqual({ type: 'module', name: 'sld-tidy' });
    expect(worker!.posted).toEqual([[graph, topology, options]]);
    expect(await settled(job.done)).toBe(false);

    const plan = planTidy(graph, topology, options);
    worker!.onmessage!({ data: plan } as MessageEvent<TidyPlan>);
    await expect(job.done).resolves.toBe(plan);
    // The worker is for one tidy, and ended once it has answered.
    expect(worker!.terminated).toBe(1);
  });

  it('ends the worker when the tidy is called off, and never answers after that', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const topology = chain(TIDY_AT_ONCE + 2);
    const { graph, barLengths } = drawn(topology);
    const job = startTidy(graph, topology, { relayout: false, barLengths });
    const [worker] = FakeWorker.made;

    job.cancel();
    expect(worker!.terminated).toBe(1);
    // An answer that was already on its way changes nothing.
    worker!.onmessage!({ data: {} } as MessageEvent<TidyPlan>);
    worker!.onerror!({ message: 'late' });
    expect(await settled(job.done)).toBe(false);
  });

  it('rejects when the worker fails, with what it said', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const topology = chain(TIDY_AT_ONCE + 2);
    const { graph, barLengths } = drawn(topology);
    const job = startTidy(graph, topology, { relayout: false, barLengths });
    FakeWorker.made[0]!.onerror!({ message: 'out of memory' });
    await expect(job.done).rejects.toThrow('out of memory');
    expect(FakeWorker.made[0]!.terminated).toBe(1);

    const silent = startTidy(graph, topology, { relayout: false, barLengths });
    FakeWorker.made[1]!.onerror!({ message: '' });
    await expect(silent.done).rejects.toThrow('The tidy worker failed');
  });

  it('plans a large diagram within the call where no worker can be made', async () => {
    const topology = chain(TIDY_AT_ONCE + 2);
    const { graph, barLengths } = drawn(topology);
    // No `Worker` at all, as under jsdom.
    const without = startTidy(graph, topology, { relayout: false, barLengths });
    expect(without.plan?.tidied.routes.size).toBe(TIDY_AT_ONCE + 1);

    // And one that the page's policy refuses.
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('refused by the content security policy');
        }
      },
    );
    const refused = startTidy(graph, topology, { relayout: false, barLengths });
    expect(refused.plan?.tidied.routes.size).toBe(TIDY_AT_ONCE + 1);
    await expect(refused.done).resolves.toBe(refused.plan);
  });

  it('plans within the call when the diagram cannot be sent to the worker, and ends the worker', async () => {
    class Unsendable extends FakeWorker {
      override postMessage(): void {
        throw new DOMException('could not be cloned', 'DataCloneError');
      }
    }
    vi.stubGlobal('Worker', Unsendable);
    const topology = chain(TIDY_AT_ONCE + 2);
    const { graph, barLengths } = drawn(topology);
    const job = startTidy(graph, topology, { relayout: false, barLengths });
    expect(job.plan?.tidied.routes.size).toBe(TIDY_AT_ONCE + 1);
    await expect(job.done).resolves.toBe(job.plan);
    expect(FakeWorker.made[0]!.terminated).toBe(1);
  });
});

describe('the tidy worker', () => {
  it('answers what it is sent with the plan for it, which can cross to the page', async () => {
    const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {});
    await import('@/components/sld/tidy.worker');
    const topology = chain(5);
    const { graph, barLengths } = drawn(topology);
    const options = { relayout: true, barLengths };
    // What the page sends is copied on its way in, and the plan on its way out.
    const sent = structuredClone([graph, topology, options]);

    self.onmessage!(new MessageEvent('message', { data: sent }));

    expect(post).toHaveBeenCalledTimes(1);
    const plan = post.mock.calls[0]![0] as TidyPlan;
    const expected = planTidy(graph, topology, options);
    expect(plan.tidied.routes).toEqual(expected.tidied.routes);
    expect(plan.nodes.map((n) => n.position)).toEqual(expected.nodes.map((n) => n.position));
    const copy = structuredClone(plan);
    expect(copy.tidied.routes).toEqual(expected.tidied.routes);
    expect(copy.nodes.map((n) => n.id)).toEqual(expected.nodes.map((n) => n.id));
    post.mockRestore();
    self.onmessage = null;
  });
});
