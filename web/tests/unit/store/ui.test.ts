/**
 * Tests for the `ui` slice.
 *
 * v0.1: HideLabels preference.
 * v0.2 (Unit 8): TdsConfigPanel form values + the ``validateTdsConfig``
 * helper. (The panel-picker field ``activeRightDockTopPanel`` was
 * retired in v3 Unit 15 — the layout slice now owns dock state.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TDS_CONFIG,
  MAX_TDS_DAE_VARS,
  TDS_VAR_GROUPS,
  useUiStore,
  validateTdsConfig,
} from '@/store/ui';
import type { TdsConfig } from '@/store/ui';

function resetUiStore() {
  useUiStore.setState({
    hideLabels: false,
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
  });
}

describe('useUiStore — hideLabels (v0.1 surface)', () => {
  afterEach(() => {
    resetUiStore();
  });

  it('defaults to hideLabels=false', () => {
    expect(useUiStore.getState().hideLabels).toBe(false);
  });

  it('setHideLabels(true) flips the flag', () => {
    useUiStore.getState().setHideLabels(true);
    expect(useUiStore.getState().hideLabels).toBe(true);
  });

  it('toggleHideLabels alternates the flag', () => {
    expect(useUiStore.getState().hideLabels).toBe(false);
    useUiStore.getState().toggleHideLabels();
    expect(useUiStore.getState().hideLabels).toBe(true);
    useUiStore.getState().toggleHideLabels();
    expect(useUiStore.getState().hideLabels).toBe(false);
  });
});

describe('useUiStore — TDS config (v0.2 Unit 8)', () => {
  afterEach(() => {
    resetUiStore();
  });

  it('defaults: tf=10, h=null, vars=["bus_v","gen_state"] (voltage + freq), no ANDES variables, no controllers, max_rate_hz=30', () => {
    expect(DEFAULT_TDS_CONFIG).toEqual({
      tf: 10,
      h: null,
      vars: ['bus_v', 'gen_state'],
      daeVars: [],
      controllers: [],
      maxRateHz: 30,
    });
    expect(useUiStore.getState().tdsConfig).toEqual(DEFAULT_TDS_CONFIG);
    expect(useUiStore.getState().tdsControllerResults).toBeNull();
  });

  it("keeps a run's controller results until the list of controllers changes", () => {
    const entry = {
      spec: {
        type: 'droop' as const,
        model: 'ESD1',
        idx: 1,
        frequency: 'coi' as const,
        period: 0.1,
        t_start: 0,
        ramp: null,
        gain: 50,
        deadband: 0,
        p_max: null,
      },
      record: ['Pext ESD1 1'],
    };
    const result = {
      type: 'droop' as const,
      model: 'ESD1',
      idx: 1,
      samples: 10,
      first_action_t: 1.1,
      released_t: null,
      peak_command: 5,
      final_command: 4,
    };
    useUiStore.getState().setTdsConfig({ controllers: [entry] });
    useUiStore.getState().setTdsControllerResults([result]);

    // Another setting of the run leaves them.
    useUiStore.getState().setTdsConfig({ tf: 20 });
    expect(useUiStore.getState().tdsControllerResults).toEqual([result]);

    // The results line up with the list by position, so a changed list drops them.
    useUiStore.getState().setTdsConfig({ controllers: [entry, entry] });
    expect(useUiStore.getState().tdsControllerResults).toBeNull();

    useUiStore.getState().setTdsControllerResults([result, result]);
    useUiStore.getState().resetTdsConfig();
    expect(useUiStore.getState().tdsConfig.controllers).toEqual([]);
    expect(useUiStore.getState().tdsControllerResults).toBeNull();
  });

  it('exposes TDS_VAR_GROUPS in canonical order with the new power/load groups', () => {
    expect(TDS_VAR_GROUPS).toEqual(['bus_v', 'gen_state', 'gen_power', 'line_flow', 'load_pq']);
  });

  it('setTdsConfig merges patches without losing other fields', () => {
    useUiStore.getState().setTdsConfig({ tf: 20 });
    expect(useUiStore.getState().tdsConfig.tf).toBe(20);
    // other fields unchanged
    expect(useUiStore.getState().tdsConfig.maxRateHz).toBe(30);
    useUiStore.getState().setTdsConfig({ vars: ['bus_v', 'gen_state'] });
    expect(useUiStore.getState().tdsConfig.vars).toEqual(['bus_v', 'gen_state']);
    expect(useUiStore.getState().tdsConfig.tf).toBe(20);
  });

  it('resetTdsConfig restores the defaults', () => {
    useUiStore.getState().setTdsConfig({ tf: 99, h: 0.001, maxRateHz: 60 });
    useUiStore.getState().resetTdsConfig();
    expect(useUiStore.getState().tdsConfig).toEqual(DEFAULT_TDS_CONFIG);
  });
});

describe('validateTdsConfig', () => {
  const valid = (overrides: Partial<TdsConfig> = {}): TdsConfig => ({
    ...DEFAULT_TDS_CONFIG,
    ...overrides,
  });

  it('accepts the default config', () => {
    expect(validateTdsConfig(valid())).toEqual({});
  });

  it('rejects tf <= 0', () => {
    expect(validateTdsConfig(valid({ tf: 0 }))).toHaveProperty('tf');
    expect(validateTdsConfig(valid({ tf: -1 }))).toHaveProperty('tf');
  });

  it('rejects non-finite tf', () => {
    expect(validateTdsConfig(valid({ tf: Number.NaN }))).toHaveProperty('tf');
    expect(validateTdsConfig(valid({ tf: Number.POSITIVE_INFINITY }))).toHaveProperty('tf');
  });

  it('accepts h=null (substrate adaptive) but rejects h <= 0', () => {
    expect(validateTdsConfig(valid({ h: null }))).not.toHaveProperty('h');
    expect(validateTdsConfig(valid({ h: 0 }))).toHaveProperty('h');
    expect(validateTdsConfig(valid({ h: -0.01 }))).toHaveProperty('h');
  });

  it('accepts up to the substrate limit of ANDES variables and rejects more', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `omega GENROU ${i}`);
    expect(validateTdsConfig(valid({ daeVars: names(MAX_TDS_DAE_VARS) }))).toEqual({});
    expect(validateTdsConfig(valid({ daeVars: names(MAX_TDS_DAE_VARS + 1) }))).toHaveProperty(
      'daeVars',
    );
  });

  it('rejects empty vars list', () => {
    expect(validateTdsConfig(valid({ vars: [] }))).toHaveProperty('vars');
  });

  it('rejects max_rate_hz <= 0 or non-finite', () => {
    expect(validateTdsConfig(valid({ maxRateHz: 0 }))).toHaveProperty('maxRateHz');
    expect(validateTdsConfig(valid({ maxRateHz: Number.NaN }))).toHaveProperty('maxRateHz');
  });

  it('accumulates multiple field errors in one pass', () => {
    const errors = validateTdsConfig(valid({ tf: 0, vars: [], maxRateHz: -1 }));
    expect(errors).toHaveProperty('tf');
    expect(errors).toHaveProperty('vars');
    expect(errors).toHaveProperty('maxRateHz');
  });
});
