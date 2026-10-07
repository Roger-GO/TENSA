/**
 * Tidy diagram, off the main thread.
 *
 * Routing every line of a large diagram takes about a second, in which a
 * page that did the work itself could not answer a click. This worker does
 * it instead: it is sent what `planTidy` takes and answers with its plan,
 * and `tidyClient.ts` ends it when the plan is no longer wanted.
 */
import { planTidy } from './tidyPlan';

type PlanArguments = Parameters<typeof planTidy>;

self.onmessage = (event: MessageEvent<PlanArguments>) => {
  self.postMessage(planTidy(...event.data));
};
