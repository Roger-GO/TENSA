/**
 * Tests for ``<BottomDrawer />`` (v3 Unit 11).
 *
 * Coverage:
 *
 *  - Renders the 12 outer tabs with their canonical testids.
 *  - Tab click switches activeBottomDrawerTab in useLayoutStore AND
 *    clears drawerHasUnreadResults.
 *  - When ``bottomDrawerCollapsed === true`` only the strip renders;
 *    no tab content is mounted.
 *  - Clicking a tab while collapsed expands the drawer AND switches
 *    to that tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useAnalyzeStore } from '@/store/analyze';
import { usePflowStore } from '@/store/pflow';
import { useMessagesStore } from '@/store/messages';
import type { PflowResult, SessionMessage, TopologySummary } from '@/api/types';
import { LIMITS_TOPOLOGY, limitsPflow } from '../../helpers/limitsCase';

// A lazily loaded panel's chunk is imported and transformed the first time a
// test shows it, which on a loaded machine takes longer than the default wait.
const COLD_LOAD_MS = 15_000;

// useCurrentTopology is read by the per-bucket grids that BottomDrawer
// mounts. Stub it to a deterministic empty topology so the grids
// render their empty-state branch without exercising query plumbing.
let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

// The Plot sub-tab pulls TimeSeriesPlot which depends on uPlot —
// stub the heavy chart components so the BottomDrawer test stays
// focused on the chassis. Same pattern that other shell tests use
// for AnalyzePanel children.
vi.mock('@/components/plots/TimeSeriesPlot', () => ({
  TimeSeriesPlot: () => <div data-testid="ts-plot-stub" />,
}));
vi.mock('@/components/plots/ScrubControl', () => ({
  ScrubControl: () => <div data-testid="scrub-stub" />,
}));
vi.mock('@/components/plots/VariableTreePicker', () => ({
  VariableTreePicker: () => <div data-testid="var-picker-stub" />,
}));
// Same for the analyze sub-modes — they fetch via TanStack Query +
// hit the eig/cpf/se endpoints. Stub them to inert markers.
vi.mock('@/components/analyze/AnalyzePanel', () => ({
  AnalyzeEigSubMode: () => <div data-testid="analyze-eig-stub" />,
  AnalyzeCpfSubMode: () => <div data-testid="analyze-cpf-stub" />,
  AnalyzeSeSubMode: () => <div data-testid="analyze-se-stub" />,
}));
vi.mock('@/components/pflow/PflowPanel', () => ({
  PflowPanel: () => <div data-testid="pflow-panel-stub" />,
}));
vi.mock('@/components/tds/TdsConfigPanel', () => ({
  TdsConfigPanel: () => <div data-testid="tds-config-stub" />,
}));
vi.mock('@/components/tds/RunStatusBadge', () => ({
  RunStatusBadge: () => <div data-testid="tds-status-stub" />,
}));

import { BottomDrawer } from '@/components/shell/BottomDrawer';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

/** A power flow solved on the open case, as the pflow slice holds one. */
function solve(result: PflowResult): void {
  usePflowStore.setState({ lastRun: result, lastSolved: result });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useAnalyzeStore.setState({ subMode: 'eig' });
  usePflowStore.setState({ lastRun: null, lastSolved: null, isRunning: false, error: null });
  useMessagesStore.getState().reset();
  mockTopology = null;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  usePflowStore.setState({ lastRun: null, lastSolved: null, isRunning: false, error: null });
  useMessagesStore.getState().reset();
});

describe('<BottomDrawer />', () => {
  it('renders all 12 outer tabs', () => {
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('bottom-drawer')).toBeInTheDocument();
    for (const tab of [
      'buses',
      'lines',
      'generators',
      'loads',
      'shunts',
      'machines',
      'exciters',
      'governors',
      'violations',
      'analysis',
      'activity',
      'messages',
    ]) {
      expect(screen.getByTestId(`bottom-drawer-tab-${tab}`)).toBeInTheDocument();
    }
  });

  it('renders a group divider before the Analysis tab (grids | tools split)', () => {
    render(<BottomDrawer />, { wrapper });
    const divider = screen.getByTestId('bottom-drawer-tab-group-divider');
    expect(divider).toBeInTheDocument();
    // Exactly one divider — it splits the element grids, the dynamic-model
    // tables and the violations list from the Analysis | Activity | Messages tools group.
    expect(screen.getAllByTestId('bottom-drawer-tab-group-divider')).toHaveLength(1);
    // The divider must sit immediately before the Analysis trigger in DOM
    // order (the grids read as one group, Analysis|Activity|Messages as the next).
    const analysisTab = screen.getByTestId('bottom-drawer-tab-analysis');
    expect(
      divider.compareDocumentPosition(analysisTab) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const violationsTab = screen.getByTestId('bottom-drawer-tab-violations');
    expect(
      violationsTab.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders + selects the Activity tab', async () => {
    const user = userEvent.setup();
    render(<BottomDrawer />, { wrapper });
    const activityTab = screen.getByTestId('bottom-drawer-tab-activity');
    expect(activityTab).toBeInTheDocument();

    await user.click(activityTab);
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('activity');
    // The Activity panel content mounts (it renders the sub-tab strip). The
    // panel is a lazily loaded chunk.
    expect(screen.getByTestId('bottom-drawer-tab-content-activity')).toBeInTheDocument();
    expect(
      await screen.findByTestId('activity-panel-subtab-active', undefined, {
        timeout: COLD_LOAD_MS,
      }),
    ).toBeInTheDocument();
  });

  it('clicking a tab switches activeBottomDrawerTab', async () => {
    const user = userEvent.setup();
    render(<BottomDrawer />, { wrapper });
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('buses');

    await user.click(screen.getByTestId('bottom-drawer-tab-lines'));
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('lines');

    await user.click(screen.getByTestId('bottom-drawer-tab-analysis'));
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('analysis');
  });

  it('clicking a tab clears drawerHasUnreadResults', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ drawerHasUnreadResults: true });
    render(<BottomDrawer />, { wrapper });
    await user.click(screen.getByTestId('bottom-drawer-tab-generators'));
    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(false);
  });

  it('when collapsed renders only the tab strip (no content)', () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('bottom-drawer')).toHaveAttribute('data-collapsed', 'true');
    // The strip itself is present.
    expect(screen.getByTestId('bottom-drawer-tab-buses')).toBeInTheDocument();
    // The active tab content (Buses by default) is NOT mounted.
    expect(screen.queryByTestId('bottom-drawer-tab-content-buses')).not.toBeInTheDocument();
  });

  it('clicking a tab while collapsed expands AND switches', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ bottomDrawerCollapsed: true, activeBottomDrawerTab: 'buses' });
    render(<BottomDrawer />, { wrapper });
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);

    await user.click(screen.getByTestId('bottom-drawer-tab-shunts'));
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('shunts');
  });

  it('when expanded mounts the active tab content', () => {
    useLayoutStore.setState({ activeBottomDrawerTab: 'buses' });
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('bottom-drawer-tab-content-buses')).toBeInTheDocument();
  });

  it('mounts the element tables (a lazily loaded chunk) when one is the active tab', async () => {
    useLayoutStore.setState({ activeBottomDrawerTab: 'buses', bottomDrawerCollapsed: false });
    const { unmount } = render(<BottomDrawer />, { wrapper });
    // The wrapper is there at once; the table arrives with its chunk.
    expect(screen.getByTestId('bottom-drawer-tab-content-buses')).toBeInTheDocument();
    expect(await screen.findByTestId('buses-grid-empty')).toBeInTheDocument();
    unmount();

    useLayoutStore.setState({ activeBottomDrawerTab: 'shunts' });
    render(<BottomDrawer />, { wrapper });
    expect(await screen.findByTestId('shunts-grid-empty')).toBeInTheDocument();
  });

  it('mounts the tables of the dynamic models (the same lazily loaded chunk) when one is the active tab', async () => {
    for (const tab of ['machines', 'exciters', 'governors'] as const) {
      useLayoutStore.setState({ activeBottomDrawerTab: tab, bottomDrawerCollapsed: false });
      const { unmount } = render(<BottomDrawer />, { wrapper });
      expect(screen.getByTestId(`bottom-drawer-tab-content-${tab}`)).toBeInTheDocument();
      expect(await screen.findByTestId(`${tab}-grid-empty`)).toHaveTextContent(
        `Load a case to see ${tab}.`,
      );
      unmount();
    }
  });

  it('mounts the analysis tab (a lazily loaded chunk) when it is the active tab', async () => {
    useLayoutStore.setState({ activeBottomDrawerTab: 'analysis', bottomDrawerCollapsed: false });
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('bottom-drawer-tab-content-analysis')).toBeInTheDocument();
    expect(await screen.findByTestId('analysis-tab')).toBeInTheDocument();
  });
});

describe('<BottomDrawer /> PF sub-tab', () => {
  it('mounts the PF panel when the PF sub-tab is active, and leaves the analyze sub-mode alone', async () => {
    useLayoutStore.setState({
      activeBottomDrawerTab: 'analysis',
      activeAnalysisSubTab: 'pf',
      bottomDrawerCollapsed: false,
    });
    render(<BottomDrawer />, { wrapper });
    expect(await screen.findByTestId('pflow-panel-stub')).toBeInTheDocument();
    // `pf` is a layout tab only: the Analyze slice keeps what it had.
    expect(useAnalyzeStore.getState().subMode).toBe('eig');
  });

  it('clicking the PF sub-tab writes the layout and not the analyze sub-mode', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({
      activeBottomDrawerTab: 'analysis',
      activeAnalysisSubTab: 'plot',
      bottomDrawerCollapsed: false,
    });
    render(<BottomDrawer />, { wrapper });
    await user.click(await screen.findByTestId('analysis-sub-tab-pf'));
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('pf');
    expect(useAnalyzeStore.getState().subMode).toBe('eig');
    expect(await screen.findByTestId('pflow-panel-stub')).toBeInTheDocument();
  });

  it('clicking an analyze-backed sub-tab still writes both, as before', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({
      activeBottomDrawerTab: 'analysis',
      activeAnalysisSubTab: 'pf',
      bottomDrawerCollapsed: false,
    });
    render(<BottomDrawer />, { wrapper });
    await user.click(await screen.findByTestId('analysis-sub-tab-cpf'));
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('cpf');
    expect(useAnalyzeStore.getState().subMode).toBe('cpf');
  });
});

describe('<BottomDrawer /> Violations tab', () => {
  it('mounts the violations table (a lazily loaded chunk) when it is the active tab', async () => {
    useLayoutStore.setState({ activeBottomDrawerTab: 'violations', bottomDrawerCollapsed: false });
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('bottom-drawer-tab-content-violations')).toBeInTheDocument();
    expect(await screen.findByTestId('violations-grid-empty')).toBeInTheDocument();
  });

  it('shows no count before a power flow has converged', () => {
    mockTopology = LIMITS_TOPOLOGY;
    render(<BottomDrawer />, { wrapper });
    expect(screen.queryByTestId('violations-tab-count')).not.toBeInTheDocument();
    cleanup();
    solve(limitsPflow({ converged: false }));
    render(<BottomDrawer />, { wrapper });
    expect(screen.queryByTestId('violations-tab-count')).not.toBeInTheDocument();
  });

  it('counts the violations beside the tab name, in red, once a power flow has converged', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    render(<BottomDrawer />, { wrapper });
    const count = screen.getByTestId('violations-tab-count');
    expect(count).toHaveTextContent('4');
    expect(count).toHaveAttribute('data-severity', 'violation');
    expect(count).toHaveAttribute('title', '4 violations');
    expect(screen.getByTestId('bottom-drawer-tab-violations')).toContainElement(count);
  });

  it('keeps the count of the power flow after a time-domain run has replaced the latest result', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    // The operating point a run ends at: converged, bus voltages only.
    usePflowStore.setState({
      lastRun: limitsPflow({
        bus_voltages: { '1': 1.0, '2': 1.0, '3': 1.0 },
        line_flows: undefined,
        generator_outputs: undefined,
      }),
    });
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('violations-tab-count')).toHaveTextContent('4');
  });

  it('counts the warnings instead, in amber, when there are only warnings', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(
      limitsPflow({
        bus_voltages: { '1': 1.0, '2': 0.915, '3': 1.0 },
        line_flows: {},
        generator_outputs: { '2': { p: 10, q: 15, v: 1.0, bus: 2, q_min: -50, q_max: 15 } },
      }),
    );
    render(<BottomDrawer />, { wrapper });
    const count = screen.getByTestId('violations-tab-count');
    expect(count).toHaveTextContent('2');
    expect(count).toHaveAttribute('data-severity', 'warning');
    expect(count).toHaveAttribute('title', '2 warnings');
  });

  it('shows no count when every limit holds, and follows the next run', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(
      limitsPflow({
        bus_voltages: { '1': 1.0, '2': 1.0, '3': 1.0 },
        line_flows: {},
        generator_outputs: {},
      }),
    );
    render(<BottomDrawer />, { wrapper });
    expect(screen.queryByTestId('violations-tab-count')).not.toBeInTheDocument();
  });

  it('keeps the tab reachable while the drawer is collapsed', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    render(<BottomDrawer />, { wrapper });
    await user.click(screen.getByTestId('bottom-drawer-tab-violations'));
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('violations');
  });
});

describe('<BottomDrawer /> Messages tab', () => {
  function logged(...levels: SessionMessage['level'][]): void {
    useMessagesStore.getState().receive('sess-1', {
      messages: levels.map((level, i) => ({
        seq: i + 1,
        time: 1_700_000_000,
        level,
        logger: 'andes.test',
        source: 'run_pflow',
        text: `${level} ${i + 1}`,
        repeat: 1,
      })),
      first_seq: 1,
      last_seq: levels.length,
      next_after: levels.length,
      dropped: 0,
    });
  }

  it('mounts the messages panel (a lazily loaded chunk) when it is the active tab', async () => {
    useLayoutStore.setState({ activeBottomDrawerTab: 'messages', bottomDrawerCollapsed: false });
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('bottom-drawer-tab-content-messages')).toBeInTheDocument();
    // A placeholder stands in while the chunk loads.
    expect(screen.getByTestId('lazy-loading')).toBeInTheDocument();
    expect(
      await screen.findByTestId('messages-panel', undefined, { timeout: COLD_LOAD_MS }),
    ).toBeInTheDocument();
  });

  it('opens on a click of its tab', async () => {
    const user = userEvent.setup();
    render(<BottomDrawer />, { wrapper });
    await user.click(screen.getByTestId('bottom-drawer-tab-messages'));
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('messages');
    expect(
      await screen.findByTestId('messages-panel', undefined, { timeout: COLD_LOAD_MS }),
    ).toBeInTheDocument();
  });

  it('shows no count while ANDES has logged nothing worse than information', () => {
    render(<BottomDrawer />, { wrapper });
    expect(screen.queryByTestId('messages-tab-count')).not.toBeInTheDocument();
    cleanup();
    logged('info', 'info');
    render(<BottomDrawer />, { wrapper });
    expect(screen.queryByTestId('messages-tab-count')).not.toBeInTheDocument();
  });

  it('counts the warnings beside the tab name, in amber', () => {
    logged('info', 'warning', 'warning');
    render(<BottomDrawer />, { wrapper });
    const count = screen.getByTestId('messages-tab-count');
    expect(count).toHaveTextContent('2');
    expect(count).toHaveAttribute('data-severity', 'warning');
    expect(count).toHaveAttribute('title', '2 warnings');
    expect(screen.getByTestId('bottom-drawer-tab-messages')).toContainElement(count);
  });

  it('counts warnings and errors together, in red, once there is an error', () => {
    logged('warning', 'error', 'info');
    render(<BottomDrawer />, { wrapper });
    const count = screen.getByTestId('messages-tab-count');
    expect(count).toHaveTextContent('2');
    expect(count).toHaveAttribute('data-severity', 'error');
    expect(count).toHaveAttribute('title', '1 error, 1 warning');
  });

  it('keeps the count in view while the drawer is collapsed', () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    logged('error');
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('messages-tab-count')).toHaveTextContent('1');
  });
});
