/**
 * Units slice. Owns the per-unit / actual-units display preference: whether
 * bus voltage and rotor speed read as pu or as kV and Hz (see
 * ``lib/units.ts`` for what the mode does and does not change).
 *
 * Persistence: ``localStorage``, like the theme. It is a reading preference a
 * user sets once, not a property of a case or a session, so it survives a tab
 * close and is not cleared with the session. A storage failure (private mode,
 * quota) leaves the preference working in memory for the tab.
 */
import { create } from 'zustand';
import { DEFAULT_UNIT_MODE, UNIT_MODES, type UnitMode } from '@/lib/units';

export const UNIT_MODE_STORAGE_KEY = 'tensa:unit-mode';

/** Read the persisted mode; anything missing or unrecognised is the default. */
export function readPersistedUnitMode(): UnitMode {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_UNIT_MODE;
    const raw = localStorage.getItem(UNIT_MODE_STORAGE_KEY);
    return (UNIT_MODES as readonly (string | null)[]).includes(raw)
      ? (raw as UnitMode)
      : DEFAULT_UNIT_MODE;
  } catch {
    return DEFAULT_UNIT_MODE;
  }
}

/** Persist the mode. Returns ``false`` if storage threw. */
export function writePersistedUnitMode(mode: UnitMode): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(UNIT_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export interface UnitsState {
  mode: UnitMode;
  setMode: (mode: UnitMode) => void;
}

export const useUnitsStore = create<UnitsState>((set) => ({
  mode: readPersistedUnitMode(),
  setMode: (mode) => {
    writePersistedUnitMode(mode);
    set({ mode });
  },
}));
