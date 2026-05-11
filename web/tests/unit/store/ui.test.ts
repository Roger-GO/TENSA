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

  it('defaults match the plan: tf=10, h=null, vars=["bus_v"], max_rate_hz=30', () => {
    expect(DEFAULT_TDS_CONFIG).toEqual({
      tf: 10,
      h: null,
      vars: ['bus_v'],
      maxRateHz: 30,
    });
    expect(useUiStore.getState().tdsConfig).toEqual(DEFAULT_TDS_CONFIG);
  });

  it('exposes TDS_VAR_GROUPS in canonical order', () => {
    expect(TDS_VAR_GROUPS).toEqual(['bus_v', 'gen_state', 'line_flow']);
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
