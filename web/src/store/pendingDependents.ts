/**
 * Helper hook for SLD node components to check whether a topology entry
 * is currently flagged as a pending dependent of an in-flight delete.
 *
 * Lives next to the case store (the source of truth for
 * ``pendingDependents``) so the SLD nodes don't need to know about the
 * full case-store API surface — they just ask "am I a pending
 * dependent?" and render a warning ring accordingly.
 *
 * Match keys are ``model`` (the ANDES class name carried on the node
 * data, e.g. "Bus" / "Line" / "PV") + ``idx`` (stringified). This is the
 * same shape the substrate's ``DeleteBlockedResponse`` ships back, so
 * the comparison is direct — no inspector-taxonomy mapping needed.
 */
import { useCaseStore } from './case';

export function useIsPendingDependent(model: string, idx: string): boolean {
  return useCaseStore((s) =>
    s.pendingDependents.some((d) => d.kind === model && String(d.idx) === idx),
  );
}
