/**
 * Power-flow history slice. Keeps the last converged power flows, each with the
 * names its elements had, so two of them can be set side by side (the Compare
 * tab, ``PflowComparePanel``). The pflow slice holds only the latest result,
 * which the next run replaces.
 *
 * A result is recorded when a power flow converges (``useRunPflow``). The
 * operating point read back after a time-domain run is not one: it is the end
 * state of that run, not a solved power flow.
 *
 * Which two are compared: B is the result picked, or the latest when none is,
 * so the comparison follows each new run; A, the reference, is the result
 * picked, or the one before B. Picking the latest as B means "the latest", not
 * that particular run (``setCompared`` takes ``null`` for it).
 *
 * Retention: ``MAX_PFLOW_SNAPSHOTS`` results. A newer one pushes out the oldest
 * that has no name and is not the reference, the way the run history treats a
 * named run.
 *
 * Lifecycle: like the finished time-domain runs (``store/runs.ts``), the
 * results stay across a case change (comparing a case with a modified copy is
 * the point), across a lost session and across a reload of the page
 * (``store/resultsPersistence.ts`` keeps them in the browser and ``restore``
 * puts them back), and go when the session is discarded.
 */
import { create } from 'zustand';
import type { PflowResult } from '@/api/types';
import type { ElementNames } from '@/lib/elementNames';

/** How many results are kept. */
export const MAX_PFLOW_SNAPSHOTS = 10;

export interface PflowSnapshot {
  /** The run id the substrate gave the power flow. */
  id: string;
  /** Which power flow of the history this is: 1 for the first, counting up. */
  ordinal: number;
  /** When it was solved, in ms since the epoch. */
  takenAt: number;
  /** The case it was solved on: the file's name without extension, or "New system". */
  caseName: string;
  /** A name the user gave it ("Base case"). */
  name?: string;
  result: PflowResult;
  names: ElementNames;
}

/** What a result is recorded with besides the result itself. */
export interface PflowSnapshotContext {
  caseName: string;
  names: ElementNames;
}

/** The results and the picks, without the actions: what ``restore`` puts back. */
export interface PflowHistoryPayload {
  snapshots: readonly PflowSnapshot[];
  count: number;
  baselineId: string | null;
  comparedId: string | null;
}

export interface PflowHistoryState extends PflowHistoryPayload {
  /** Oldest first. */
  snapshots: readonly PflowSnapshot[];
  /**
   * How many results have been recorded since the history was last cleared. The
   * next one is numbered one more, so a number is not reused after a result is
   * dropped.
   */
  count: number;
  /** The reference (A) the user picked, or ``null`` for the result before B. */
  baselineId: string | null;
  /** The result (B) the user picked, or ``null`` for the latest. */
  comparedId: string | null;

  /** Keep a converged result. One that did not converge is ignored. */
  record: (result: PflowResult, context: PflowSnapshotContext) => void;
  /** Name a result; an empty name puts its default label back. */
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  /** Drop every result and start numbering again. */
  clear: () => void;
  setBaseline: (id: string | null) => void;
  setCompared: (id: string | null) => void;
  /**
   * Put back results kept from before a reload. They go in front of whatever
   * has been recorded since, and a result already there wins over its copy.
   */
  restore: (payload: PflowHistoryPayload) => void;
}

/** Drop from the front until the cap holds, sparing named results and the reference. */
function applyCap(snapshots: readonly PflowSnapshot[], baselineId: string | null): PflowSnapshot[] {
  const kept = [...snapshots];
  while (kept.length > MAX_PFLOW_SNAPSHOTS) {
    // The newest is never the one to go: it is what was just solved.
    const candidates = kept.slice(0, -1);
    const spare =
      candidates.find((s) => s.name === undefined && s.id !== baselineId) ??
      candidates.find((s) => s.id !== baselineId) ??
      candidates[0]!;
    kept.splice(kept.indexOf(spare), 1);
  }
  return kept;
}

/** A picked id that no longer names a kept result is a pick no more. */
function reconcile(snapshots: readonly PflowSnapshot[], id: string | null): string | null {
  return id !== null && snapshots.some((s) => s.id === id) ? id : null;
}

export const usePflowHistoryStore = create<PflowHistoryState>((set, get) => ({
  snapshots: [],
  count: 0,
  baselineId: null,
  comparedId: null,

  record: (result, { caseName, names }) => {
    if (!result.converged) return;
    const count = get().count + 1;
    const snapshot: PflowSnapshot = {
      id: result.run_id,
      ordinal: count,
      takenAt: Date.now(),
      caseName,
      result,
      names,
    };
    const snapshots = applyCap(
      [...get().snapshots.filter((s) => s.id !== snapshot.id), snapshot],
      get().baselineId,
    );
    set({
      snapshots,
      count,
      baselineId: reconcile(snapshots, get().baselineId),
      comparedId: reconcile(snapshots, get().comparedId),
    });
  },

  rename: (id, name) => {
    const trimmed = name.trim();
    const next = trimmed.length === 0 ? undefined : trimmed;
    const current = get().snapshots.find((s) => s.id === id);
    if (current === undefined || current.name === next) return;
    set({
      snapshots: get().snapshots.map((s) => {
        if (s.id !== id) return s;
        const renamed: PflowSnapshot = { ...s };
        if (next === undefined) delete renamed.name;
        else renamed.name = next;
        return renamed;
      }),
    });
  },

  remove: (id) => {
    const snapshots = get().snapshots.filter((s) => s.id !== id);
    if (snapshots.length === get().snapshots.length) return;
    set({
      snapshots,
      baselineId: reconcile(snapshots, get().baselineId),
      comparedId: reconcile(snapshots, get().comparedId),
    });
  },

  clear: () => set({ snapshots: [], count: 0, baselineId: null, comparedId: null }),

  setBaseline: (id) => set({ baselineId: reconcile(get().snapshots, id) }),

  setCompared: (id) => {
    const { snapshots } = get();
    const latest = snapshots[snapshots.length - 1];
    // The latest result, picked, is "the latest": the comparison goes on
    // following new runs.
    set({ comparedId: id !== null && id === latest?.id ? null : reconcile(snapshots, id) });
  },

  restore: (payload) => {
    const current = get();
    const have = new Set(current.snapshots.map((s) => s.id));
    const restored = payload.snapshots.filter((s) => !have.has(s.id));
    const baselineId = current.baselineId ?? payload.baselineId;
    const snapshots = applyCap([...restored, ...current.snapshots], baselineId);
    const highest = snapshots.reduce((max, s) => Math.max(max, s.ordinal), 0);
    set({
      snapshots,
      count: Math.max(current.count, payload.count, highest),
      baselineId: reconcile(snapshots, baselineId),
      comparedId: reconcile(snapshots, current.comparedId ?? payload.comparedId),
    });
  },
}));

/** The label a result goes by: the user's name for it, else "PF #3". */
export function snapshotLabel(snapshot: Pick<PflowSnapshot, 'ordinal' | 'name'>): string {
  return snapshot.name ?? `PF #${snapshot.ordinal}`;
}

/** The two results to compare: A, the reference, and B. Either is ``null`` when there is none. */
export function resolveComparePair(
  state: Pick<PflowHistoryPayload, 'snapshots' | 'baselineId' | 'comparedId'>,
): { a: PflowSnapshot | null; b: PflowSnapshot | null } {
  const { snapshots, baselineId, comparedId } = state;
  const b = snapshots.find((s) => s.id === comparedId) ?? snapshots[snapshots.length - 1] ?? null;
  if (b === null) return { a: null, b: null };
  const picked = snapshots.find((s) => s.id === baselineId) ?? null;
  if (picked !== null && picked.id !== b.id) return { a: picked, b };
  // The result before B, or the one after it when B is the oldest kept.
  const at = snapshots.indexOf(b);
  return { a: snapshots[at - 1] ?? snapshots[at + 1] ?? null, b };
}
