/**
 * Tidy diagram for a diagram of any size: within the call for a small one,
 * and in a Web Worker for a large one, so that the page keeps answering
 * while the lines of a hundred buses are routed and the work can be called
 * off.
 *
 * `startTidy` answers a job. A small diagram is planned before it returns
 * (`plan` is set, and `done` has it as well); a large one is planned by
 * `tidy.worker.ts`, `done` settles when the worker answers, and `cancel`
 * ends the worker, after which `done` never settles. Where no worker can be
 * made (a test under jsdom, a page whose policy forbids workers), or one
 * cannot be sent the diagram, the plan is made within the call whatever
 * the size.
 */
import type { Edge, Node } from '@xyflow/react';
import type { TopologySummary } from '@/api/types';
import { planTidy, type TidyPlan, type TidyPlanOptions } from './tidyPlan';

/**
 * The most branches a diagram is tidied with within the call that asked for
 * it, which takes a few hundredths of a second. With more the work goes to
 * the worker: routing them takes long enough to notice, up to about a
 * second on a large diagram, where it stops (`TIDY_STEPS` in `tidy.ts`).
 */
export const TIDY_AT_ONCE = 30;

export interface TidyJob {
  /** The plan, for a diagram that was planned within the call. */
  plan?: TidyPlan;
  /** Settles with the plan; rejects when the worker fails. */
  done: Promise<TidyPlan>;
  /** Call the work off. `done` does not settle afterwards. */
  cancel: () => void;
}

/** Plan a tidy of `graph` (see `planTidy`), off the main thread when the diagram is large. */
export function startTidy(
  graph: { nodes: Node[]; edges: Edge[] },
  topology: TopologySummary,
  options: TidyPlanOptions,
): TidyJob {
  const withinTheCall = (): TidyJob => {
    const plan = planTidy(graph, topology, options);
    return { plan, done: Promise.resolve(plan), cancel: () => {} };
  };
  const branches = graph.edges.filter((edge) => edge.type !== 'stub').length;
  const worker = branches > TIDY_AT_ONCE ? startWorker() : null;
  if (worker === null) return withinTheCall();
  let cancelled = false;
  const done = new Promise<TidyPlan>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<TidyPlan>) => {
      worker.terminate();
      if (!cancelled) resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      if (!cancelled) reject(new Error(event.message || 'The tidy worker failed'));
    };
  });
  try {
    worker.postMessage([graph, topology, options]);
  } catch {
    // Something in the diagram cannot be copied to a worker: the plan is
    // made here, as for a small diagram, and the page waits for it.
    cancelled = true;
    worker.terminate();
    return withinTheCall();
  }
  return {
    done,
    cancel: () => {
      cancelled = true;
      worker.terminate();
    },
  };
}

/** A worker for one tidy; `null` where none can be made. */
function startWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./tidy.worker.ts', import.meta.url), {
      type: 'module',
      name: 'sld-tidy',
    });
  } catch {
    return null;
  }
}
