/**
 * Reloaded case slice: the case a reload of the page interrupted, which the
 * page opens again.
 *
 * A reload starts an empty session (`useSessionRelease` gives the old one back
 * as the page goes), so the page comes up with no case. It used to stay that
 * way, with a note that named the case and a button that reopened it, and a
 * user who had only pressed F5 found their work closed. The page now opens
 * the case again by itself (`useReopenAfterReload`): the file with the dynamic
 * files it was opened with, or a new blank system for one that was built from
 * scratch, and onto it the edits the tab kept (`store/editJournal.ts`). The
 * drafts of the diagram are the browser's and come back with the case.
 *
 * This slice is the mark that says which case that is. It is kept in
 * `sessionStorage`: it belongs to this tab, lives through a reload of it and
 * ends with it. It follows the open case while the page lives (`follow`,
 * called from the cascade in `store/index.ts` on every change of the
 * selection): written when a case is opened or a system started, removed when
 * the user closes the case. So a mark found when the page starts names a case
 * that was open when the page went away. `closed` holds it from then until a
 * case is open again, or until it turns out that it cannot be opened
 * (`forget`).
 *
 * A storage failure (private mode, quota) leaves the page starting empty, as
 * on a first visit, and nothing else changed.
 */
import { create } from 'zustand';
import type { CaseSelection } from './case';

export const OPEN_CASE_STORAGE_KEY = 'tensa:open-case-v1';

/** A case as it is opened from the workspace: its file and its dynamic files. */
export interface CaseOnFile {
  /** Workspace-relative path of the case file. */
  primaryPath: string;
  /** Workspace-relative paths of the dynamic files it was opened with, in load order. */
  addfiles: string[];
}

/** A system that was built from scratch: no file holds it, and the edits kept for it are all of it. */
export interface CaseFromScratch {
  primaryPath: null;
  addfiles: [];
  blank: true;
}

/** What the tab had open: a case file, or a system built from scratch. */
export type OpenCaseMark = CaseOnFile | CaseFromScratch;

/** Whether `mark` is of a case file. */
export function isOnFile(mark: OpenCaseMark): mark is CaseOnFile {
  return mark.primaryPath !== null;
}

function markFrom(value: unknown): OpenCaseMark | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.blank === true && v.primaryPath === null) {
    return { primaryPath: null, addfiles: [], blank: true };
  }
  if (
    typeof v.primaryPath === 'string' &&
    v.primaryPath.length > 0 &&
    Array.isArray(v.addfiles) &&
    v.addfiles.every((a) => typeof a === 'string')
  ) {
    return { primaryPath: v.primaryPath, addfiles: [...(v.addfiles as string[])] };
  }
  return null;
}

/** Read the mark; anything missing or malformed reads as no mark. */
export function readOpenCaseMark(): OpenCaseMark | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(OPEN_CASE_STORAGE_KEY);
    if (raw === null) return null;
    return markFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write the mark, or remove it with `null`. Returns `false` if storage threw. */
export function writeOpenCaseMark(mark: OpenCaseMark | null): boolean {
  try {
    if (typeof sessionStorage === 'undefined') return false;
    if (mark === null) sessionStorage.removeItem(OPEN_CASE_STORAGE_KEY);
    else sessionStorage.setItem(OPEN_CASE_STORAGE_KEY, JSON.stringify(mark));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the drafts of a system built from scratch are kept for a reload of
 * the page (`store/drafts.ts` reads and writes them). They are for the
 * system the reload interrupted and no other, so the key goes here, with
 * the mark, whenever another case is opened or that system cannot be built
 * again: the drafts' own module is fetched with the diagram, and may not be
 * there to see it.
 */
export const BLANK_DRAFTS_STORAGE_KEY = 'tensa:sld-drafts-blank-v1';

function dropBlankDrafts(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(BLANK_DRAFTS_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing was kept there either.
  }
}

export interface ReloadedCaseState {
  /** The case a reload interrupted, until a case is open again; `null` otherwise. */
  closed: OpenCaseMark | null;
  /**
   * Take a change of the open case: keep the mark on what is open now, and
   * drop what the reload interrupted, which a case opened or a system started
   * since has answered.
   */
  follow: (selection: CaseSelection | null) => void;
  /** Drop what the reload interrupted and its mark: it cannot be opened again. */
  forget: () => void;
}

export const useReloadedCaseStore = create<ReloadedCaseState>((set) => ({
  closed: readOpenCaseMark(),
  follow: (selection) => {
    const mark: OpenCaseMark | null =
      selection === null
        ? null
        : selection.primaryPath === null
          ? { primaryPath: null, addfiles: [], blank: true }
          : { primaryPath: selection.primaryPath, addfiles: [...selection.addfiles] };
    writeOpenCaseMark(mark);
    if (mark === null || isOnFile(mark)) dropBlankDrafts();
    set({ closed: null });
  },
  forget: () => {
    writeOpenCaseMark(null);
    dropBlankDrafts();
    set({ closed: null });
  },
}));
