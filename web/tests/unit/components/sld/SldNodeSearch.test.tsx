/**
 * SldNodeSearch — popover for jump-to-node navigation (Unit 11).
 *
 * Coverage:
 *
 *  - Happy: synthetic 14-bus list renders inside the popover; "BUS_5"
 *    filter narrows the visible rows to one match; pressing Enter
 *    pans the canvas + closes the popover + writes selectedNodeId.
 *  - Edge: empty results show "No nodes match".
 *  - Edge: clearing the input restores the full list.
 *  - Edge: 140-bus synthetic graph still renders with the visible-row
 *    cap (≤50 rows in the DOM at once).
 *  - Performance: the `nodeColor`/list-row re-render path is driven
 *    by `getNodes()` only; we assert that closing + reopening the
 *    popover re-snapshots, so a topology change between opens is
 *    reflected.
 *  - Kinds: a row is found by what it is ("exciter", "avr",
 *    "controller") and by its model class as well as by its name, says
 *    what it is, and the list can be narrowed to a kind by a button. A
 *    look for a kind the diagram has none of is told so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

// Stub @xyflow/react so the popover can call `useReactFlow()` outside
// a real provider. Each test sets `mockNodes` to drive what the
// popover sees; `mockSetCenter` is a spy so we can assert pan calls.
let mockNodes: Array<{
  id: string;
  type: string;
  data: { idx: string; name: string; kind?: string; unit?: unknown };
  position: { x: number; y: number };
  measured?: { width: number; height: number };
}> = [];
const mockSetCenter = vi.fn();
const mockGetZoom = vi.fn(() => 1.5);

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    useReactFlow: () => ({
      setCenter: mockSetCenter,
      getZoom: mockGetZoom,
      getNodes: () => mockNodes,
    }),
    // Popover-related primitives aren't used by the search component
    // directly, but other Phase 1 imports might pick them up
    // transitively. Provide stubs to be safe.
    ReactFlowProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

import { SldNodeSearch } from '@/components/sld/SldNodeSearch';
import { useSldStore } from '@/store/sld';

function makeBusNodes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    type: 'bus',
    data: { idx: String(i + 1), name: `BUS_${i + 1}` },
    position: { x: 100 * (i + 1), y: 50 * (i + 1) },
  }));
}

beforeEach(() => {
  mockNodes = [];
  mockSetCenter.mockReset();
  mockGetZoom.mockReset();
  mockGetZoom.mockReturnValue(1.5);
  useSldStore.setState({ selectedNodeId: null });
});

afterEach(() => {
  cleanup();
});

describe('<SldNodeSearch /> trigger tooltip', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  });

  it('names the search key of the platform', () => {
    for (const [platform, key] of [
      ['Linux x86_64', 'Ctrl+/'],
      ['MacIntel', '⌘/'],
    ] as const) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { platform, userAgent: '' } as unknown as Navigator,
        configurable: true,
        writable: true,
      });
      render(<SldNodeSearch />);
      expect(screen.getByTestId('sld-node-search-trigger')).toHaveAttribute(
        'title',
        `Search nodes (${key})`,
      );
      cleanup();
    }
  });
});

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByTestId('sld-node-search-trigger');
  await user.click(trigger);
  // Wait for the input to mount (Radix portals + auto-focus rAF).
  await screen.findByTestId('sld-node-search-input');
}

describe('SldNodeSearch — happy path (14 buses)', () => {
  beforeEach(() => {
    mockNodes = makeBusNodes(14);
  });

  it('renders the trigger button', () => {
    render(<SldNodeSearch />);
    expect(screen.getByTestId('sld-node-search-trigger')).toBeInTheDocument();
  });

  it('opens the popover on trigger click and lists all 14 buses', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    // The popover container, the input, and 14 rows should all be in
    // the document.
    expect(screen.getByTestId('sld-node-search')).toBeInTheDocument();
    for (let i = 1; i <= 14; i++) {
      expect(screen.getByTestId(`sld-node-search-row-${i}`)).toBeInTheDocument();
    }
  });

  it('"BUS_5" filter narrows to a single match', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const input = screen.getByTestId('sld-node-search-input') as HTMLInputElement;
    await user.type(input, 'BUS_5');
    // Only BUS_5 (idx 5) should remain. BUS_15 doesn't exist in a
    // 14-bus list. (Sanity: the search is case-insensitive and
    // matches on both `idx` and `name` — a `name` match is what
    // catches "BUS_5" here.)
    expect(screen.getByTestId('sld-node-search-row-5')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-node-search-row-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sld-node-search-row-14')).not.toBeInTheDocument();
  });

  it('Enter selects the first visible row, pans, and closes', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const input = screen.getByTestId('sld-node-search-input') as HTMLInputElement;
    await user.type(input, 'BUS_7');
    await user.keyboard('{Enter}');
    // Pan target: BUS_7 lives at (100*7, 50*7) per `makeBusNodes`.
    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    expect(mockSetCenter).toHaveBeenCalledWith(700, 350, expect.objectContaining({ zoom: 1.5 }));
    // Selected node id slot was written.
    expect(useSldStore.getState().selectedNodeId).toBe('7');
    // Popover closed (input no longer in the DOM).
    expect(screen.queryByTestId('sld-node-search-input')).not.toBeInTheDocument();
  });

  it('clicking a row selects + pans + closes', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const row3 = screen.getByTestId('sld-node-search-row-3');
    await user.click(row3);
    expect(mockSetCenter).toHaveBeenCalledWith(300, 150, expect.objectContaining({ zoom: 1.5 }));
    expect(useSldStore.getState().selectedNodeId).toBe('3');
    expect(screen.queryByTestId('sld-node-search-input')).not.toBeInTheDocument();
  });

  it('centres on the middle of a node React Flow has measured', async () => {
    mockNodes = makeBusNodes(3).map((n) => ({ ...n, measured: { width: 92, height: 30 } }));
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.click(screen.getByTestId('sld-node-search-row-2'));
    expect(mockSetCenter).toHaveBeenCalledWith(246, 115, expect.objectContaining({ zoom: 1.5 }));
  });

  it('shows the node at full size when the diagram is too small to read', async () => {
    // A tall diagram fitted to a short pane: a bus is a few pixels long.
    mockGetZoom.mockReturnValue(0.19);
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.click(screen.getByTestId('sld-node-search-row-3'));
    expect(mockSetCenter).toHaveBeenCalledWith(300, 150, expect.objectContaining({ zoom: 1 }));
    // Asked for away from the diagram, so the canvas zooms in on it too.
    expect(useSldStore.getState().selectedOnDiagram).toBe(false);
  });
});

describe('SldNodeSearch and drafts', () => {
  it('does not list a draft: it is not in the system, and has a list of its own', async () => {
    const user = userEvent.setup();
    mockNodes = [
      ...makeBusNodes(2),
      {
        id: 'draft-1',
        type: 'draft',
        data: { idx: 'draft-1', name: 'PV generator 6', kind: 'PV' },
        position: { x: 0, y: 0 },
      },
    ];
    render(<SldNodeSearch />);
    await openPopover(user);
    expect(screen.getByTestId('sld-node-search-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('sld-node-search-row-2')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-node-search-row-draft-1')).toBeNull();
    expect(screen.getByTestId('sld-node-search-count')).toHaveTextContent('2 matches');
  });
});

describe('SldNodeSearch — edge cases', () => {
  it('shows "No nodes match" when the filter has no matches', async () => {
    mockNodes = makeBusNodes(5);
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const input = screen.getByTestId('sld-node-search-input') as HTMLInputElement;
    await user.type(input, 'zzznotreal');
    expect(screen.getByTestId('sld-node-search-empty')).toHaveTextContent('No nodes match');
    // Verify no rows remain.
    for (let i = 1; i <= 5; i++) {
      expect(screen.queryByTestId(`sld-node-search-row-${i}`)).not.toBeInTheDocument();
    }
  });

  it('clearing the filter restores the full list', async () => {
    mockNodes = makeBusNodes(5);
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const input = screen.getByTestId('sld-node-search-input') as HTMLInputElement;
    await user.type(input, 'BUS_2');
    expect(screen.getByTestId('sld-node-search-row-2')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-node-search-row-1')).not.toBeInTheDocument();
    // Clear the input.
    await user.clear(input);
    // All five rows back.
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByTestId(`sld-node-search-row-${i}`)).toBeInTheDocument();
    }
  });

  it('renders empty popover gracefully when no nodes are mounted', async () => {
    mockNodes = [];
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    expect(screen.getByTestId('sld-node-search-empty')).toHaveTextContent('No nodes match');
    expect(mockSetCenter).not.toHaveBeenCalled();
  });

  it('caps visible rows at 50 even with a 140-bus synthetic graph', async () => {
    mockNodes = makeBusNodes(140);
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    // Visible rows should be ≤50; the truncated-banner should also
    // surface so the user knows the list was clipped.
    const rows = screen.getAllByTestId(/^sld-node-search-row-/);
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(screen.getByTestId('sld-node-search-truncated')).toBeInTheDocument();
  });

  it('Enter on an empty result list does NOT pan or close', async () => {
    mockNodes = makeBusNodes(3);
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const input = screen.getByTestId('sld-node-search-input') as HTMLInputElement;
    await user.type(input, 'zzz');
    await user.keyboard('{Enter}');
    expect(mockSetCenter).not.toHaveBeenCalled();
    // Popover stays open (input still in the DOM).
    expect(screen.getByTestId('sld-node-search-input')).toBeInTheDocument();
  });
});

describe('SldNodeSearch — non-bus device nodes', () => {
  it('lists generators / loads / shunts alongside buses', async () => {
    mockNodes = [
      ...makeBusNodes(2),
      {
        id: 'generator-G1',
        type: 'generator',
        data: { idx: 'G1', name: 'Slack' },
        position: { x: 50, y: 50 },
      },
      {
        id: 'load-L1',
        type: 'load',
        data: { idx: 'L1', name: 'Industrial' },
        position: { x: 200, y: 200 },
      },
    ];
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    expect(screen.getByTestId('sld-node-search-row-G1')).toBeInTheDocument();
    expect(screen.getByTestId('sld-node-search-row-L1')).toBeInTheDocument();
    // Selecting a non-bus row still pans + writes the id.
    await user.click(screen.getByTestId('sld-node-search-row-G1'));
    expect(useSldStore.getState().selectedNodeId).toBe('generator-G1');
    expect(mockSetCenter).toHaveBeenCalledWith(50, 50, expect.objectContaining({ zoom: 1.5 }));
  });

  it('lists the models of a generating unit, and shows the symbol of the unit for each', async () => {
    // Slack 1 with a machine numbered like it and a governor: one node.
    mockNodes = [
      ...makeBusNodes(1),
      {
        id: 'generator-1',
        type: 'generator',
        data: {
          idx: '1',
          name: 'Slack',
          unit: {
            expanded: false,
            members: [
              { kind: 'Slack', idx: '1', name: 'Slack', role: 'generator', depth: 0 },
              {
                kind: 'GENROU',
                idx: '1',
                name: 'GENROU_1',
                role: 'machine',
                nodeId: 'generator-1',
                depth: 1,
              },
              {
                kind: 'TGOV1',
                idx: 'TGOV1_1',
                name: 'TGOV1_1',
                role: 'governor',
                nodeId: 'controller-TGOV1-TGOV1_1',
                depth: 2,
              },
            ],
          },
        },
        position: { x: 50, y: 60 },
        measured: { width: 80, height: 40 },
      },
    ];
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    // The bus, the unit, its machine and its governor: no two rows the same to React.
    const rows = screen.getByTestId('sld-node-search-list').querySelectorAll('[role="option"]');
    expect([...rows].map((row) => row.getAttribute('data-node-type'))).toEqual([
      'bus',
      'generator',
      'machine',
      'controller',
    ]);

    await user.type(screen.getByTestId('sld-node-search-input'), 'tgov');
    await user.click(screen.getByTestId('sld-node-search-row-TGOV1_1'));
    // The governor is picked by its own id, and found where its unit is drawn.
    expect(useSldStore.getState().selectedNodeId).toBe('controller-TGOV1-TGOV1_1');
    expect(mockSetCenter).toHaveBeenCalledWith(90, 80, expect.objectContaining({ zoom: 1.5 }));
  });
});

/**
 * Two buses, each with a load, and two generating units: Slack 1 with a
 * machine, an exciter and a governor, PV 2 with a machine and a governor. The
 * models of a unit are named the way the example cases name them, which says
 * nothing of what they are (two governors called `TGOV1_1`).
 */
function makeDynamicDiagram(): typeof mockNodes {
  const unit = (idx: string, kind: string, exciter: boolean) => ({
    id: `generator-${idx}`,
    type: 'generator',
    data: {
      idx,
      name: idx,
      kind,
      unit: {
        expanded: false,
        members: [
          { kind, idx, name: idx, role: 'generator', nodeId: `generator-${idx}`, depth: 0 },
          {
            kind: 'GENROU',
            idx,
            name: `GENROU_${idx}`,
            role: 'machine',
            nodeId: `generator-${idx}`,
            depth: 1,
          },
          ...(exciter
            ? [
                {
                  kind: 'EXST1',
                  idx,
                  name: `EXST1_${idx}`,
                  role: 'exciter',
                  nodeId: `controller-EXST1-${idx}`,
                  depth: 2,
                },
              ]
            : []),
          {
            kind: 'TGOV1',
            idx,
            name: 'TGOV1_1',
            role: 'governor',
            nodeId: `controller-TGOV1-${idx}`,
            depth: 2,
          },
        ],
      },
    },
    position: { x: 40 * Number(idx), y: 10 },
  });
  const load = (idx: string) => ({
    id: `load-${idx}`,
    type: 'load',
    data: { idx, name: idx, kind: 'PQ' },
    position: { x: 0, y: 0 },
  });
  return [
    ...makeBusNodes(2).map((n) => ({ ...n, data: { ...n.data, kind: 'Bus' } })),
    unit('1', 'Slack', true),
    unit('2', 'PV', false),
    load('PQ_0'),
    load('PQ_1'),
  ];
}

/** Two buses, a generator and a load: a case with no dynamic models. */
function makeStaticDiagram(): typeof mockNodes {
  return [
    ...makeBusNodes(2).map((n) => ({ ...n, data: { ...n.data, kind: 'Bus' } })),
    {
      id: 'generator-1',
      type: 'generator',
      data: { idx: '1', name: '1', kind: 'Slack' },
      position: { x: 0, y: 0 },
    },
    {
      id: 'load-PQ_0',
      type: 'load',
      data: { idx: 'PQ_0', name: 'PQ_0', kind: 'PQ' },
      position: { x: 0, y: 0 },
    },
  ];
}

/** What each listed row says it is, in the order listed. */
function rowTags(): string[] {
  return screen.getAllByTestId('sld-node-search-tag').map((tag) => tag.textContent ?? '');
}

/** The text of each filter button, in the order shown. */
function filterTexts(): string[] {
  return [...screen.getByTestId('sld-node-search-filters').querySelectorAll('button')].map(
    (button) => button.textContent ?? '',
  );
}

describe('SldNodeSearch — by kind', () => {
  beforeEach(() => {
    mockNodes = makeDynamicDiagram();
  });

  it('says what each row is, and lists the rows of a kind together', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    expect(rowTags()).toEqual([
      'Bus',
      'Bus',
      'GeneratorSlack',
      'GeneratorPV',
      'LoadPQ',
      'LoadPQ',
      'MachineGENROU',
      'MachineGENROU',
      'ExciterEXST1',
      'GovernorTGOV1',
      'GovernorTGOV1',
    ]);
  });

  it('finds the controllers by what they are, whatever they are called', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const input = screen.getByTestId('sld-node-search-input');

    // No name has the word in it: two governors are both `TGOV1_1`.
    await user.type(input, 'governor');
    expect(rowTags()).toEqual(['GovernorTGOV1', 'GovernorTGOV1']);

    await user.clear(input);
    await user.type(input, 'Exciters');
    expect(rowTags()).toEqual(['ExciterEXST1']);

    // The letters its chip has on the symbol of the unit.
    await user.clear(input);
    await user.type(input, 'avr');
    expect(rowTags()).toEqual(['ExciterEXST1']);

    await user.clear(input);
    await user.type(input, 'controller');
    expect(rowTags()).toEqual(['ExciterEXST1', 'GovernorTGOV1', 'GovernorTGOV1']);

    // A generator is its static generator and its machine.
    await user.clear(input);
    await user.type(input, 'generator');
    expect(rowTags()).toEqual(['GeneratorSlack', 'GeneratorPV', 'MachineGENROU', 'MachineGENROU']);
  });

  it('finds a row by its model class, and by several words at once', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    const input = screen.getByTestId('sld-node-search-input');

    await user.type(input, 'slack');
    expect(rowTags()).toEqual(['GeneratorSlack']);

    // Every word has to be found: the governor of unit 2, not of unit 1.
    await user.clear(input);
    await user.type(input, 'gov 2');
    expect(rowTags()).toEqual(['GovernorTGOV1']);
    await user.keyboard('{Enter}');
    expect(useSldStore.getState().selectedNodeId).toBe('controller-TGOV1-2');
  });

  it('counts what the diagram has of each kind, and narrows the list to one at a press', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    expect(screen.getByRole('group', { name: 'Show only' })).toBeInTheDocument();
    expect(filterTexts()).toEqual([
      'All 11',
      'Buses 2',
      'Generators 2',
      'Loads 2',
      'Machines 2',
      'Exciters 1',
      'Governors 2',
    ]);
    const all = screen.getByTestId('sld-node-search-filter-all');
    const governors = screen.getByTestId('sld-node-search-filter-governor');
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(governors).toHaveAttribute('aria-pressed', 'false');

    await user.click(governors);
    expect(governors).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
    expect(rowTags()).toEqual(['GovernorTGOV1', 'GovernorTGOV1']);
    expect(screen.getByTestId('sld-node-search-count')).toHaveTextContent('2 matches');

    // A second press shows every row again, and so does All.
    await user.click(governors);
    expect(rowTags()).toHaveLength(11);
    await user.click(governors);
    await user.click(all);
    expect(rowTags()).toHaveLength(11);
  });

  it('counts on the buttons what the words typed find', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.type(screen.getByTestId('sld-node-search-input'), 'controller');
    expect(filterTexts()).toEqual([
      'All 3',
      'Buses 0',
      'Generators 0',
      'Loads 0',
      'Machines 0',
      'Exciters 1',
      'Governors 2',
    ]);
  });

  it('offers the rows of other kinds when the words typed find none of the kind picked', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.click(screen.getByTestId('sld-node-search-filter-governor'));
    await user.type(screen.getByTestId('sld-node-search-input'), 'genrou');
    expect(screen.getByTestId('sld-node-search-empty')).toHaveTextContent('No governors match');
    // No list without rows: the sentence and its button are not options.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show the 2 matches of other kinds' }));
    expect(rowTags()).toEqual(['MachineGENROU', 'MachineGENROU']);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('starts from every row again after a pick', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.click(screen.getByTestId('sld-node-search-filter-exciter'));
    await user.click(screen.getByTestId('sld-node-search-row-1'));
    expect(useSldStore.getState().selectedNodeId).toBe('controller-EXST1-1');

    await openPopover(user);
    expect(screen.getByTestId('sld-node-search-filter-all')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(rowTags()).toHaveLength(11);
  });

  it('says which dynamic models the diagram has when it has none of the kind looked for', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.type(screen.getByTestId('sld-node-search-input'), 'pss');
    expect(screen.getByTestId('sld-node-search-none-in-case')).toHaveTextContent(
      'The diagram has no PSS. Its dynamic models: 2 machines, 1 exciter and 2 governors.',
    );
  });

  it('says that a line is not in the list', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.type(screen.getByTestId('sld-node-search-input'), 'transformer');
    expect(screen.getByTestId('sld-node-search-none-in-case')).toHaveTextContent(
      'Lines and transformers are not in this list: click one on the diagram to select it.',
    );
  });

  it('says what can be typed when the words name nothing', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.type(screen.getByTestId('sld-node-search-input'), 'zzz');
    const empty = screen.getByTestId('sld-node-search-empty');
    expect(empty).toHaveTextContent('No nodes match');
    expect(empty).toHaveTextContent(
      'Type part of a name, an idx or a model, or a kind such as bus, generator or load.',
    );
    expect(screen.queryByTestId('sld-node-search-none-in-case')).not.toBeInTheDocument();
  });
});

describe('SldNodeSearch — a case with no dynamic models', () => {
  beforeEach(() => {
    mockNodes = makeStaticDiagram();
  });

  it('has a button for each kind it has, and none for a controller', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    expect(filterTexts()).toEqual(['All 4', 'Buses 2', 'Generators 1', 'Loads 1']);
  });

  it.each(['exciter', 'governors', 'controller', 'machine', 'avr'])(
    'says that the case is static-only to a look for "%s"',
    async (query) => {
      const user = userEvent.setup();
      render(<SldNodeSearch />);
      await openPopover(user);
      await user.type(screen.getByTestId('sld-node-search-input'), query);
      expect(screen.getByTestId('sld-node-search-none-in-case')).toHaveTextContent(
        'This case is static-only: it has no machines, exciters, governors or other dynamic models.',
      );
    },
  );

  it('says of a static kind only that the diagram has none', async () => {
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.type(screen.getByTestId('sld-node-search-input'), 'shunt');
    expect(screen.getByTestId('sld-node-search-none-in-case')).toHaveTextContent(
      /^The diagram has no shunts\.$/,
    );
  });
});

describe('SldNodeSearch — filter buttons', () => {
  it('has none when every row is of one kind', async () => {
    mockNodes = makeBusNodes(3);
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    expect(screen.queryByTestId('sld-node-search-filters')).not.toBeInTheDocument();
  });

  it('shows every row when the kind it was narrowed to is gone from the diagram', async () => {
    mockNodes = makeDynamicDiagram();
    const user = userEvent.setup();
    render(<SldNodeSearch />);
    await openPopover(user);
    await user.click(screen.getByTestId('sld-node-search-filter-exciter'));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('sld-node-search-input')).not.toBeInTheDocument();

    // Another case is opened, one with no exciter.
    mockNodes = makeStaticDiagram();
    await openPopover(user);
    expect(rowTags()).toHaveLength(4);
    expect(screen.getByTestId('sld-node-search-filter-all')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
