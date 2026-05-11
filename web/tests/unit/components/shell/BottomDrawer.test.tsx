/**
 * Tests for ``<BottomDrawer />`` (v3 Unit 11).
 *
 * Coverage:
 *
 *  - Renders the 6 outer tabs with their canonical testids.
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
import type { TopologySummary } from '@/api/types';

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

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useAnalyzeStore.setState({ subMode: 'eig' });
  mockTopology = null;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

describe('<BottomDrawer />', () => {
  it('renders all 6 outer tabs', () => {
    render(<BottomDrawer />, { wrapper });
    expect(screen.getByTestId('bottom-drawer')).toBeInTheDocument();
    for (const tab of ['buses', 'lines', 'generators', 'loads', 'shunts', 'analysis']) {
      expect(screen.getByTestId(`bottom-drawer-tab-${tab}`)).toBeInTheDocument();
    }
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
    expect(screen.getByTestId('bottom-drawer')).toHaveAttribute(
      'data-collapsed',
      'true',
    );
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
});
