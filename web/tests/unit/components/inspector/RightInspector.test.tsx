/**
 * Tests for ``<RightInspector />`` (v3 Unit 7).
 *
 * Covers:
 *   - Header reads "Bus <name>" when a bus is selected.
 *   - All three accordion sections render (Properties / Plots /
 *     Disturbances).
 *   - Clicking a section trigger toggles its open state.
 *   - Per-element-kind open-state persists across selections via
 *     localStorage under
 *     ``tensa:layout-v1:rightInspector:openSections:<kind>``.
 *   - The header's delete button: there for the element shown, and
 *     greyed out with the reason once the case is set up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { useDraftsStore } from '@/store/drafts';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useRunsStore } from '@/store/runs';
import { useDisturbanceStore } from '@/store/disturbance';
import { useSessionStore } from '@/store/session';
import { toast } from '@/lib/toast';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => mockTopology,
    useTopologySchema: () => ({ data: undefined }),
    useReloadCase: () => ({ mutate: () => {}, isPending: false }),
  };
});

import { RightInspector } from '@/components/inspector/RightInspector';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 5, name: 'BUS_5', kind: 'Bus', params: { Vn: 138 } },
    { idx: 7, name: 'BUS_7', kind: 'Bus', params: { Vn: 138 } },
  ],
  lines: [],
  transformers: [],
  generators: [{ idx: 'G1', name: 'GEN_1', kind: 'PV', params: { bus: 5, p0: 200 } }],
  loads: [],
};

function seedLoadedCase() {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    layoutSidecar: null,
    selectedElement: null,
  });
  mockTopology = TOPOLOGY;
}

beforeEach(() => {
  window.localStorage.clear();
  mockTopology = null;
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  useDisturbanceStore.getState().clearDisturbances();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  mockTopology = null;
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  useDisturbanceStore.getState().clearDisturbances();
});

describe('<RightInspector /> with a draft picked', () => {
  const draft = { id: 'draft-1', kind: 'PQ', position: { x: 0, y: 0 }, values: {} };

  beforeEach(() => {
    seedLoadedCase();
    useDraftsStore.setState({ byCase: { 'ieee14.raw': [draft] }, placements: {} });
    useSldStore.getState().setSelectedNodeId('draft-1', 'diagram');
  });
  afterEach(() => {
    useDraftsStore.setState({ byCase: {}, placements: {} });
    useSldStore.getState().clearSelectedNodeId();
  });

  it('shows the form of the draft in the place of everything else', () => {
    render(withQueryClient(<RightInspector />));
    expect(screen.getByTestId('draft-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('draft-inspector-header')).toHaveTextContent('PQ load');
    expect(screen.queryByTestId('right-inspector')).toBeNull();
  });

  it('shows an element that was selected after it, whatever the diagram still has picked', () => {
    // Inspect in the right-click menu of a line selects the line and leaves
    // the node the diagram had picked.
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<RightInspector />));
    expect(screen.queryByTestId('draft-inspector')).toBeNull();
    expect(screen.getByTestId('right-inspector-header')).toHaveTextContent('BUS_5');
  });

  it('goes back to nothing selected once the draft is gone', () => {
    useDraftsStore.setState({ byCase: {} });
    render(withQueryClient(<RightInspector />));
    expect(screen.queryByTestId('draft-inspector')).toBeNull();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('shows nothing of a draft of another case that has the same id', () => {
    useDraftsStore.setState({ byCase: { 'other.raw': [draft] } });
    render(withQueryClient(<RightInspector />));
    expect(screen.queryByTestId('draft-inspector')).toBeNull();
  });
});

describe('<RightInspector />', () => {
  it('shows EmptyState when nothing is selected', () => {
    render(withQueryClient(<RightInspector />));
    expect(screen.getByTestId('right-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders header + 3 sections when a bus is selected', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<RightInspector />));
    const header = screen.getByTestId('right-inspector-header');
    expect(header.textContent).toContain('Bus');
    expect(header.textContent).toContain('BUS_5');
    expect(screen.getByTestId('right-inspector-accordion')).toBeInTheDocument();
    expect(screen.getByTestId('right-inspector-section-properties')).toBeInTheDocument();
    expect(screen.getByTestId('right-inspector-section-plots')).toBeInTheDocument();
    expect(screen.getByTestId('right-inspector-section-disturbances')).toBeInTheDocument();
  });

  it('has the delete button for the element it shows, named for what the element is', async () => {
    const user = userEvent.setup();
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    render(withQueryClient(<RightInspector />));
    const button = screen.getByTestId('delete-element-button');
    // The request names the ANDES model of the entry, the text the kind shown.
    expect(button).toHaveAttribute('aria-label', 'Delete generator G1');
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.click(button);
    expect(screen.getByTestId('delete-element-dialog')).toHaveTextContent('Delete generator G1?');
  });

  it('keeps the delete button in place after a run, greyed out, saying the run has to be reset', async () => {
    const user = userEvent.setup();
    seedLoadedCase();
    mockTopology = { ...TOPOLOGY, state: 'committed' };
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<RightInspector />));
    const button = screen.getByTestId('delete-element-button');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.getAttribute('title')).toMatch(/Reset the run to delete this one/);
    await user.click(button);
    expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
  });

  it('holds the delete while a power flow is running', () => {
    seedLoadedCase();
    usePflowStore.setState({ isRunning: true });
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<RightInspector />));
    const button = screen.getByTestId('delete-element-button');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.getAttribute('title')).toMatch(/power flow is running/);
  });

  it('says what was deleted although the delete takes the button away with the selection', async () => {
    // The delete clears the selection, the header goes, and the button with it.
    // What it does after the answer must not depend on it still being there.
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { generators: _generators, ...rest } = TOPOLOGY;
    const fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ ...rest, generators: [], deleted: TOPOLOGY.generators }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
    seedLoadedCase();
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    render(withQueryClient(<RightInspector />));

    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(useCaseStore.getState().selectedElement).toBeNull());
    expect(screen.queryByTestId('delete-element-button')).toBeNull();
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith('Deleted PV G1', {
        description: 'Undo in the Edit menu brings it back.',
      }),
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/sessions/sess-1/elements/PV/G1');
    fetchSpy.mockRestore();
    success.mockRestore();
    useSessionStore.setState({ sessionId: null });
  });

  it('has no delete button for a selection the case no longer holds', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '99' } });
    render(withQueryClient(<RightInspector />));
    expect(screen.getByTestId('right-inspector-header')).toBeInTheDocument();
    expect(screen.queryByTestId('delete-element-button')).toBeNull();
  });

  it('Properties opens by default; clicking Plots trigger reveals plots-accordion', async () => {
    const user = userEvent.setup();
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<RightInspector />));
    // Properties starts open → properties-accordion mounted.
    expect(screen.getByTestId('properties-accordion')).toBeInTheDocument();
    // Plots starts closed → plots-accordion not in the DOM tree.
    expect(screen.queryByTestId('plots-accordion')).toBeNull();
    await user.click(screen.getByTestId('right-inspector-section-trigger-plots'));
    expect(screen.getByTestId('plots-accordion')).toBeInTheDocument();
  });

  it('persists per-kind open state across selections', async () => {
    const user = userEvent.setup();
    seedLoadedCase();
    // Bus selection → user opens Plots in addition to Properties.
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    const { unmount } = render(withQueryClient(<RightInspector />));
    await user.click(screen.getByTestId('right-inspector-section-trigger-plots'));
    expect(
      window.localStorage.getItem('tensa:layout-v1:rightInspector:openSections:bus'),
    ).toContain('plots');
    unmount();

    // Switch to a generator selection — the bus-specific persisted state
    // should NOT carry over (separate kind, separate slot).
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    render(withQueryClient(<RightInspector />));
    // Generator has no persisted state → defaults to properties only.
    expect(screen.queryByTestId('plots-accordion')).toBeNull();

    // Now back to a bus — should restore the persisted-with-plots-open
    // state.
    cleanup();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '7' } });
    render(withQueryClient(<RightInspector />));
    expect(screen.getByTestId('plots-accordion')).toBeInTheDocument();
  });
});
