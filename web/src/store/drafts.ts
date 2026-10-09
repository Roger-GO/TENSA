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
 * page and in a later visit. A case file is known by its workspace and its
 * name (`draftCaseKey`): the server names its workspace folder
 * (`workspaceId` of the session store), so a file of the same name in
 * another workspace served on the same address has drafts of its own. The
 * drafts that were already kept when the page was loaded are from an earlier
 * visit, and the diagram says so once when their case is opened
 * (`takeKept`); not for the case a reload of the page opens again, whose
 * drafts were on screen a moment before. The drafts of a system
 * built from scratch go with the system: no file holds it, so there is
 * nothing to find them under in a later visit. They are kept in the tab's
 * `sessionStorage` (`BLANK_DRAFTS_STORAGE_KEY` in `reloadedCase.ts`), so a reload of the page,
 * which builds the system again, has them again. Once it is saved, the
 * file that was written has them too (`copy`, from the Save system dialog),
 * so they are there when that file is opened. A storage failure (private
 * mode, quota) leaves the drafts working for the tab.
 *
 * `placements` is where an element that a draft was just added as comes to
 * stand, by the id of its node: the canvas draws it there and takes the entry
 * over (`SldCanvas`). In memory only.
 *
 * A draft that is deleted can be put back as it was (`restore`), under the
 * id it had, or under the next free one when a draft placed since has taken
 * that id: the answer says which, for what goes on keeping it by id.
 *
 * `fieldAsked` is a field of a draft that something outside its form wants
 * the cursor in (the Pick a bus button of the notice for a device that was
 * dropped on no bus): the Inspector hands it to the form and clears it.
 *
 * `connect` is how the diagram gives a draft a value: the bus it was dropped
 * on, or the bus the end of its connector was dragged to. A form that is
 * open on the draft holds the values it was opened with, so each such change
 * is counted (`connected`), and the Inspector opens the form afresh on it.
 *
 * `routes` is how the lines ran among the drafts of a case when its diagram
 * was last drawn: the way each line of the system took round them, and the
 * route of each draft that is drawn as a line or a transformer. The layout
 * beside the case holds nothing of a draft, so these are kept here, with the
 * drafts and in the same storage, and the diagram that is opened again is
 * drawn from them: the lines run as they ran, where working them out afresh
 * could send them another way. They are kept by the case and by the system
 * they were drawn for (`systemOf`), since the system of a case that is just
 * being opened is drawn for a moment under the name of the case before it,
 * and what is kept of that picture must not take the place of what was kept
 * for the case itself.
 */
import { create } from 'zustand';
import type { ParamValue } from '@/api/types';
import { useCaseStore } from './case';
import type { CaseSelection } from './case';
import { BLANK_DRAFTS_STORAGE_KEY, readOpenCaseMark, useReloadedCaseStore } from './reloadedCase';
import { useSessionStore } from './session';

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

/** The key the routes kept with the drafts are stored under (`DraftsState.routes`). */
export const DRAFT_ROUTES_STORAGE_KEY = 'tensa:sld-draft-routes-v1';

/**
 * For how many systems one case keeps the routes of its drafts: the system
 * of the case itself, and the ones that were drawn under its name for a
 * moment or that an edit has since replaced.
 */
export const MAX_DRAFT_ROUTE_SYSTEMS = 3;

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

/** A route as it is kept: its points, and where the two buses of its line stood when it was made. */
export interface KeptRoute {
  points: [number, number][];
  anchors: { source: { x: number; y: number }; target: { x: number; y: number } };
}

/** How the lines ran among the drafts of one system when its diagram was last drawn. */
export interface KeptDraftRoutes {
  /** Where the drafts stood then, and what each was connected to (`draftsStand`). */
  stand: string;
  /** The route of each draft that is drawn as a line or a transformer, by edge id. */
  own: Record<string, KeptRoute>;
  /**
   * The way each line of the system took round the drafts, by edge id, with
   * the route the line keeps, in the place of which it was drawn (`from`).
   */
  round: Record<string, KeptRoute & { from: string }>;
}

/**
 * The key the drafts of the case file `path` are kept under: the workspace
 * the server serves and the path in it. Before a server has named its
 * workspace it is the path alone.
 */
export function draftKeyOfPath(path: string): string {
  const workspace = useSessionStore.getState().workspaceId;
  return workspace === null || workspace === '' ? path : `${workspace}:${path}`;
}

/** The key the drafts of the open case are kept under, or `null` with no case open. */
export function draftCaseKey(selection: CaseSelection | null): string | null {
  if (selection === null) return null;
  return selection.primaryPath === null ? BLANK_CASE_KEY : draftKeyOfPath(selection.primaryPath);
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

/** The drafts among `list`, each id once, no more than a case holds. */
function draftsOfList(list: unknown): DraftElement[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list
    .filter((d): d is DraftElement => {
      if (!isDraft(d) || seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    })
    .slice(0, MAX_DRAFTS_PER_CASE);
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
      if (key === BLANK_CASE_KEY) continue;
      const drafts = draftsOfList(list);
      if (drafts.length > 0) out[key] = drafts;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The drafts of a system built from scratch, as the tab kept them for a
 * reload of the page (`BLANK_DRAFTS_STORAGE_KEY`); none when it kept none.
 */
export function readBlankDrafts(): DraftElement[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(BLANK_DRAFTS_STORAGE_KEY);
    return raw === null ? [] : draftsOfList(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Persist the drafts of the cases that are files, and keep those of a system
 * built from scratch for a reload of the page. Returns `false` if storage threw.
 */
export function writePersistedDrafts(byCase: Readonly<Record<string, DraftElement[]>>): boolean {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const blank = byCase[BLANK_CASE_KEY] ?? [];
      if (blank.length === 0) sessionStorage.removeItem(BLANK_DRAFTS_STORAGE_KEY);
      else sessionStorage.setItem(BLANK_DRAFTS_STORAGE_KEY, JSON.stringify(blank));
    }
  } catch {
    // Private mode, or the quota: a reload then rebuilds the system without its drafts.
  }
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

function isPlace(value: unknown): value is { x: number; y: number } {
  if (value === null || typeof value !== 'object') return false;
  const { x, y } = value as Record<string, unknown>;
  return Number.isFinite(x) && Number.isFinite(y);
}

function isKeptRoute(value: unknown): value is KeptRoute {
  if (value === null || typeof value !== 'object') return false;
  const { points, anchors } = value as Record<string, unknown>;
  const at = anchors as Record<string, unknown> | null | undefined;
  return (
    Array.isArray(points) &&
    points.length >= 2 &&
    points.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]),
    ) &&
    at !== null &&
    typeof at === 'object' &&
    isPlace(at.source) &&
    isPlace(at.target)
  );
}

function isKeptDraftRoutes(value: unknown): value is KeptDraftRoutes {
  if (value === null || typeof value !== 'object') return false;
  const { stand, own, round } = value as Record<string, unknown>;
  const routesOf = (held: unknown): unknown[] | null =>
    held !== null && typeof held === 'object' && !Array.isArray(held) ? Object.values(held) : null;
  const [ownRoutes, ways] = [routesOf(own), routesOf(round)];
  return (
    typeof stand === 'string' &&
    ownRoutes !== null &&
    ways !== null &&
    ownRoutes.every(isKeptRoute) &&
    ways.every((way) => isKeptRoute(way) && typeof (way as { from?: unknown }).from === 'string')
  );
}

/** Read the routes kept with the drafts; anything missing or malformed is dropped. */
export function readPersistedDraftRoutes(): Record<string, Record<string, KeptDraftRoutes>> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(DRAFT_ROUTES_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, KeptDraftRoutes>> = {};
    for (const [key, systems] of Object.entries(parsed)) {
      if (key === BLANK_CASE_KEY || systems === null || typeof systems !== 'object') continue;
      const kept = Object.entries(systems as Record<string, unknown>).filter(
        (entry): entry is [string, KeptDraftRoutes] => isKeptDraftRoutes(entry[1]),
      );
      if (kept.length > 0) out[key] = Object.fromEntries(kept.slice(-MAX_DRAFT_ROUTE_SYSTEMS));
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the routes kept with the drafts of the cases that are files. Returns `false` if storage threw. */
export function writePersistedDraftRoutes(
  routes: Readonly<Record<string, Record<string, KeptDraftRoutes>>>,
): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const kept = Object.fromEntries(
      Object.entries(routes).filter(([key]) => key !== BLANK_CASE_KEY),
    );
    if (Object.keys(kept).length === 0) localStorage.removeItem(DRAFT_ROUTES_STORAGE_KEY);
    else localStorage.setItem(DRAFT_ROUTES_STORAGE_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/** The number in the id of a draft; 0 for an id that holds none. */
function draftNumber(id: string): number {
  const n = Number.parseInt(id.slice(DRAFT_ID_PREFIX.length), 10);
  return Number.isFinite(n) ? n : 0;
}

/** The next free id among `drafts`: one more than the highest number in use. */
function nextDraftId(drafts: readonly DraftElement[]): string {
  let highest = 0;
  for (const { id } of drafts) highest = Math.max(highest, draftNumber(id));
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
  /**
   * How many times each draft was given values from the diagram, by its id
   * (`connect`). In memory only.
   */
  connected: Record<string, number>;
  /**
   * Set fields of a draft from the diagram: the bus it was dropped on, or
   * the bus the end of its connector was dragged to. The same as
   * `setValues`, and counted in `connected`: a form that is open on the
   * draft holds values of its own, and reads the draft's again when the
   * count changes.
   */
  connect: (caseKey: string, id: string, patch: Readonly<Record<string, ParamValue>>) => void;
  /** Move drafts: each named in `moves` to its place there. */
  move: (caseKey: string, moves: Readonly<Record<string, { x: number; y: number }>>) => void;
  remove: (caseKey: string, id: string) => void;
  removeAll: (caseKey: string) => void;
  /**
   * Put drafts that were deleted back as they were, each under the id it
   * had, or under the next free one when a draft placed since has that id.
   * One the case has no room for is left out. Answers the ones that are
   * back, as they are back.
   */
  restore: (caseKey: string, drafts: readonly DraftElement[]) => DraftElement[];
  /**
   * The drafts each case had when the page was loaded, by case key and by
   * id: the ones of an earlier visit, until `takeKept` has answered for them.
   */
  kept: Record<string, string[]>;
  /**
   * How many drafts of the case `caseKey` are from an earlier visit and
   * still there. It answers once for a case: the diagram says it when the
   * case is opened, and not again.
   */
  takeKept: (caseKey: string) => number;
  /** The field of a draft the cursor is wanted in, or `null`. In memory only. */
  fieldAsked: { id: string; name: string } | null;
  /** Ask for the cursor in the field `name` of the draft `id`; `null` once it is there. */
  askField: (asked: { id: string; name: string } | null) => void;
  /**
   * Give the case `toKey` the drafts of `fromKey`, in the place of its own:
   * a copy of the system that is saved under another name takes them along,
   * as it takes the layout.
   */
  copy: (fromKey: string, toKey: string) => void;
  /**
   * How the lines ran among the drafts of each case when its diagram was
   * last drawn, by `draftCaseKey` and then by the system that was drawn
   * (`systemOf`), the one drawn last coming last. A case keeps them for
   * `MAX_DRAFT_ROUTE_SYSTEMS` systems, and for none once it has no draft.
   */
  routes: Record<string, Record<string, KeptDraftRoutes>>;
  /**
   * Keep how the lines run among the drafts of the case `caseKey`, drawn as
   * the system `system`: `null` when no line runs another way for a draft
   * and no draft is drawn as a line.
   */
  keepRoutes: (caseKey: string, system: string, kept: KeptDraftRoutes | null) => void;
  /** Keep the place the node `nodeId` takes once the system has its element. */
  place: (nodeId: string, position: { x: number; y: number }) => void;
  /** Let go of the places of `nodeIds`: the canvas has taken them over. */
  forgetPlacements: (nodeIds: readonly string[]) => void;
}

export const useDraftsStore = create<DraftsState>((set, get) => {
  /** Put `systems` in the place of the routes kept for `caseKey`, and write the result. */
  const putRoutes = (caseKey: string, systems: Record<string, KeptDraftRoutes>): void => {
    const routes = { ...get().routes };
    if (Object.keys(systems).length === 0) delete routes[caseKey];
    else routes[caseKey] = systems;
    writePersistedDraftRoutes(routes);
    set({ routes });
  };
  /** Put `drafts` in the place of the drafts of `caseKey`, and write the result. */
  const put = (caseKey: string, drafts: DraftElement[]): void => {
    const byCase = { ...get().byCase };
    if (drafts.length === 0) delete byCase[caseKey];
    else byCase[caseKey] = drafts;
    writePersistedDrafts(byCase);
    set({ byCase });
    // With its last draft gone, no line of the case runs any way for one.
    if (drafts.length === 0 && get().routes[caseKey] !== undefined) putRoutes(caseKey, {});
  };
  const atStart = readPersistedDrafts();
  // The case file this tab had open when the page was reloaded: its drafts
  // were on screen a moment ago, and are not from an earlier visit.
  const mark = readOpenCaseMark();
  const reloaded = mark?.primaryPath ?? null;
  // A system built from scratch that the reload interrupted is built again
  // (`useReopenAfterReload`), and its drafts are there for it.
  if (mark !== null && mark.primaryPath === null) {
    const blank = readBlankDrafts();
    if (blank.length > 0) atStart[BLANK_CASE_KEY] = blank;
  }
  return {
    byCase: atStart,
    kept: Object.fromEntries(
      Object.entries(atStart)
        .filter(([key]) => key !== BLANK_CASE_KEY)
        .map(([key, drafts]) => [key, drafts.map((d) => d.id)]),
    ),
    takeKept: (caseKey) => {
      const { [caseKey]: ids, ...others } = get().kept;
      if (ids === undefined) return 0;
      set({ kept: others });
      if (reloaded !== null && caseKey === draftKeyOfPath(reloaded)) return 0;
      const held = new Set((get().byCase[caseKey] ?? []).map((d) => d.id));
      return ids.filter((id) => held.has(id)).length;
    },
    fieldAsked: null,
    askField: (asked) => set({ fieldAsked: asked }),
    placements: {},
    connected: {},
    routes: readPersistedDraftRoutes(),
    keepRoutes: (caseKey, system, kept) => {
      const { [system]: held, ...others } = get().routes[caseKey] ?? {};
      if (kept === null) {
        if (held !== undefined) putRoutes(caseKey, others);
        return;
      }
      // The same again for the system that was drawn last: nothing to write.
      const last = Object.keys(get().routes[caseKey] ?? {}).at(-1);
      if (last === system && JSON.stringify(held) === JSON.stringify(kept)) return;
      const systems = [...Object.entries(others), [system, kept] as const];
      putRoutes(caseKey, Object.fromEntries(systems.slice(-MAX_DRAFT_ROUTE_SYSTEMS)));
    },
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
    connect: (caseKey, id, patch) => {
      if (!(get().byCase[caseKey] ?? []).some((d) => d.id === id)) return;
      get().setValues(caseKey, id, patch);
      set((s) => ({ connected: { ...s.connected, [id]: (s.connected[id] ?? 0) + 1 } }));
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
    restore: (caseKey, drafts) => {
      const held = get().byCase[caseKey] ?? [];
      const taken = new Set(held.map((d) => d.id));
      const back: DraftElement[] = [];
      for (const draft of drafts) {
        if (held.length + back.length >= MAX_DRAFTS_PER_CASE) break;
        const id = taken.has(draft.id) ? nextDraftId([...held, ...back]) : draft.id;
        taken.add(id);
        back.push({ ...draft, id, position: { ...draft.position }, values: { ...draft.values } });
      }
      if (back.length === 0) return back;
      // In the order they were placed, which is the order of their numbers.
      put(
        caseKey,
        [...held, ...back].sort((a, b) => draftNumber(a.id) - draftNumber(b.id)),
      );
      return back;
    },
    copy: (fromKey, toKey) => {
      if (fromKey === toKey) return;
      const held = get().byCase[fromKey] ?? [];
      if (held.length === 0 && (get().byCase[toKey] ?? []).length === 0) return;
      put(
        toKey,
        held.map((d) => ({ ...d, position: { ...d.position }, values: { ...d.values } })),
      );
      // The copy is drawn as this diagram is, so its lines run as these do.
      const routes = get().routes[fromKey];
      if (held.length > 0 && (routes !== undefined || get().routes[toKey] !== undefined)) {
        putRoutes(toKey, { ...routes });
      }
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
  // Also when a case file is opened with none before it: the drafts a reload
  // kept for a system built from scratch are not for another case.
  const blankNow = state.selection !== null && state.selection.primaryPath === null;
  if ((was !== null && was.primaryPath === null) || !blankNow) store.removeAll(BLANK_CASE_KEY);
  if (Object.keys(store.placements).length > 0) useDraftsStore.setState({ placements: {} });
  // A draft goes by a number that the drafts of the next case have as well.
  if (Object.keys(store.connected).length > 0) useDraftsStore.setState({ connected: {} });
});

// The system a reload interrupted could not be built again (`forget`): the
// drafts that were kept for it are of no other system.
useReloadedCaseStore.subscribe((state, before) => {
  const interrupted = before.closed !== null && before.closed.primaryPath === null;
  if (interrupted && state.closed === null && useCaseStore.getState().selection === null) {
    useDraftsStore.getState().removeAll(BLANK_CASE_KEY);
  }
});
