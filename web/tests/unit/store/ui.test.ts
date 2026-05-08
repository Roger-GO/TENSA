/**
 * Tests for the `ui` slice (HideLabels preference).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useUiStore } from '@/store/ui';

describe('useUiStore', () => {
  afterEach(() => {
    useUiStore.setState({ hideLabels: false });
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
