/**
 * Reloaded case slice: the case file a reload of the page closed.
 *
 * A reload starts an empty session (`useSessionRelease` gives the old one back
 * as the page goes), so the page comes up with no case. Nothing said so: the
 * left sidebar and the diagram read "No case loaded" as they do on a first
 * visit, and the case had to be found again among the saved ones. This slice
 * remembers which file the tab had open, so the page can say that the reload
 * closed it and reopen it in one click (`ReloadedCaseNote`).
 *
 * The mark is kept in `sessionStorage`: it belongs to this tab, lives through a
 * reload of it and ends with it. It follows the open case while the page lives
 * (`follow`, called from the cascade in `store/index.ts` on every change of the
 * selection): written when a case file is opened, removed when the user closes
 * the case or builds a system from scratch, which no file holds. So a mark
 * found when the page starts names a case that was open when the page went
 * away. `closed` holds it from then until a case is open again.
 *
 * A storage failure (private mode, quota) leaves the page without the note and
 * nothing else changed.
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

function isCaseOnFile(value: unknown): value is CaseOnFile {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.primaryPath === 'string' &&
    v.primaryPath.length > 0 &&
    Array.isArray(v.addfiles) &&
    v.addfiles.every((a) => typeof a === 'string')
  );
}

/** Read the mark; anything missing or malformed reads as no mark. */
export function readOpenCaseMark(): CaseOnFile | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(OPEN_CASE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isCaseOnFile(parsed)) return null;
    return { primaryPath: parsed.primaryPath, addfiles: [...parsed.addfiles] };
  } catch {
    return null;
  }
}

/** Write the mark, or remove it with `null`. Returns `false` if storage threw. */
export function writeOpenCaseMark(mark: CaseOnFile | null): boolean {
  try {
    if (typeof sessionStorage === 'undefined') return false;
    if (mark === null) sessionStorage.removeItem(OPEN_CASE_STORAGE_KEY);
    else sessionStorage.setItem(OPEN_CASE_STORAGE_KEY, JSON.stringify(mark));
    return true;
  } catch {
    return false;
  }
}

export interface ReloadedCaseState {
  /** The case file a reload closed, until a case is open again; `null` otherwise. */
  closed: CaseOnFile | null;
  /**
   * Take a change of the open case: keep the mark on the file that is open now,
   * and drop what the reload closed, which a case opened or a system started
   * since has answered.
   */
  follow: (selection: CaseSelection | null) => void;
  /** Drop what the reload closed and its mark: the workspace no longer holds the file. */
  forget: () => void;
}

export const useReloadedCaseStore = create<ReloadedCaseState>((set) => ({
  closed: readOpenCaseMark(),
  follow: (selection) => {
    const onFile =
      selection !== null && selection.blank !== true && selection.primaryPath !== null
        ? { primaryPath: selection.primaryPath, addfiles: [...selection.addfiles] }
        : null;
    writeOpenCaseMark(onFile);
    set({ closed: null });
  },
  forget: () => {
    writeOpenCaseMark(null);
    set({ closed: null });
  },
}));
