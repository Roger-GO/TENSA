/**
 * Tests for the analyze slice (Unit 6).
 *
 * Coverage:
 * - subMode default + setter.
 * - eigResult set/clear semantics, including the "selection past end
 *   of new result" auto-clear behaviour.
 * - filter defaults + partial setter + reset.
 * - applyEigFilter pure helper (the EIG scatter's source of truth).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANALYZE_SUB_MODES,
  DEFAULT_EIG_FILTER,
  applyEigFilter,
  useAnalyzeStore,
} from '@/store/analyze';
import type { EigResult } from '@/api/types';

function resetAnalyzeStore() {
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
  });
}

const SAMPLE_RESULT: EigResult = {
  eigenvalues: [
    { real: -0.1, imag: 2.0 },
    { real: -0.5, imag: 0.0 },
    { real: -10.0, imag: 1.0 },
    { real: -0.05, imag: -2.0 },
  ],
  damping_ratios: [0.05, 1.0, 0.995, 0.025],
  frequencies_hz: [0.318, 0.0, 0.159, 0.318],
  mode_count: 4,
  state_count: 4,
  state_names: ['delta_1', 'omega_1', 'delta_2', 'omega_2'],
  tds_initialized: true,
};

describe('useAnalyzeStore — subMode (Unit 6 KTD-6)', () => {
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('exposes ANALYZE_SUB_MODES in canonical order', () => {
    expect(ANALYZE_SUB_MODES).toEqual(['pflow', 'tds', 'eig']);
  });

  it('defaults to pflow', () => {
    expect(useAnalyzeStore.getState().subMode).toBe('pflow');
  });

  it('setSubMode swaps the active routine view', () => {
    useAnalyzeStore.getState().setSubMode('eig');
    expect(useAnalyzeStore.getState().subMode).toBe('eig');
    useAnalyzeStore.getState().setSubMode('tds');
    expect(useAnalyzeStore.getState().subMode).toBe('tds');
  });
});

describe('useAnalyzeStore — eigResult', () => {
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('starts null', () => {
    expect(useAnalyzeStore.getState().eigResult).toBeNull();
  });

  it('setEigResult stores the result', () => {
    useAnalyzeStore.getState().setEigResult(SAMPLE_RESULT);
    expect(useAnalyzeStore.getState().eigResult).toEqual(SAMPLE_RESULT);
  });

  it('clearEigResult drops the result and the selection', () => {
    useAnalyzeStore.getState().setEigResult(SAMPLE_RESULT);
    useAnalyzeStore.getState().setSelectedModeId(2);
    useAnalyzeStore.getState().clearEigResult();
    expect(useAnalyzeStore.getState().eigResult).toBeNull();
    expect(useAnalyzeStore.getState().selectedModeId).toBeNull();
  });

  it('setEigResult(null) clears the selection too', () => {
    useAnalyzeStore.getState().setEigResult(SAMPLE_RESULT);
    useAnalyzeStore.getState().setSelectedModeId(1);
    useAnalyzeStore.getState().setEigResult(null);
    expect(useAnalyzeStore.getState().selectedModeId).toBeNull();
  });

  it('setEigResult auto-clears selection past the new mode_count', () => {
    useAnalyzeStore.getState().setEigResult(SAMPLE_RESULT);
    useAnalyzeStore.getState().setSelectedModeId(3);
    // Smaller result — selection of 3 is now past end (mode_count=2).
    const smaller: EigResult = {
      ...SAMPLE_RESULT,
      eigenvalues: SAMPLE_RESULT.eigenvalues.slice(0, 2),
      damping_ratios: SAMPLE_RESULT.damping_ratios.slice(0, 2),
      frequencies_hz: SAMPLE_RESULT.frequencies_hz.slice(0, 2),
      state_names: SAMPLE_RESULT.state_names.slice(0, 2),
      mode_count: 2,
      state_count: 2,
    };
    useAnalyzeStore.getState().setEigResult(smaller);
    expect(useAnalyzeStore.getState().selectedModeId).toBeNull();
  });

  it('setEigResult preserves selection within the new mode_count', () => {
    useAnalyzeStore.getState().setEigResult(SAMPLE_RESULT);
    useAnalyzeStore.getState().setSelectedModeId(1);
    // Same shape: selection within range.
    useAnalyzeStore.getState().setEigResult(SAMPLE_RESULT);
    expect(useAnalyzeStore.getState().selectedModeId).toBe(1);
  });
});

describe('useAnalyzeStore — selectedModeId', () => {
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('starts null', () => {
    expect(useAnalyzeStore.getState().selectedModeId).toBeNull();
  });

  it('setSelectedModeId updates the value', () => {
    useAnalyzeStore.getState().setSelectedModeId(7);
    expect(useAnalyzeStore.getState().selectedModeId).toBe(7);
    useAnalyzeStore.getState().setSelectedModeId(null);
    expect(useAnalyzeStore.getState().selectedModeId).toBeNull();
  });
});

describe('useAnalyzeStore — filter (KTD-7 defaults)', () => {
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('defaults match KTD-7: dampingMax=0.05, realAbsMax=5', () => {
    expect(DEFAULT_EIG_FILTER).toEqual({ dampingMax: 0.05, realAbsMax: 5 });
    expect(useAnalyzeStore.getState().filter).toEqual(DEFAULT_EIG_FILTER);
  });

  it('setFilter merges patches', () => {
    useAnalyzeStore.getState().setFilter({ dampingMax: 0.1 });
    expect(useAnalyzeStore.getState().filter).toEqual({
      dampingMax: 0.1,
      realAbsMax: 5,
    });
  });

  it('resetFilter restores defaults', () => {
    useAnalyzeStore.getState().setFilter({ dampingMax: 0.5, realAbsMax: 100 });
    useAnalyzeStore.getState().resetFilter();
    expect(useAnalyzeStore.getState().filter).toEqual(DEFAULT_EIG_FILTER);
  });
});

describe('applyEigFilter', () => {
  it('keeps modes inside both thresholds', () => {
    const visible = applyEigFilter(SAMPLE_RESULT, DEFAULT_EIG_FILTER);
    // Mode 0: damping=0.05, |Re|=0.1 → kept (boundary inclusive).
    // Mode 1: damping=1.0 → filtered (damping > 0.05).
    // Mode 2: |Re|=10 → filtered (|Re| > 5).
    // Mode 3: damping=0.025, |Re|=0.05 → kept.
    expect(visible).toEqual([0, 3]);
  });

  it('returns empty when thresholds exclude everything', () => {
    const visible = applyEigFilter(SAMPLE_RESULT, {
      dampingMax: 0.001,
      realAbsMax: 0.001,
    });
    expect(visible).toEqual([]);
  });

  it('returns all indices when thresholds are wide', () => {
    const visible = applyEigFilter(SAMPLE_RESULT, {
      dampingMax: 1e6,
      realAbsMax: 1e6,
    });
    expect(visible).toEqual([0, 1, 2, 3]);
  });

  it('handles an empty result', () => {
    const empty: EigResult = {
      eigenvalues: [],
      damping_ratios: [],
      frequencies_hz: [],
      mode_count: 0,
      state_count: 0,
      state_names: [],
      tds_initialized: true,
    };
    expect(applyEigFilter(empty, DEFAULT_EIG_FILTER)).toEqual([]);
  });
});
