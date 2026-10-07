/**
 * Tests for `<ComponentLibrary />`, the palette of the left sidebar's
 * Components tab.
 *
 * Concerns:
 *  - Every kind the Add element form can add has a row, under the heading of
 *    its group, with its name and the line that says what it is.
 *  - The search box keeps the rows that hold every word typed, says how many
 *    it kept, and says so when it kept none, with a way back to the whole list.
 *  - Each row is `draggable` (HTML5 attribute reflected to the DOM).
 *  - Firing a `dragstart` event on a row sets the
 *    `application/andes-component-type` MIME on the DataTransfer to
 *    the row's kind + sets `effectAllowed='copy'`.
 *  - A row can also be clicked, or pressed with Enter or Space, to open the
 *    add form on its kind; with no case open it starts a blank system first.
 *  - The arrow keys move between the rows and the search box, and the rows
 *    are one stop for the Tab key between them.
 *  - A line under the search box says how to add, or why nothing can be added,
 *    and a row that cannot add is marked disabled, cannot be dragged and does
 *    nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProblemDetailsError } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { ELEMENT_KINDS, groupElementKinds } from '@/components/elements/elementKinds';
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

/** A case is open and no run has locked it: the state in which a row adds. */
function openCase() {
  MOCK_TOPOLOGY = topology('pre-setup');
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
  });
}

const row = (kind: string) => screen.getByTestId(`component-library-item-${kind}`);
const search = () => screen.getByTestId('component-library-search');
/** The kinds that have a row, in the order of the rows. */
const shownKinds = () =>
  Array.from(document.querySelectorAll('[data-component-kind]')).map((el) =>
    el.getAttribute('data-component-kind'),
  );

/** A DataTransfer-shaped stub whose `setData` calls can be asserted on. */
function dataTransferStub() {
  return {
    setData: vi.fn(),
    getData: vi.fn(),
    effectAllowed: 'none' as DataTransfer['effectAllowed'],
    dropEffect: 'none' as DataTransfer['dropEffect'],
    types: [] as ReadonlyArray<string>,
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    clearData: vi.fn(),
    setDragImage: vi.fn(),
  };
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

  it('has a row for every kind the Add element form can add, in the same order', () => {
    render(<ComponentLibrary />);
    expect(shownKinds()).toEqual(ELEMENT_KINDS.map((k) => k.value));
    // The search box is a text field: the rows are the only buttons.
    expect(screen.getAllByRole('button')).toHaveLength(ELEMENT_KINDS.length);
  });

  it('groups the rows under a heading for each group of the Kind picker', () => {
    render(<ComponentLibrary />);
    const sections = groupElementKinds(ELEMENT_KINDS);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(
      sections.map((s) => s.group),
    );
    for (const { group, kinds } of sections) {
      // A group is a region named by its heading, with one list item per kind.
      const region = screen.getByRole('region', { name: group });
      expect(region).toBe(screen.getByTestId(`component-library-group-${group}`));
      expect(within(region).getAllByRole('listitem')).toHaveLength(kinds.length);
      for (const kind of kinds) {
        expect(within(region).getByTestId(`component-library-item-${kind.value}`)).toBeDefined();
      }
    }
  });

  it('shows the name of each kind and the line that says what it is', () => {
    render(<ComponentLibrary />);
    for (const kind of ELEMENT_KINDS) {
      expect(row(kind.value)).toHaveTextContent(kind.label);
      expect(row(kind.value)).toHaveTextContent(kind.description);
    }
  });

  it('names each row "Add <kind>" and describes it by its line', () => {
    openCase();
    render(<ComponentLibrary />);
    expect(screen.getByRole('button', { name: 'Add PV generator' })).toBe(row('PV'));
    expect(row('PV')).toHaveAccessibleDescription(
      'Holds its active power and its bus voltage in the power flow.',
    );
    expect(screen.getByRole('button', { name: 'Add GENROU (synchronous)' })).toBe(row('GENROU'));
    expect(row('GENROU').getAttribute('title')).toBe(
      'Add GENROU (synchronous): click here, or drag it onto the diagram',
    );
  });

  it('marks each row as draggable', () => {
    render(<ComponentLibrary />);
    for (const kind of ELEMENT_KINDS) {
      expect(row(kind.value).getAttribute('draggable')).toBe('true');
    }
  });

  it('dragstart writes the kind to the andes-component-type MIME + effectAllowed=copy', () => {
    render(<ComponentLibrary />);
    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(row('PV'), { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith(COMPONENT_DND_MIME, 'PV');
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('each row sets its own kind on dragstart: the value the Kind picker knows it by', () => {
    render(<ComponentLibrary />);
    for (const kind of ELEMENT_KINDS) {
      const dataTransfer = dataTransferStub();
      fireEvent.dragStart(row(kind.value), { dataTransfer });
      expect(dataTransfer.setData).toHaveBeenCalledWith(COMPONENT_DND_MIME, kind.value);
    }
  });
});

describe('<ComponentLibrary /> search', () => {
  it('has a search box named for what it searches', () => {
    render(<ComponentLibrary />);
    expect(screen.getByRole('textbox', { name: 'Search components' })).toBe(search());
    expect(search()).toHaveAttribute('placeholder', 'Search components');
  });

  it('keeps the rows that match as the user types, with the headings of their groups only', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.type(search(), 'exciter');
    expect(shownKinds()).toEqual(['IEEEX1', 'ESDC2A', 'EXST1', 'SEXS']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Exciters',
    ]);
  });

  it('finds a kind by another word for it, and narrows with each word typed', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.type(search(), 'storage');
    expect(shownKinds()).toEqual(['ESD1']);
    await user.clear(search());
    await user.type(search(), 'gen');
    expect(shownKinds()).toEqual(['PV', 'Slack', 'GENROU', 'GENCLS']);
    await user.type(search(), ' classic');
    expect(shownKinds()).toEqual(['GENCLS']);
  });

  it('says how many it kept, in a status a screen reader hears, and nothing when not searching', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    const count = screen.getByTestId('component-library-count');
    expect(count).toHaveAttribute('role', 'status');
    expect(count).toHaveTextContent('');
    await user.type(search(), 'load');
    expect(count).toHaveTextContent(`2 of ${ELEMENT_KINDS.length} components`);
    await user.clear(search());
    expect(count).toHaveTextContent('');
  });

  it('says that nothing matches, names what was typed and offers the whole list back', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.type(search(), 'flux capacitor');
    expect(shownKinds()).toEqual([]);
    expect(screen.queryAllByRole('heading', { level: 2 })).toEqual([]);
    const empty = screen.getByTestId('component-library-empty');
    expect(empty).toHaveTextContent('No component matches “flux capacitor”.');
    expect(empty).toHaveTextContent('Search by name, model or category');
    expect(screen.getByTestId('component-library-count')).toHaveTextContent(
      `0 of ${ELEMENT_KINDS.length} components`,
    );

    await user.click(screen.getByRole('button', { name: 'Show all components' }));
    expect(search()).toHaveValue('');
    expect(search()).toHaveFocus();
    expect(shownKinds()).toEqual(ELEMENT_KINDS.map((k) => k.value));
    expect(screen.queryByTestId('component-library-empty')).toBeNull();
  });

  it('clears on Escape, and on its clear button, which is only there while there is text', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    expect(screen.queryByRole('button', { name: 'Clear the search' })).toBeNull();
    await user.type(search(), 'bus');
    expect(shownKinds()).toEqual(['Bus']);
    await user.keyboard('{Escape}');
    expect(search()).toHaveValue('');
    expect(shownKinds()).toHaveLength(ELEMENT_KINDS.length);

    await user.type(search(), 'line');
    await user.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(search()).toHaveValue('');
    expect(search()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear the search' })).toBeNull();
  });

  it('adds the kind of a row that the search kept', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.type(search(), 'governor');
    await user.click(row('IEEEG1'));
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'IEEEG1' });
    // The search stays as it was: the next governor is one click away.
    expect(search()).toHaveValue('governor');
  });
});

describe('<ComponentLibrary /> click to add', () => {
  it('opens the add form on the kind of the row that was clicked', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.click(row('Shunt'));
    expect(useCaseStore.getState()).toMatchObject({
      addPanelOpen: true,
      addPanelKind: 'Shunt',
      addPanelDropCoord: null,
    });
  });

  it('opens the form on the very model of the row, not on a family the form has to guess from', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    for (const kind of ['Transformer2W', 'Slack', 'GENCLS', 'ZIP', 'ESD1']) {
      await user.click(row(kind));
      expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: kind });
      act(() => useCaseStore.getState().closeAddPanel());
    }
  });

  it('answers Enter and Space on a focused row, like the button it says it is', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    act(() => row('Bus').focus());
    await user.keyboard('{Enter}');
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'Bus' });
    act(() => useCaseStore.getState().closeAddPanel());
    act(() => row('Line').focus());
    await user.keyboard(' ');
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'Line' });
  });

  it('says that a row can be clicked or dragged', () => {
    openCase();
    render(<ComponentLibrary />);
    expect(screen.getByTestId('component-library-hint')).toHaveTextContent(
      'Click a component to add it, or drag it onto the diagram.',
    );
  });

  it('says that a click starts a blank system while no case is open', () => {
    render(<ComponentLibrary />);
    expect(screen.getByTestId('component-library-hint')).toHaveTextContent(
      'Click a component, or drag it onto the diagram, to start a blank system with it.',
    );
  });

  it('has the battery under Storage, found under "battery" and under "storage"', async () => {
    openCase();
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    const battery = row('ESD1');
    expect(screen.getByRole('button', { name: 'Add ESD1 battery' })).toBe(battery);
    expect(within(screen.getByRole('region', { name: 'Storage' })).getByRole('button')).toBe(
      battery,
    );
    for (const word of ['battery', 'storage']) {
      await user.clear(search());
      await user.type(search(), word);
      expect(shownKinds()).toEqual(['ESD1']);
    }
    await user.click(row('ESD1'));
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'ESD1' });
  });

  it('starts a blank system first when no case is open, then opens the form', () => {
    render(<ComponentLibrary />);
    fireEvent.click(row('PV'));
    expect(blankMutate).toHaveBeenCalledTimes(1);
    expect(blankMutate.mock.calls[0]?.[0]).toBe('test-session-id');
    // Nothing opens until the server has made the system.
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    const callbacks = blankMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    act(() => callbacks.onSuccess());
    expect(useCaseStore.getState().selection).toMatchObject({ blank: true, primaryPath: null });
    expect(useCaseStore.getState()).toMatchObject({
      addPanelOpen: true,
      addPanelKind: 'PV',
    });
  });

  it('says so in a toast when the blank system cannot be started', () => {
    render(<ComponentLibrary />);
    fireEvent.click(row('Bus'));
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

describe('<ComponentLibrary /> arrow keys', () => {
  it('goes down from the search box into the rows, along them, and back up into the box', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    search().focus();
    await user.keyboard('{ArrowDown}');
    expect(row('Bus')).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    // Across the heading of the next group.
    expect(row('Transformer2W')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(row('Line')).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(search()).toHaveFocus();
  });

  it('goes to the last row on End and the first on Home, and stops at the last', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    act(() => row('Line').focus());
    await user.keyboard('{End}');
    expect(row('Shunt')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(row('Shunt')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(row('Bus')).toHaveFocus();
  });

  it('walks only the rows the search kept', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.type(search(), 'load');
    await user.keyboard('{ArrowDown}');
    expect(row('PQ')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(row('ZIP')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(row('ZIP')).toHaveFocus();
  });

  it('leaves the caret keys of the search box alone when there is no row to go to', async () => {
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    await user.type(search(), 'nothing like this');
    await user.keyboard('{ArrowDown}');
    expect(search()).toHaveFocus();
  });
});

describe('<ComponentLibrary /> Tab key', () => {
  /** The kinds of the rows Tab stops at. */
  const tabStops = () =>
    Array.from(document.querySelectorAll('[data-component-kind][tabindex="0"]')).map((el) =>
      el.getAttribute('data-component-kind'),
    );
  const after = () => screen.getByRole('button', { name: 'What comes after' });
  const renderBeforeSomething = () =>
    render(
      <>
        <ComponentLibrary />
        <button type="button">What comes after</button>
      </>,
    );

  it('stops at one row, the first, so one press leaves the list and not one per row', async () => {
    const user = userEvent.setup();
    renderBeforeSomething();
    expect(tabStops()).toEqual(['Bus']);
    search().focus();
    await user.tab();
    expect(row('Bus')).toHaveFocus();
    await user.tab();
    expect(after()).toHaveFocus();
  });

  it('comes back in at the row the arrow keys left', async () => {
    const user = userEvent.setup();
    renderBeforeSomething();
    search().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(row('Transformer2W')).toHaveFocus();
    expect(tabStops()).toEqual(['Transformer2W']);
    await user.tab();
    expect(after()).toHaveFocus();
    await user.tab({ shift: true });
    expect(row('Transformer2W')).toHaveFocus();
  });

  it('stops at the first row the search kept while the row it was on is not shown', async () => {
    const user = userEvent.setup();
    renderBeforeSomething();
    search().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(tabStops()).toEqual(['Line']);
    await user.type(search(), 'load');
    expect(tabStops()).toEqual(['PQ']);
    // Shown again, the row it was on is the stop again.
    await user.clear(search());
    expect(tabStops()).toEqual(['Line']);
  });

  it('keeps a row that cannot add as a stop: it still says why when it has the focus', () => {
    openCase();
    MOCK_TOPOLOGY = topology('committed');
    renderBeforeSomething();
    expect(row('Bus')).toHaveAttribute('aria-disabled', 'true');
    expect(tabStops()).toEqual(['Bus']);
  });
});

describe('<ComponentLibrary /> when nothing can be added', () => {
  function expectBlocked(reason: RegExp) {
    const bus = row('Bus');
    const hint = screen.getByTestId('component-library-hint');
    expect(bus).toHaveAttribute('aria-disabled', 'true');
    expect(bus).toHaveAttribute('draggable', 'false');
    expect(bus.getAttribute('title')).toMatch(reason);
    expect(hint.textContent).toMatch(reason);
    // Read out with the row: what it is, then why it cannot be added.
    expect(bus.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
    expect(bus).toHaveAccessibleDescription(reason);
    expect(bus).toHaveAccessibleDescription(/A node of the network/);
  }

  it('says a run has locked the system, and what unlocks it, and does nothing on a click', async () => {
    MOCK_TOPOLOGY = topology('committed');
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
    });
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    expectBlocked(/A run has locked the system.*Reset run in the Inspector/);
    await user.click(row('Bus'));
    await user.keyboard('{Enter}');
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    expect(blankMutate).not.toHaveBeenCalled();
  });

  it('blocks every row, and the search still works on them', async () => {
    MOCK_TOPOLOGY = topology('committed');
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
    });
    const user = userEvent.setup();
    render(<ComponentLibrary />);
    for (const kind of ELEMENT_KINDS) {
      expect(row(kind.value)).toHaveAttribute('aria-disabled', 'true');
    }
    await user.type(search(), 'shunt');
    expect(shownKinds()).toEqual(['Shunt']);
    expect(row('Shunt')).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not start a drag from a row while it is blocked', () => {
    MOCK_TOPOLOGY = topology('committed');
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
    });
    render(<ComponentLibrary />);
    const setData = vi.fn();
    fireEvent.dragStart(row('Bus'), {
      dataTransfer: { setData, effectAllowed: 'none' },
    });
    expect(setData).not.toHaveBeenCalled();
  });

  it('describes a row by its line alone while it can add', () => {
    openCase();
    render(<ComponentLibrary />);
    expect(row('Bus')).not.toHaveAttribute('aria-disabled');
    expect(row('Bus').getAttribute('aria-describedby')?.split(' ')).not.toContain(
      screen.getByTestId('component-library-hint').id,
    );
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
