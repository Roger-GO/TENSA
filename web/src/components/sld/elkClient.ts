/**
 * ELK engine for the SLD auto-layout, running in a Web Worker.
 *
 * ELK's layered algorithm is 1.5 MB of GWT-compiled JavaScript, and a
 * layout takes tens of milliseconds on IEEE 14 and about a second on the
 * 179-bus WECC case. `elkjs/lib/elk.bundled.js` runs all of that on the
 * main thread, in the main chunk: it blocks input while a layout runs, and
 * every visitor downloads and parses it before the first paint. This
 * module loads only the thin `elk-api` client in the main chunk and hands
 * the engine to a worker, so the engine ships as its own asset, is fetched
 * when the first layout starts, and the UI stays responsive while ELK works.
 *
 * Failure policy: `elk-api` never rejects when the worker itself dies (a
 * script that fails to load, a CSP that forbids workers, a crash), so a
 * layout would hang and the canvas would sit on its skeleton forever. The
 * engine watches the worker's `error` event and rejects every layout in
 * flight with it; `layout.ts` turns the rejection into its grid fallback,
 * and the next call builds a fresh worker.
 */
import ELK from 'elkjs/lib/elk-api';
import type { ElkNode } from 'elkjs/lib/elk-api';
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';

interface Engine {
  elk: InstanceType<typeof ELK>;
  /** Rejects once the worker has died. Only observed through `elkLayout`'s race. */
  dead: Promise<never>;
  isDead: () => boolean;
}

/** Created on the first layout and kept for the page's life (one worker). */
let engine: Engine | null = null;

function createEngine(): Engine {
  let died = false;
  let kill: (reason: Error) => void = () => {};
  const dead = new Promise<never>((_, reject) => {
    kill = reject;
  });
  // A worker that dies while nothing is laying out must not surface as an
  // unhandled rejection; `elkLayout` still sees the rejection through the race.
  dead.catch(() => {});
  const elk = new ELK({
    workerFactory: () => {
      const worker = new ElkWorker({ name: 'elk-layout' });
      worker.addEventListener('error', (event) => {
        died = true;
        kill(new Error(`ELK worker failed${event.message ? `: ${event.message}` : ''}`));
      });
      return worker;
    },
  });
  return { elk, dead, isDead: () => died };
}

function discard(dropped: Engine): void {
  if (engine === dropped) engine = null;
  try {
    dropped.elk.terminateWorker();
  } catch {
    // The worker is already gone; there is nothing left to stop.
  }
}

/**
 * Lay out `graph` on the ELK worker. Rejects if ELK rejects the graph, and
 * also if the worker cannot be created or dies; in the second case the
 * worker is dropped so the next call starts a new one.
 */
export async function elkLayout(graph: ElkNode): Promise<ElkNode> {
  // A worker that died while idle must not fail the next layout as well.
  if (engine?.isDead()) discard(engine);
  const current = (engine ??= createEngine());
  try {
    return await Promise.race([current.elk.layout(graph), current.dead]);
  } catch (err) {
    if (current.isDead()) discard(current);
    throw err;
  }
}
