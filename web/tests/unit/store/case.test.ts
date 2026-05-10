/**
 * Tests for `useCaseStore` actions added in v3 (Unit 5).
 *
 * Concerns:
 *  - `openAddPanel(kind)` (no dropCoord) sets kind + opens panel + nulls
 *    any prior dropCoord from a stale drag-and-drop open.
 *  - `openAddPanel(kind, dropCoord)` sets the drop coord into
 *    `addPanelDropCoord` for AddElementPanel to read.
 *  - `closeAddPanel` resets BOTH `addPanelKind` and `addPanelDropCoord`
 *    so a subsequent open from a non-DnD entry point starts clean.
 *  - `closeAddPanelDropCoord` clears just the drop coord (defensive
 *    cleanup hook for SldCanvas dragend; documented as a no-op in the
 *    happy path).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCaseStore } from '@/store/case';

beforeEach(() => {
  useCaseStore.setState({
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    addPanelDropCoord: null,
  });
});

afterEach(() => {
  useCaseStore.setState({
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    addPanelDropCoord: null,
  });
});

describe('useCaseStore — AddElementPanel actions', () => {
  it('openAddPanel without dropCoord opens the panel with no drop seed', () => {
    useCaseStore.getState().openAddPanel('Bus');
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(true);
    expect(s.addPanelKind).toBe('Bus');
    expect(s.addPanelDropCoord).toBeNull();
    expect(s.addPanelDirty).toBe(false);
  });

  it('openAddPanel with dropCoord stores the coordinate', () => {
    useCaseStore.getState().openAddPanel('Bus', { x: 120, y: 240 });
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(true);
    expect(s.addPanelKind).toBe('Bus');
    expect(s.addPanelDropCoord).toEqual({ x: 120, y: 240 });
  });

  it('openAddPanel without dropCoord clears a stale dropCoord from a prior drag-open', () => {
    // Simulate: user dragged a tile, dropped on canvas (sets coord),
    // canceled the panel, then clicked "+ Add element" (no coord).
    useCaseStore.setState({ addPanelDropCoord: { x: 10, y: 20 } });
    useCaseStore.getState().openAddPanel('Generator');
    expect(useCaseStore.getState().addPanelDropCoord).toBeNull();
  });

  it('closeAddPanel resets BOTH kind and dropCoord', () => {
    useCaseStore.getState().openAddPanel('Bus', { x: 5, y: 6 });
    useCaseStore.getState().closeAddPanel();
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(false);
    expect(s.addPanelKind).toBeNull();
    expect(s.addPanelDropCoord).toBeNull();
    expect(s.addPanelDirty).toBe(false);
  });

  it('closeAddPanelDropCoord clears just the drop coord', () => {
    useCaseStore.getState().openAddPanel('Bus', { x: 9, y: 9 });
    useCaseStore.getState().closeAddPanelDropCoord();
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(true); // panel stays open
    expect(s.addPanelKind).toBe('Bus');
    expect(s.addPanelDropCoord).toBeNull();
  });

  it('non-Bus kinds also accept dropCoord (stored as informational)', () => {
    // The store doesn't gate on kind — AddElementPanel decides what
    // to do with the coord. Verify the store stays kind-agnostic so
    // future kinds (Generator + auto-snap to nearest bus, etc.) can
    // opt into the seed without a store change.
    useCaseStore.getState().openAddPanel('Generator', { x: 1, y: 2 });
    expect(useCaseStore.getState().addPanelDropCoord).toEqual({ x: 1, y: 2 });
  });
});
