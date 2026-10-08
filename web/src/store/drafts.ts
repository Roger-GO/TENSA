/**
 * Drafts slice: the elements that were placed on the diagram and are not in
 * the system yet.
 *
 * A component dragged from the palette onto the diagram is a draft from the
 * moment it is dropped: it stands where it was dropped, drawn dashed, and
 * holds the parameters it was given so far (`values`: the fields that were
 * set, every other field being what the form of its kind opens with). It
 * reaches the server only when it is added to the system, which the
 * Inspector offers once nothing required is missing (`DraftInspector`).
 * Until then it is this browser's alone.
 *
 * Persistence: `localStorage`, by the case file the drafts were made on, so
 * they are there again when the case is opened again: after a reload of the
 * page, which closes the case, and in a later visit. The drafts of a system
 * built from scratch are kept in memory only and go with the system: no file
 * holds it, so there is nothing to find them under. Once it is saved, the
 * file that was written has them too (`copy`, from the Save system dialog),
 * so they are there when that file is opened. A storage failure (private
 * mode, quota) leaves the drafts working for the tab.
 *
 * `placements` is where an element that a draft was just added as comes to
 * stand, by the id of its node: the canvas draws it there and takes the entry
 * over (`SldCanvas`). In memory only.
 */
import { create } from 'zustand';
import type { ParamValue } from '@/api/types';
import { useCaseStore } from './case';
import type { CaseSelection } from './case';

export const DRAFTS_STORAGE_KEY = 'tensa:sld-drafts-v1';

/** The key the drafts of a system built from scratch are kept under. A colon is in no workspace path. */
export const BLANK_CASE_KEY = ':blank';

/** How many drafts one case keeps: a guard for the storage, far more than a diagram has room for. */
export const MAX_DRAFTS_PER_CASE = 200;

/**
 * The box a draft is drawn in on the diagram. It is the same for every kind
 * and is set on the node, so where a draft may stand is known before it is
 * drawn. Both sides are a whole number of steps of the grid the nodes snap to
 * (6 by 4 of `GRID_STEP`, written out so that keeping a draft does not load
 * the diagram), so a draft on the grid has the middle of each face on a grid
 * line.
 */
export const DRAFT_NODE_SIZE = { width: 96, height: 64 } as const;

/** The prefix of a draft's id, which is also the id of its node on the diagram. */
export const DRAFT_ID_PREFIX = 'draft-';

export interface DraftElement {
  /** `draft-<n>`; the id of its node on the diagram as well. */
  id: string;
  /** What it is a draft of: a `value` of `ELEMENT_KINDS`. */
  kind: string;
  /** Where it stands on the diagram: the top left corner of its symbol. */
  position: { x: number; y: number };
  /** The fields that were set, by name. */
  values: Record<string, ParamValue>;
}

/** The key the drafts of the open case are kept under, or `null` with no case open. */
export function draftCaseKey(selection: CaseSelection | null): string | null {
  if (selection === null) return null;
  return selection.primaryPath ?? BLANK_CASE_KEY;
}

function isParamValue(value: unknown): value is ParamValue {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function isDraft(value: unknown): value is DraftElement {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const at = v.position as Record<string, unknown> | null | undefined;
  const held = v.values as Record<string, unknown> | null | undefined;
  return (
    typeof v.id === 'string' &&
    v.id.startsWith(DRAFT_ID_PREFIX) &&
    typeof v.kind === 'string' &&
    v.kind.length > 0 &&
    at !== null &&
    typeof at === 'object' &&
    Number.isFinite(at.x) &&
    Number.isFinite(at.y) &&
    held !== null &&
    typeof held === 'object' &&
    !Array.isArray(held) &&
    Object.values(held).every(isParamValue)
  );
}

/** Read the persisted drafts; anything missing, malformed or over the cap is dropped. */
export function readPersistedDrafts(): Record<string, DraftElement[]> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, DraftElement[]> = {};
    for (const [key, list] of Object.entries(parsed)) {
      if (key === BLANK_CASE_KEY || !Array.isArray(list)) continue;
      const seen = new Set<string>();
      const drafts = list.filter((d): d is DraftElement => {
        if (!isDraft(d) || seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      });
      if (drafts.length > 0) out[key] = drafts.slice(0, MAX_DRAFTS_PER_CASE);
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the drafts of the cases that are files. Returns `false` if storage threw. */
export function writePersistedDrafts(byCase: Readonly<Record<string, DraftElement[]>>): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const kept = Object.fromEntries(
      Object.entries(byCase).filter(([key, list]) => key !== BLANK_CASE_KEY && list.length > 0),
    );
    if (Object.keys(kept).length === 0) localStorage.removeItem(DRAFTS_STORAGE_KEY);
    else localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/** The next free id among `drafts`: one more than the highest number in use. */
function nextDraftId(drafts: readonly DraftElement[]): string {
  let highest = 0;
  for (const { id } of drafts) {
    const n = Number.parseInt(id.slice(DRAFT_ID_PREFIX.length), 10);
    if (Number.isFinite(n)) highest = Math.max(highest, n);
  }
  return `${DRAFT_ID_PREFIX}${highest + 1}`;
}

const NO_DRAFTS: readonly DraftElement[] = [];

export interface DraftsState {
  /** The drafts of each case, by `draftCaseKey`, in the order they were placed. */
  byCase: Record<string, DraftElement[]>;
  /** Where an element just added from a draft comes to stand, by the id of its node. */
  placements: Record<string, { x: number; y: number }>;
  /**
   * Place a draft of `kind` on the diagram of the case `caseKey`. Answers
   * the draft, or `null` when the case holds as many as it may.
   */
  add: (
    caseKey: string,
    kind: string,
    position: { x: number; y: number },
    values?: Record<string, ParamValue>,
  ) => DraftElement | null;
  /** Set fields of a draft, each to its value; `null` for one that is no longer set. */
  setValues: (
    caseKey: string,
    id: string,
    patch: Readonly<Record<string, ParamValue | null>>,
  ) => void;
  /** Move drafts: each named in `moves` to its place there. */
  move: (caseKey: string, moves: Readonly<Record<string, { x: number; y: number }>>) => void;
  remove: (caseKey: string, id: string) => void;
  removeAll: (caseKey: string) => void;
  /**
   * Give the case `toKey` the drafts of `fromKey`, in the place of its own:
   * a copy of the system that is saved under another name takes them along,
   * as it takes the layout.
   */
  copy: (fromKey: string, toKey: string) => void;
  /** Keep the place the node `nodeId` takes once the system has its element. */
  place: (nodeId: string, position: { x: number; y: number }) => void;
  /** Let go of the places of `nodeIds`: the canvas has taken them over. */
  forgetPlacements: (nodeIds: readonly string[]) => void;
}

export const useDraftsStore = create<DraftsState>((set, get) => {
  /** Put `drafts` in the place of the drafts of `caseKey`, and write the result. */
  const put = (caseKey: string, drafts: DraftElement[]): void => {
    const byCase = { ...get().byCase };
    if (drafts.length === 0) delete byCase[caseKey];
    else byCase[caseKey] = drafts;
    writePersistedDrafts(byCase);
    set({ byCase });
  };
  return {
    byCase: readPersistedDrafts(),
    placements: {},
    add: (caseKey, kind, position, values = {}) => {
      const held = get().byCase[caseKey] ?? [];
      if (held.length >= MAX_DRAFTS_PER_CASE) return null;
      const draft: DraftElement = {
        id: nextDraftId(held),
        kind,
        position: { x: position.x, y: position.y },
        values: { ...values },
      };
      put(caseKey, [...held, draft]);
      return draft;
    },
    setValues: (caseKey, id, patch) => {
      const held = get().byCase[caseKey] ?? [];
      if (!held.some((d) => d.id === id)) return;
      put(
        caseKey,
        held.map((d) => {
          if (d.id !== id) return d;
          const values = { ...d.values };
          for (const [name, value] of Object.entries(patch)) {
            if (value === null) delete values[name];
            else values[name] = value;
          }
          return { ...d, values };
        }),
      );
    },
    move: (caseKey, moves) => {
      const held = get().byCase[caseKey] ?? [];
      let changed = false;
      const next = held.map((d) => {
        const to = moves[d.id];
        if (to === undefined || (to.x === d.position.x && to.y === d.position.y)) return d;
        changed = true;
        return { ...d, position: { x: to.x, y: to.y } };
      });
      if (changed) put(caseKey, next);
    },
    remove: (caseKey, id) => {
      const held = get().byCase[caseKey] ?? [];
      if (held.some((d) => d.id === id)) {
        put(
          caseKey,
          held.filter((d) => d.id !== id),
        );
      }
    },
    removeAll: (caseKey) => {
      if ((get().byCase[caseKey] ?? []).length > 0) put(caseKey, []);
    },
    copy: (fromKey, toKey) => {
      if (fromKey === toKey) return;
      const held = get().byCase[fromKey] ?? [];
      if (held.length === 0 && (get().byCase[toKey] ?? []).length === 0) return;
      put(
        toKey,
        held.map((d) => ({ ...d, position: { ...d.position }, values: { ...d.values } })),
      );
    },
    place: (nodeId, position) =>
      set((s) => ({
        placements: { ...s.placements, [nodeId]: { x: position.x, y: position.y } },
      })),
    forgetPlacements: (nodeIds) =>
      set((s) => {
        if (!nodeIds.some((id) => id in s.placements)) return s;
        const placements = { ...s.placements };
        for (const id of nodeIds) delete placements[id];
        return { placements };
      }),
  };
});

/** The drafts of the case `caseKey`; the same empty list for a case with none. */
export function draftsOf(
  byCase: Readonly<Record<string, DraftElement[]>>,
  caseKey: string | null,
): readonly DraftElement[] {
  return (caseKey === null ? undefined : byCase[caseKey]) ?? NO_DRAFTS;
}

/** The drafts of the open case, in the order they were placed. */
export function useDrafts(): readonly DraftElement[] {
  const caseKey = useCaseStore((s) => draftCaseKey(s.selection));
  return useDraftsStore((s) => draftsOf(s.byCase, caseKey));
}

// The drafts of a system built from scratch are that system's: they go when
// another case takes its place, or none. So do the places kept for elements
// that were just added: they name nodes of the diagram that is gone. Wired
// here, as the diagram's own selection wires its reset (`store/sld.ts`), so it
// holds wherever the store is in use.
let wiredSelection: CaseSelection | null = useCaseStore.getState().selection;
useCaseStore.subscribe((state) => {
  if (state.selection === wiredSelection) return;
  const was = wiredSelection;
  wiredSelection = state.selection;
  const store = useDraftsStore.getState();
  if (was !== null && was.primaryPath === null) store.removeAll(BLANK_CASE_KEY);
  if (Object.keys(store.placements).length > 0) useDraftsStore.setState({ placements: {} });
});
