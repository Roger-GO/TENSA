/**
 * The name a run goes by in the legend, the plot and the history list.
 *
 * A run's id is a server-assigned hash, which tells a researcher nothing when
 * three runs are overlaid. The default label says which run it was and what it
 * did to the system, "TDS #3 - fault bus 7", and a name the researcher typed
 * into the legend chip replaces it.
 */
import type { DisturbanceSpec } from '@/api/types';
import { disturbanceTime } from '@/store/disturbance';
import type { RunRecord } from '@/store/runs';

/** The fields of a run the label is made from. */
export type RunLabelFields = Pick<RunRecord, 'runId' | 'ordinal' | 'scenario' | 'displayName'>;

/** First characters of a run id, for a run that has no number to go by. */
export function shortRunId(runId: string, length = 8): string {
  return runId.length > length ? runId.slice(0, length) : runId;
}

function idxText(idx: unknown): string {
  const text = String(idx);
  return text.length === 0 ? '?' : text;
}

function describeOne(spec: DisturbanceSpec): string {
  if (spec.kind === 'fault') return `fault bus ${idxText(spec.bus_idx)}`;
  if (spec.kind === 'toggle') return `toggle ${spec.model} ${idxText(spec.dev_idx)}`;
  return `alter ${spec.model} ${idxText(spec.dev_idx)}`;
}

/**
 * What a run did to the system, in a few words: the earliest scheduled
 * disturbance, and how many more there were. ``undefined`` when nothing was
 * scheduled (a run that only lets the case's own events play out).
 */
export function describeScenario(specs: readonly DisturbanceSpec[]): string | undefined {
  if (specs.length === 0) return undefined;
  // Sorting is stable, so two disturbances at one time keep their order.
  const first = [...specs].sort((a, b) => disturbanceTime(a) - disturbanceTime(b))[0]!;
  const head = describeOne(first);
  return specs.length === 1 ? head : `${head} +${specs.length - 1} more`;
}

/**
 * The default label: "TDS #3 - fault bus 7", or "TDS #3" for a run that
 * scheduled nothing. A record with no number (one that never went through
 * ``startRun``) falls back to the first characters of its id.
 */
export function autoRunLabel(run: Pick<RunLabelFields, 'runId' | 'ordinal' | 'scenario'>): string {
  if (run.ordinal === undefined) return shortRunId(run.runId);
  const head = `TDS #${run.ordinal}`;
  return run.scenario === undefined ? head : `${head} - ${run.scenario}`;
}

/** The label to show for a run: the researcher's name for it, else the default. */
export function runLabel(run: RunLabelFields): string {
  return run.displayName ?? autoRunLabel(run);
}
