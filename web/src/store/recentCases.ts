/**
 * Recent cases slice. The workspace cases a user opened last, newest first, with
 * the dynamic files each was opened with, so a case that was loaded as a `.raw`
 * plus its `.dyr` comes back as the pair.
 *
 * Persistence: ``localStorage``, like the theme and the units. It is a
 * convenience of this browser and this server's address, not a property of a case
 * or a session, so it survives a tab close and is not cleared with the session or
 * by a case change (the cascade in ``store/index.ts`` does not touch it). A file
 * that has since left the workspace stays in the list until it is pushed out; the
 * sidebar only shows the ones the workspace still holds. A storage failure
 * (private mode, quota) leaves the list working in memory for the tab.
 */
import { create } from 'zustand';

export const RECENT_CASES_STORAGE_KEY = 'tensa:recent-cases';

/** How many cases are remembered. */
export const MAX_RECENT_CASES = 8;

export interface RecentCase {
  /** Workspace-relative path of the case file. A case appears once, whatever it was opened with. */
  primaryPath: string;
  /** Workspace-relative paths of the dynamic files it was last opened with, in load order. */
  addfiles: string[];
  /** When it was last opened, in ms since the epoch. */
  openedAt: number;
}

function isRecentCase(value: unknown): value is RecentCase {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.primaryPath === 'string' &&
    v.primaryPath.length > 0 &&
    Array.isArray(v.addfiles) &&
    v.addfiles.every((a) => typeof a === 'string') &&
    typeof v.openedAt === 'number' &&
    Number.isFinite(v.openedAt)
  );
}

/** Read the persisted list; anything missing, malformed or over the cap is dropped. */
export function readPersistedRecentCases(): RecentCase[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(RECENT_CASES_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentCase).slice(0, MAX_RECENT_CASES);
  } catch {
    return [];
  }
}

/** Persist the list. Returns ``false`` if storage threw. */
export function writePersistedRecentCases(cases: readonly RecentCase[]): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(RECENT_CASES_STORAGE_KEY, JSON.stringify(cases));
    return true;
  } catch {
    return false;
  }
}

export interface RecentCasesState {
  cases: RecentCase[];
  /** Put a case at the top of the list, replacing its earlier entry. */
  record: (primaryPath: string, addfiles: readonly string[]) => void;
}

export const useRecentCasesStore = create<RecentCasesState>((set, get) => ({
  cases: readPersistedRecentCases(),
  record: (primaryPath, addfiles) => {
    const rest = get().cases.filter((c) => c.primaryPath !== primaryPath);
    const cases = [{ primaryPath, addfiles: [...addfiles], openedAt: Date.now() }, ...rest].slice(
      0,
      MAX_RECENT_CASES,
    );
    writePersistedRecentCases(cases);
    set({ cases });
  },
}));
