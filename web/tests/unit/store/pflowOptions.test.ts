import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PFLOW_OPTIONS } from '@/lib/pflowOptions';
import { usePflowOptionsStore } from '@/store/pflowOptions';

beforeEach(() => {
  usePflowOptionsStore.getState().resetOptions();
});

describe('usePflowOptionsStore', () => {
  it('starts at the defaults: nothing set, so the case keeps its own', () => {
    expect(usePflowOptionsStore.getState().options).toEqual(DEFAULT_PFLOW_OPTIONS);
  });

  it('merges a patch into the options and leaves the rest alone', () => {
    usePflowOptionsStore.getState().setOptions({ flatStart: true });
    usePflowOptionsStore.getState().setOptions({ maxIterations: 50 });
    expect(usePflowOptionsStore.getState().options).toEqual({
      tolerance: null,
      maxIterations: 50,
      flatStart: true,
      enforceQLimits: false,
    });
  });

  it('resets to the defaults', () => {
    usePflowOptionsStore.getState().setOptions({ tolerance: 1e-4, enforceQLimits: true });
    usePflowOptionsStore.getState().resetOptions();
    expect(usePflowOptionsStore.getState().options).toEqual(DEFAULT_PFLOW_OPTIONS);
  });
});
