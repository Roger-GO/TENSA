/**
 * Tests for `useCaseStore` actions added in v3 (Unit 5).
 *
 * Concerns:
 *  - `openAddPanel(kind)` sets kind + opens panel.
 *  - `closeAddPanel` resets `addPanelKind`, so a subsequent open starts
 *    clean.
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
    addPanelBus: null,
  });
});

afterEach(() => {
  useCaseStore.setState({
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    addPanelBus: null,
  });
});

describe('useCaseStore — AddElementPanel actions', () => {
  it('openAddPanel opens the panel on the kind it is given', () => {
    useCaseStore.getState().openAddPanel('Bus');
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(true);
    expect(s.addPanelKind).toBe('Bus');
    expect(s.addPanelDirty).toBe(false);
  });

  it('closeAddPanel resets the kind', () => {
    useCaseStore.getState().openAddPanel('Bus');
    useCaseStore.getState().closeAddPanel();
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(false);
    expect(s.addPanelKind).toBeNull();
    expect(s.addPanelDirty).toBe(false);
  });

  it('openAddPanelOnBus opens the panel on a bus, with the kind still to pick', () => {
    useCaseStore.getState().openAddPanelOnBus('4');
    const s = useCaseStore.getState();
    expect(s.addPanelOpen).toBe(true);
    expect(s.addPanelKind).toBeNull();
    expect(s.addPanelBus).toBe('4');
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

describe('useCaseStore: the branch routes chosen in a visit', () => {
  afterEach(() => useCaseStore.getState().clearCase());

  const route = {
    points: [
      [10, 3],
      [10, 103],
    ] as [number, number][],
    anchors: { source: { x: 0, y: 0 }, target: { x: 0, y: 100 } },
  };

  it('starts with none, and keeps what is set, a branch with no route included', () => {
    expect(useCaseStore.getState().routeOverrides).toEqual({});
    useCaseStore.getState().setRouteOverrides({ 'line-L1': route, 'line-L2': null });
    expect(useCaseStore.getState().routeOverrides).toEqual({ 'line-L1': route, 'line-L2': null });
  });

  it('forgets them when another case is opened, and when the case is closed', () => {
    useCaseStore.getState().setRouteOverrides({ 'line-L1': route });
    useCaseStore.getState().setCase({ primaryPath: null, addfiles: [], blank: true });
    expect(useCaseStore.getState().routeOverrides).toEqual({});

    useCaseStore.getState().setRouteOverrides({ 'line-L1': route });
    useCaseStore.getState().clearCase();
    expect(useCaseStore.getState().routeOverrides).toEqual({});
  });

  it('puts an arrangement in place in one step: the positions, the routes, and the chains when given', () => {
    useCaseStore.getState().setUnitExpansion({ '1': true });
    const seen: number[] = [];
    const unsubscribe = useCaseStore.subscribe(() => seen.push(1));
    useCaseStore.getState().setArrangement({
      dragOverrides: { '1': { x: 5, y: 6 } },
      routeOverrides: { 'line-L1': route },
    });
    unsubscribe();
    // One change of the store, so the diagram is never drawn from half of it.
    expect(seen).toHaveLength(1);
    expect(useCaseStore.getState()).toMatchObject({
      dragOverrides: { '1': { x: 5, y: 6 } },
      routeOverrides: { 'line-L1': route },
      // Left as they were: a move does not fold a chain.
      unitExpansion: { '1': true },
    });

    useCaseStore.getState().setArrangement({
      dragOverrides: {},
      routeOverrides: {},
      unitExpansion: {},
    });
    expect(useCaseStore.getState()).toMatchObject({
      dragOverrides: {},
      routeOverrides: {},
      unitExpansion: {},
    });
  });
});
