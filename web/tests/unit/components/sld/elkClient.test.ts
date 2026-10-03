/**
 * elkClient — the SLD's ELK engine lives in a Web Worker, not on the
 * calling thread.
 *
 * jsdom has no `Worker`, so the Vite `?worker` import is replaced by a
 * scripted fake that speaks the same message protocol `elk-api` uses
 * (`{cmd, id, ...}` in, `{id, data | error}` out). The real `elk-api`
 * client runs on top of it, so what is verified is the wiring: layouts go
 * to the worker as messages, one worker serves every call, and a worker
 * that dies fails the layout instead of hanging it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';

interface Posted {
  cmd: string;
  id: number;
  graph?: ElkNode;
}

const fake = vi.hoisted(() => {
  type Listener = (event: { message?: string }) => void;
  const state = {
    instances: [] as FakeWorker[],
    /** Construction fails this many more times (a CSP or a quota refusing the worker). */
    failConstruction: 0,
    /** Answer `layout` messages by echoing the graph. Off to leave them pending. */
    autoReply: true,
  };
  class FakeWorker {
    onmessage: ((answer: { data: unknown }) => void) | null = null;
    readonly options: unknown;
    readonly posted: Posted[] = [];
    terminated = false;
    private readonly listeners = new Map<string, Listener[]>();

    constructor(options?: unknown) {
      if (state.failConstruction > 0) {
        state.failConstruction -= 1;
        throw new Error('worker refused');
      }
      this.options = options;
      state.instances.push(this);
    }

    addEventListener(type: string, listener: Listener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    emit(type: string, event: { message?: string }): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    postMessage(msg: Posted): void {
      this.posted.push(msg);
      if (msg.cmd === 'register') {
        this.reply({ id: msg.id });
      } else if (msg.cmd === 'layout' && state.autoReply) {
        this.reply({ id: msg.id, data: { ...msg.graph, laidOutBy: 'worker' } });
      }
    }

    reply(answer: { id: number; data?: unknown; error?: unknown }): void {
      this.onmessage?.({ data: answer });
    }

    terminate(): void {
      this.terminated = true;
    }
  }
  return { state, FakeWorker };
});

vi.mock('elkjs/lib/elk-worker.min.js?worker', () => ({ default: fake.FakeWorker }));

const graph: ElkNode = { id: 'root', children: [{ id: '1', width: 60, height: 40 }] };

/** A fresh module, so each test starts without the previous test's worker. */
async function freshElkLayout() {
  vi.resetModules();
  return (await import('@/components/sld/elkClient')).elkLayout;
}

/** Layout messages the worker has received, across all of its instances. */
function layoutMessages(worker: InstanceType<typeof fake.FakeWorker>): Posted[] {
  return worker.posted.filter((m) => m.cmd === 'layout');
}

beforeEach(() => {
  fake.state.instances.length = 0;
  fake.state.failConstruction = 0;
  fake.state.autoReply = true;
});

describe('elkLayout', () => {
  it('sends the graph to a worker and resolves with the worker reply', async () => {
    const elkLayout = await freshElkLayout();
    const result = await elkLayout(graph);
    expect(fake.state.instances).toHaveLength(1);
    const worker = fake.state.instances[0];
    expect(worker?.options).toEqual({ name: 'elk-layout' });
    expect(layoutMessages(worker!).map((m) => m.graph)).toEqual([graph]);
    expect(result).toMatchObject({ id: 'root', laidOutBy: 'worker' });
  });

  it('constructs no worker until the first layout', async () => {
    await freshElkLayout();
    expect(fake.state.instances).toHaveLength(0);
  });

  it('serves every layout from the same worker', async () => {
    const elkLayout = await freshElkLayout();
    await Promise.all([elkLayout(graph), elkLayout(graph)]);
    await elkLayout(graph);
    expect(fake.state.instances).toHaveLength(1);
    expect(layoutMessages(fake.state.instances[0]!)).toHaveLength(3);
  });

  it('rejects, and keeps the worker, when ELK rejects the graph', async () => {
    fake.state.autoReply = false;
    const elkLayout = await freshElkLayout();
    const pending = elkLayout(graph);
    await vi.waitFor(() => expect(layoutMessages(fake.state.instances[0]!)).toHaveLength(1));
    const [message] = layoutMessages(fake.state.instances[0]!);
    fake.state.instances[0]!.reply({ id: message!.id, error: { message: 'bad graph' } });
    await expect(pending).rejects.toMatchObject({ message: 'bad graph' });

    fake.state.autoReply = true;
    await expect(elkLayout(graph)).resolves.toMatchObject({ laidOutBy: 'worker' });
    expect(fake.state.instances).toHaveLength(1);
    expect(fake.state.instances[0]?.terminated).toBe(false);
  });

  it('rejects a layout in flight when the worker dies, then starts a new worker', async () => {
    fake.state.autoReply = false;
    const elkLayout = await freshElkLayout();
    const pending = elkLayout(graph);
    await vi.waitFor(() => expect(layoutMessages(fake.state.instances[0]!)).toHaveLength(1));
    fake.state.instances[0]!.emit('error', { message: 'Failed to load script' });
    await expect(pending).rejects.toThrow('ELK worker failed: Failed to load script');
    expect(fake.state.instances[0]?.terminated).toBe(true);

    fake.state.autoReply = true;
    await expect(elkLayout(graph)).resolves.toMatchObject({ laidOutBy: 'worker' });
    expect(fake.state.instances).toHaveLength(2);
  });

  it('starts a new worker for the next layout when one dies while idle', async () => {
    const elkLayout = await freshElkLayout();
    await elkLayout(graph);
    fake.state.instances[0]!.emit('error', {});
    // Let any unhandled rejection from the dead worker surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(elkLayout(graph)).resolves.toMatchObject({ laidOutBy: 'worker' });
    expect(fake.state.instances).toHaveLength(2);
    expect(fake.state.instances[0]?.terminated).toBe(true);
    expect(fake.state.instances[1]?.terminated).toBe(false);
  });

  it('rejects when the worker cannot be created, and tries again on the next call', async () => {
    fake.state.failConstruction = 1;
    const elkLayout = await freshElkLayout();
    await expect(elkLayout(graph)).rejects.toThrow('worker refused');
    expect(fake.state.instances).toHaveLength(0);

    await expect(elkLayout(graph)).resolves.toMatchObject({ laidOutBy: 'worker' });
    expect(fake.state.instances).toHaveLength(1);
  });
});
