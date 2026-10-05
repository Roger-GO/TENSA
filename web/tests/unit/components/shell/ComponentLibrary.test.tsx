/**
 * Tests for `<ComponentLibrary />` (v3 Unit 5).
 *
 * Concerns:
 *  - Seven tile testids render (Bus, Generator, Load, Shunt, Line,
 *    Transformer, Battery).
 *  - The Battery tile is found under "battery" and under "storage".
 *  - Each tile is `draggable` (HTML5 attribute reflected to the DOM).
 *  - Firing a `dragstart` event on a tile sets the
 *    `application/andes-component-type` MIME on the DataTransfer to
 *    the tile's kind string + sets `effectAllowed='copy'`.
 *  - A tile can also be clicked, or pressed with Enter or Space, to open the
 *    add form on its kind; with no case open it starts a blank system first.
 *  - A line under the tiles says how to add, or why nothing can be added, and a
 *    tile that cannot add is marked disabled, cannot be dragged and does nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProblemDetailsError } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { COMPONENT_DND_MIME, ComponentLibrary } from '@/components/shell/ComponentLibrary';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';

let MOCK_TOPOLOGY: TopologySummary | null = null;
const blankMutate = vi.fn();
let blankPending = false;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
    useBlankSystem: () => ({ mutate: blankMutate, isPending: blankPending }),
  };
});

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function topology(state: TopologySummary['state']): TopologySummary {
  return {
    state,
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

/** A case is open and no run has locked it: the state in which a tile adds. */
function openCase() {
  MOCK_TOPOLOGY = topology('pre-setup');
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
  });
}

beforeEach(() => {
  MOCK_TOPOLOGY = null;
  blankPending = false;
  blankMutate.mockReset();
  toastError.mockReset();
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDropCoord: null,
  });
  usePflowStore.setState({ isRunning: false });
});

afterEach(() => {
  cleanup();
});

describe('<ComponentLibrary />', () => {
  it('mounts the library container with the testid', () => {
    render(<ComponentLibrary />);
    expect(screen.getByTestId('component-library')).toBeInTheDocument();
  });

  it('renders all seven tiles with stable testids', () => {
    render(<ComponentLibrary />);
    const kinds = ['Bus', 'Generator', 'Load', 'Shunt', 'Line', 'Transformer', 'Battery'];
    for (const kind of kinds) {
      expect(screen.getByTestId(`component-library-tile-${kind}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button')).toHaveLength(kinds.length);
  });

  it('marks each tile as draggable', () => {
    render(<ComponentLibrary />);
    const busTile = screen.getByTestId('component-library-tile-Bus');
    expect(busTile.getAttribute('draggable')).toBe('true');
    const genTile = screen.getByTestId('component-library-tile-Generator');
    expect(genTile.getAttribute('draggable')).toBe('true');
  });

  it('dragstart writes the kind to the andes-component-type MIME + effectAllowed=copy', () => {
    render(<ComponentLibrary />);
    const tile = screen.getByTestId('component-library-tile-Generator');

    // Build a minimal DataTransfer-shaped stub. jsdom's synthetic drag
    // events expose a real DataTransfer, but we want assertion-friendly
    // setData calls so we replace it with a spy stub.
    const setData = vi.fn();
    const dataTransfer = {
      setData,
      getData: vi.fn(),
      effectAllowed: 'none' as DataTransfer['effectAllowed'],
      dropEffect: 'none' as DataTransfer['dropEffect'],
      types: [] as ReadonlyArray<string>,
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      clearData: vi.fn(),
      setDragImage: vi.fn(),
    };
    fireEvent.dragStart(tile, { dataTransfer });

    expect(setData).toHaveBeenCalledWith(COMPONENT_DND_MIME, 'Generator');
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('each tile sets its own kind on dragstart', () => {
    render(<ComponentLibrary />);
    const cases: Array<['Bus' | 'Load' | 'Shunt' | 'Line' | 'Transformer' | 'Battery', string]> = [
      ['Bus', 'Bus'],
      ['Load', 'Load'],
      ['Shunt', 'Shunt'],
      ['Line', 'Line'],
      ['Transformer', 'Transformer'],
      ['Battery', 'Battery'],
    ];
    for (const [kind, payload] of cases) {
      const tile = screen.getByTestId(`component-library-tile-${kind}`);
      const setData = vi.fn();
      const dataTransfer = {
        setData,
        getData: vi.fn(),
        effectAllowed: 'none' as DataTransfer['effectAllowed'],
        dropEffect: 'none' as DataTransfer['dropEffect'],
        types: [] as ReadonlyArray<string>,
        files: [] as unknown as FileList,
        items: [] as unknown as DataTransferItemList,
        clearData: vi.fn(),
        setDragImage: vi.fn(),
      };
      fireEvent.dragStart(tile, { dataTransfer });
      expect(setData).toHaveBeenCalledWith(COMPONENT_DND_MIME, payload);
    }
  });
});

describe('<ComponentLibrary /> click to add', () => {
  it('opens the add form on the kind of the tile that was clicked', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.click(screen.getByTestId('component-library-tile-Shunt'));
    expect(useCaseStore.getState()).toMatchObject({
      addPanelOpen: true,
      addPanelKind: 'Shunt',
      addPanelDropCoord: null,
    });
  });

  it('answers Enter and Space on a focused tile, like the button it says it is', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    const bus = screen.getByTestId('component-library-tile-Bus');
    bus.focus();
    await user.keyboard('{Enter}');
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'Bus' });
    useCaseStore.getState().closeAddPanel();
    const line = screen.getByTestId('component-library-tile-Line');
    line.focus();
    await user.keyboard(' ');
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'Line' });
  });

  it('gives each tile the name "Add <kind>" and says it can be clicked or dragged', () => {
    openCase();
    render(<ComponentLibrary />);
    expect(screen.getByRole('button', { name: 'Add Generator' })).toBe(
      screen.getByTestId('component-library-tile-Generator'),
    );
    expect(screen.getByTestId('component-library-tile-Generator').getAttribute('title')).toMatch(
      /click here, or drag it onto the diagram/,
    );
    expect(screen.getByTestId('component-library-hint')).toHaveTextContent(
      'Click a tile to add that element, or drag it onto the diagram.',
    );
  });

  it('has a Battery tile, named for the storage model it adds, that opens the add form', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    const tile = screen.getByTestId('component-library-tile-Battery');
    expect(tile).toHaveTextContent('Battery');
    // Found by either word a user looks for.
    expect(screen.getByRole('button', { name: 'Add Battery (ESD1 storage)' })).toBe(tile);
    expect(screen.getByRole('button', { name: /storage/i })).toBe(tile);
    expect(tile.getAttribute('title')).toBe(
      'Add a battery (ESD1 storage): click here, or drag it onto the diagram',
    );
    await user.click(tile);
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'Battery' });
  });

  it('says where the models without a tile are', () => {
    openCase();
    render(<ComponentLibrary />);
    expect(screen.getByTestId('component-library-hint')).toHaveTextContent(
      "The form's Kind list has the other models: machines, exciters, governors.",
    );
  });

  it('starts a blank system first when no case is open, then opens the form', () => {
    render(<ComponentLibrary />);
    fireEvent.click(screen.getByTestId('component-library-tile-Generator'));
    expect(blankMutate).toHaveBeenCalledTimes(1);
    expect(blankMutate.mock.calls[0]?.[0]).toBe('test-session-id');
    // Nothing opens until the server has made the system.
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    const callbacks = blankMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    act(() => callbacks.onSuccess());
    expect(useCaseStore.getState().selection).toMatchObject({ blank: true, primaryPath: null });
    expect(useCaseStore.getState()).toMatchObject({
      addPanelOpen: true,
      addPanelKind: 'Generator',
    });
  });

  it('says so in a toast when the blank system cannot be started', () => {
    render(<ComponentLibrary />);
    fireEvent.click(screen.getByTestId('component-library-tile-Bus'));
    const callbacks = blankMutate.mock.calls[0]?.[1] as { onError: (e: Error) => void };
    act(() => callbacks.onError(new Error('worker is gone')));
    expect(toastError).toHaveBeenCalledWith('worker is gone');
    act(() =>
      callbacks.onError(
        new ProblemDetailsError({ status: 409, title: 'Conflict', type: 'about:blank' }),
      ),
    );
    expect(toastError).toHaveBeenLastCalledWith(
      'A system is already loaded; discard it first or open a fresh tab.',
    );
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });
});

describe('<ComponentLibrary /> when nothing can be added', () => {
  function expectBlocked(reason: RegExp) {
    const bus = screen.getByTestId('component-library-tile-Bus');
    expect(bus).toHaveAttribute('aria-disabled', 'true');
    expect(bus).toHaveAttribute('draggable', 'false');
    expect(bus.getAttribute('title')).toMatch(reason);
    expect(screen.getByTestId('component-library-hint').textContent).toMatch(reason);
  }

  it('says a run has locked the system, and what unlocks it, and does nothing on a click', async () => {
    MOCK_TOPOLOGY = topology('committed');
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
    });
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    expectBlocked(/A run has locked the system.*Reset run in the Inspector/);
    await user.click(screen.getByTestId('component-library-tile-Bus'));
    await user.keyboard('{Enter}');
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    expect(blankMutate).not.toHaveBeenCalled();
  });

  it('does not start a drag from a tile while it is blocked', () => {
    MOCK_TOPOLOGY = topology('committed');
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
    });
    render(<ComponentLibrary />);
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId('component-library-tile-Bus'), {
      dataTransfer: { setData, effectAllowed: 'none' },
    });
    expect(setData).not.toHaveBeenCalled();
  });

  it('says to wait while a power flow is running', () => {
    openCase();
    usePflowStore.setState({ isRunning: true });
    render(<ComponentLibrary />);
    expectBlocked(/Wait for the power flow to finish/);
  });

  it('says the case is still loading while a selected case has no topology yet', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
    });
    render(<ComponentLibrary />);
    expectBlocked(/The case is still loading/);
  });

  it('says the server is not ready before there is a session', () => {
    useSessionStore.setState({ sessionId: null });
    render(<ComponentLibrary />);
    expectBlocked(/The server session is not ready yet/);
  });

  it('says a new system is being started while the blank request runs', () => {
    blankPending = true;
    render(<ComponentLibrary />);
    expectBlocked(/Starting a new system/);
  });
});
