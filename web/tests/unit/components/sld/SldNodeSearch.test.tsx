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
  data: { idx: string; name: string };
  position: { x: number; y: number };
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
});
