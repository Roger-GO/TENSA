import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PFLOW_OPTIONS } from '@/lib/pflowOptions';
import { usePflowOptionsStore } from '@/store/pflowOptions';

beforeEach(() => {
  usePflowOptionsStore.getState().resetForNewCase();
});

describe('usePflowOptionsStore', () => {
  it('starts at the defaults: nothing set, so the case keeps its own', () => {
    expect(usePflowOptionsStore.getState().options).toEqual(DEFAULT_PFLOW_OPTIONS);
    expect(usePflowOptionsStore.getState().caseSettings).toEqual({
      flatStart: null,
      enforceQLimits: null,
    });
  });

  it('merges a patch into the options and leaves the rest alone', () => {
    usePflowOptionsStore.getState().setOptions({ flatStart: true });
    usePflowOptionsStore.getState().setOptions({ maxIterations: 50 });
    expect(usePflowOptionsStore.getState().options).toEqual({
      tolerance: null,
      maxIterations: 50,
      flatStart: true,
      enforceQLimits: null,
    });
  });

  it('resets to the defaults', () => {
    usePflowOptionsStore.getState().setOptions({ tolerance: 1e-4, enforceQLimits: true });
    usePflowOptionsStore.getState().resetOptions();
    expect(usePflowOptionsStore.getState().options).toEqual(DEFAULT_PFLOW_OPTIONS);
  });

  it('keeps what a run showed about the case through a reset of the options', () => {
    usePflowOptionsStore.getState().noteCaseSettings({ enforceQLimits: true });
    usePflowOptionsStore.getState().noteCaseSettings({ flatStart: false });
    usePflowOptionsStore.getState().setOptions({ enforceQLimits: false });

    usePflowOptionsStore.getState().resetOptions();

    expect(usePflowOptionsStore.getState().options).toEqual(DEFAULT_PFLOW_OPTIONS);
    expect(usePflowOptionsStore.getState().caseSettings).toEqual({
      flatStart: false,
      enforceQLimits: true,
    });
  });

  it('forgets both the options and what was learned when another case opens', () => {
    usePflowOptionsStore.getState().noteCaseSettings({ enforceQLimits: true });
    usePflowOptionsStore.getState().setOptions({ tolerance: 1e-4 });

    usePflowOptionsStore.getState().resetForNewCase();

    expect(usePflowOptionsStore.getState().options).toEqual(DEFAULT_PFLOW_OPTIONS);
    expect(usePflowOptionsStore.getState().caseSettings).toEqual({
      flatStart: null,
      enforceQLimits: null,
    });
  });
});
