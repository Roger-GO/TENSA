/**
 * UI slice. Tracks ephemeral display preferences that don't belong on
 * any of the other slices (auth/session/case/pflow). v0.2 extends this
 * slice with the panel-picker state per dock region and the
 * ``TdsConfigPanel`` form values (tf, h override, vars, max_rate_hz).
 *
 * Lifecycle: not persisted across sessions. Resets on tab close. Picker
 * defaults match v0.1 behavior (Inspector active in the right-dock top
 * region) so a fresh load reads the same as before v0.2.
 */
import { create } from 'zustand';

/** Identifier for a panel that can mount in the right-dock top region. */
export type RightDockTopPanel =
  | 'inspector'
  | 'disturbance'
  | 'plot'
  | 'tds-config';

export const RIGHT_DOCK_TOP_PANELS: readonly RightDockTopPanel[] = [
  'inspector',
  'disturbance',
  'plot',
  'tds-config',
] as const;

/** Variable group selector forwarded by ``RunStream`` to ``start_tds``. */
export type TdsVarGroup = 'bus_v' | 'gen_state' | 'line_flow';

export const TDS_VAR_GROUPS: readonly TdsVarGroup[] = [
  'bus_v',
  'gen_state',
  'line_flow',
] as const;

/**
 * TdsConfigPanel form values. Defaults match the plan ("TdsConfigPanel
 * defaults"): ``tf=10``, ``h=null`` (substrate auto-pick), ``vars=
 * ["bus_v"]`` (gen_state opt-in), ``max_rate_hz=30`` (the UI-side clamp
 * documented in Key Technical Decisions).
 */
export interface TdsConfig {
  /** Final sim time (seconds). Required. */
  tf: number;
  /** Optional fixed step (seconds). ``null`` → substrate adaptive. */
  h: number | null;
  /** Variable groups to stream. At least one required. */
  vars: readonly TdsVarGroup[];
  /** UI-side output-rate clamp forwarded to the substrate. */
  maxRateHz: number;
}

export const DEFAULT_TDS_CONFIG: TdsConfig = {
  tf: 10,
  h: null,
  vars: ['bus_v'],
  maxRateHz: 30,
};

export interface UiState {
  /**
   * When true, voltage / angle / flow magnitude labels are suppressed on
   * the SLD canvas. Color encoding (limit-band stroke) remains visible.
   */
  hideLabels: boolean;
  setHideLabels: (hide: boolean) => void;
  toggleHideLabels: () => void;

  /**
   * Currently mounted panel in the right-dock top region. Defaults to
   * ``"inspector"`` — matches v0.1 behavior. The PanelPickerTabs
   * component drives this; consumers (App.tsx) read it to decide which
   * panel to render.
   */
  activeRightDockTopPanel: RightDockTopPanel;
  setActiveRightDockTopPanel: (panel: RightDockTopPanel) => void;

  /** TdsConfigPanel form values. Read by ``RunButton`` at start time. */
  tdsConfig: TdsConfig;
  setTdsConfig: (next: Partial<TdsConfig>) => void;
  resetTdsConfig: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  hideLabels: false,
  setHideLabels: (hide: boolean) => set({ hideLabels: hide }),
  toggleHideLabels: () => set((s) => ({ hideLabels: !s.hideLabels })),

  activeRightDockTopPanel: 'inspector',
  setActiveRightDockTopPanel: (panel) =>
    set({ activeRightDockTopPanel: panel }),

  tdsConfig: { ...DEFAULT_TDS_CONFIG },
  setTdsConfig: (next) =>
    set((s) => ({ tdsConfig: { ...s.tdsConfig, ...next } })),
  resetTdsConfig: () => set({ tdsConfig: { ...DEFAULT_TDS_CONFIG } }),
}));

/**
 * Validate a candidate TdsConfig draft. Returns a record of field-keyed
 * error messages; empty record means valid. Exported so the form
 * component and tests can share one source of truth for validity rules.
 */
export function validateTdsConfig(draft: TdsConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Number.isFinite(draft.tf)) {
    out.tf = 'Enter a finite number';
  } else if (draft.tf <= 0) {
    out.tf = 'Must be > 0';
  }
  if (draft.h !== null) {
    if (!Number.isFinite(draft.h)) {
      out.h = 'Enter a finite number or leave blank';
    } else if (draft.h <= 0) {
      out.h = 'Must be > 0';
    }
  }
  if (draft.vars.length === 0) {
    out.vars = 'Select at least one variable group';
  }
  if (!Number.isFinite(draft.maxRateHz)) {
    out.maxRateHz = 'Enter a finite number';
  } else if (draft.maxRateHz <= 0) {
    out.maxRateHz = 'Must be > 0';
  }
  return out;
}
