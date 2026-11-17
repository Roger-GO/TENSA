import { beforeEach, describe, expect, it } from 'vitest';
import { useExampleCasesStore } from '@/store/exampleCases';

describe('the Example cases dialog flag', () => {
  beforeEach(() => useExampleCasesStore.setState({ dialogOpen: false }));

  it('starts closed, opens and closes', () => {
    expect(useExampleCasesStore.getState().dialogOpen).toBe(false);
    useExampleCasesStore.getState().openDialog();
    expect(useExampleCasesStore.getState().dialogOpen).toBe(true);
    useExampleCasesStore.getState().closeDialog();
    expect(useExampleCasesStore.getState().dialogOpen).toBe(false);
  });
});
