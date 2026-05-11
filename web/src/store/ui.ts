/**
 * UI slice. Tracks ephemeral display preferences that don't belong on
 * any of the other slices (auth/session/case/pflow). v0.2 extended this
 * slice with the ``TdsConfigPanel`` form values (tf, h override, vars,
 * max_rate_hz). v3 Unit 15 retired the ``activeRightDockTopPanel``
 * field — the layout slice (``useLayoutStore``) now owns dock state
 * via ``activeBottomDrawerTab`` + ``activeAnalysisSubTab``.
 *
 * Lifecycle:
 * - Display prefs (``hideLabels``) reset on tab close.
 * - The TDS-integrator pick (``tdsIntegrator`` + ``tdsToleranceOverrides``)
 *   is persisted to ``sessionStorage`` so a refresh during a study
 *   doesn't reset to "trapezoidal" — Unit 16 KTD per-tab persistence.
 *   The rest of ``tdsConfig`` (tf/h/vars/maxRateHz) intentionally stays
 *   in memory only; those are run-by-run choices.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** Variable group selector forwarded by ``RunStream`` to ``start_tds``. */
export type TdsVarGroup = 'bus_v' | 'gen_state' | 'line_flow';

export const TDS_VAR_GROUPS: readonly TdsVarGroup[] = ['bus_v', 'gen_state', 'line_flow'] as const;

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

/**
 * Integrator preset (Unit 16). The substrate accepts the wire values
 * ``"trapezoidal"`` and ``"qndf"``; the ``-auto`` / ``-manual`` suffix is
 * a UI distinction so the form knows whether to expose the tolerance
 * inputs. The Auto preset injects ``rtol=1e-3, atol=1e-6, max_step=0.05``
 * (per the plan's KTD-16); Manual surfaces the same fields as
 * user-editable.
 */
export type TdsIntegrator = 'trapezoidal' | 'qndf-auto' | 'qndf-manual';

export const TDS_INTEGRATORS: readonly TdsIntegrator[] = [
  'trapezoidal',
  'qndf-auto',
  'qndf-manual',
] as const;

/**
 * QNDF tolerance / max-step overrides forwarded to the substrate as
 * ``tds_config_overrides`` on the wire. ``rtol`` / ``atol`` map to
 * ANDES's ``reltol`` / ``abstol``; ``maxStep`` maps to ``dtmax`` (the
 * ANDES field name is ``dtmax``, NOT ``h_max``).
 */
export interface TdsToleranceOverrides {
  rtol: number;
  atol: number;
  maxStep: number;
}

/** Auto-preset values per the plan's KTD-16. */
export const DEFAULT_TDS_TOLERANCE_OVERRIDES: TdsToleranceOverrides = {
  rtol: 1e-3,
  atol: 1e-6,
  maxStep: 0.05,
};

export const DEFAULT_TDS_INTEGRATOR: TdsIntegrator = 'trapezoidal';

export interface UiState {
  /**
   * When true, voltage / angle / flow magnitude labels are suppressed on
   * the SLD canvas. Color encoding (limit-band stroke) remains visible.
   */
  hideLabels: boolean;
  setHideLabels: (hide: boolean) => void;
  toggleHideLabels: () => void;

  /** TdsConfigPanel form values. Read by ``RunButton`` at start time. */
  tdsConfig: TdsConfig;
  setTdsConfig: (next: Partial<TdsConfig>) => void;
  resetTdsConfig: () => void;

  /**
   * Unit 16 integrator preset. Persisted to sessionStorage so the
   * choice survives a refresh mid-study.
   */
  tdsIntegrator: TdsIntegrator;
  setTdsIntegrator: (next: TdsIntegrator) => void;

  /**
   * Unit 16 tolerance overrides. Used in both Auto (read-only) and
   * Manual (editable) modes so switching back-and-forth preserves the
   * user's last-edited values rather than snapping to the defaults.
   */
  tdsToleranceOverrides: TdsToleranceOverrides;
  setTdsToleranceOverrides: (next: Partial<TdsToleranceOverrides>) => void;
  resetTdsToleranceOverrides: () => void;
}

/**
 * The unpersisted slice (display prefs, run-by-run TdsConfig). Wrapped
 * in ``persist`` below so only the integrator + overrides land in
 * sessionStorage — the rest stays in memory.
 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      hideLabels: false,
      setHideLabels: (hide: boolean) => set({ hideLabels: hide }),
      toggleHideLabels: () => set((s) => ({ hideLabels: !s.hideLabels })),

      tdsConfig: { ...DEFAULT_TDS_CONFIG },
      setTdsConfig: (next) => set((s) => ({ tdsConfig: { ...s.tdsConfig, ...next } })),
      resetTdsConfig: () => set({ tdsConfig: { ...DEFAULT_TDS_CONFIG } }),

      tdsIntegrator: DEFAULT_TDS_INTEGRATOR,
      setTdsIntegrator: (next) => set({ tdsIntegrator: next }),

      tdsToleranceOverrides: { ...DEFAULT_TDS_TOLERANCE_OVERRIDES },
      setTdsToleranceOverrides: (next) =>
        set((s) => ({
          tdsToleranceOverrides: { ...s.tdsToleranceOverrides, ...next },
        })),
      resetTdsToleranceOverrides: () =>
        set({ tdsToleranceOverrides: { ...DEFAULT_TDS_TOLERANCE_OVERRIDES } }),
    }),
    {
      name: 'andes-ui-tds-integrator',
      storage: createJSONStorage(() => sessionStorage),
      // Persist ONLY the integrator pick + tolerance overrides per Unit
      // 16 KTD — the rest of the UI slice stays in-memory so display
      // prefs don't accidentally leak across tabs/reloads.
      partialize: (state) => ({
        tdsIntegrator: state.tdsIntegrator,
        tdsToleranceOverrides: state.tdsToleranceOverrides,
      }),
      // v3 Unit 15 cleanup: ``activeRightDockTopPanel`` was never in
      // ``partialize`` so it shouldn't be on disk, but migrate
      // defensively in case any branch ever wrote one. Drops the key
      // and leaves the rest of the payload alone.
      migrate: (persisted) => {
        if (persisted && typeof persisted === 'object') {
          const { activeRightDockTopPanel: _drop, ...rest } = persisted as Record<string, unknown>;
          return rest;
        }
        return persisted;
      },
    },
  ),
);

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

/**
 * Validate the QNDF tolerance / max-step overrides (Unit 16, Manual
 * preset only). Returns a record of field-keyed error messages; empty
 * record means valid. The Auto preset is hidden behind the radio choice
 * and never exposes these inputs, so this validator is only consulted
 * for Manual mode.
 */
export function validateTdsToleranceOverrides(
  draft: TdsToleranceOverrides,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Number.isFinite(draft.rtol)) {
    out.rtol = 'Enter a finite number';
  } else if (draft.rtol <= 0) {
    out.rtol = 'Must be > 0';
  }
  if (!Number.isFinite(draft.atol)) {
    out.atol = 'Enter a finite number';
  } else if (draft.atol <= 0) {
    out.atol = 'Must be > 0';
  }
  if (!Number.isFinite(draft.maxStep)) {
    out.maxStep = 'Enter a finite number';
  } else if (draft.maxStep <= 0) {
    out.maxStep = 'Must be > 0';
  }
  return out;
}
