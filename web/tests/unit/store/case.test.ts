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
 *  - `openAddPanelOnBus(bus)` opens the panel with that bus kept for the
 *    form, and every other way of opening or closing it forgets the bus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCaseStore } from '@/store/case';

beforeEach(() => {
  useCaseStore.setState({
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    addPanelDropCoord: null,
    addPanelBus: null,
  });
});

afterEach(() => {
  useCaseStore.setState({
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    addPanelDropCoord: null,
    addPanelBus: null,
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

  it('openAddPanelOnBus opens the panel on a bus, with the kind still to pick', () => {
    useCaseStore.setState({ addPanelDropCoord: { x: 10, y: 20 } });
    useCaseStore.getState().openAddPanelOnBus('4');
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(true);
    expect(s.addPanelKind).toBeNull();
    expect(s.addPanelBus).toBe('4');
    expect(s.addPanelDropCoord).toBeNull();
    expect(s.addPanelDirty).toBe(false);
  });

  it('openAddPanelOnBus keeps the kind of a panel that is already open', () => {
    useCaseStore.getState().openAddPanel('PV');
    useCaseStore.getState().openAddPanelOnBus('4');
    expect(useCaseStore.getState().addPanelKind).toBe('PV');
    expect(useCaseStore.getState().addPanelBus).toBe('4');
    // A panel that was closed in between starts without a kind again.
    useCaseStore.getState().closeAddPanel();
    useCaseStore.getState().openAddPanelOnBus('5');
    expect(useCaseStore.getState().addPanelKind).toBeNull();
    expect(useCaseStore.getState().addPanelBus).toBe('5');
  });

  it('setAddPanelKind keeps the bus: the next kind is built on it too', () => {
    useCaseStore.getState().openAddPanelOnBus('4');
    useCaseStore.getState().setAddPanelKind('ESD1');
    expect(useCaseStore.getState().addPanelBus).toBe('4');
  });

  it('every other way of opening or closing the panel forgets the bus', () => {
    useCaseStore.getState().openAddPanelOnBus('4');
    useCaseStore.getState().openAddPanel('Bus');
    expect(useCaseStore.getState().addPanelBus).toBeNull();

    useCaseStore.getState().openAddPanelOnBus('4');
    useCaseStore.getState().closeAddPanel();
    expect(useCaseStore.getState().addPanelBus).toBeNull();

    useCaseStore.getState().openAddPanelOnBus('4');
    useCaseStore.getState().setCase({ primaryPath: null, addfiles: [], blank: true });
    expect(useCaseStore.getState().addPanelBus).toBeNull();

    useCaseStore.getState().openAddPanelOnBus('4');
    useCaseStore.getState().clearCase();
    expect(useCaseStore.getState().addPanelBus).toBeNull();
  });
});

describe('useCaseStore: the control chains drawn out in a visit', () => {
  afterEach(() => useCaseStore.getState().clearCase());

  it('starts with none, and keeps what is set', () => {
    expect(useCaseStore.getState().unitExpansion).toEqual({});
    useCaseStore.getState().setUnitExpansion({ '1': true, GENROU_2: false });
    expect(useCaseStore.getState().unitExpansion).toEqual({ '1': true, GENROU_2: false });
  });

  it('forgets them when another case is opened, and when the case is closed', () => {
    useCaseStore.getState().setUnitExpansion({ '1': true });
    useCaseStore.getState().setCase({ primaryPath: null, addfiles: [], blank: true });
    expect(useCaseStore.getState().unitExpansion).toEqual({});

    useCaseStore.getState().setUnitExpansion({ '1': true });
    useCaseStore.getState().clearCase();
    expect(useCaseStore.getState().unitExpansion).toEqual({});
  });
});
