/**
 * <HistoryDrawer /> tests (Unit 9, basic version).
 *
 * Covers:
 * - Toggle button enables / opens / closes the drawer.
 * - Empty state when no runs are retained.
 * - Lists runs in most-recent-first order.
 * - Pin/Unpin row actions update the overlay set.
 * - "Clear overlay" button reset overlayRunIds wholesale.
 *
 * Drives the real history + runs stores; uses Radix's Dialog (which
 * portals into document.body — Testing Library's screen.* finds the
 * portaled content fine).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toastInfoMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();

vi.mock('@/lib/toast', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    dismiss: vi.fn(),
  },
}));

import { HistoryDrawer, HistoryDrawerToggle } from '@/components/history/HistoryDrawer';
import { useRunsStore } from '@/store/runs';
import { useHistoryStore } from '@/store/history';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

function seedRun(runId: string, tf = 5) {
  useRunsStore.getState().startRun({ runId, tf, columnNames: ['Bus_1_v'] });
  useRunsStore.getState().markRunDone(runId, tf);
}

function seedSessionAndCase() {
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('cases/ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
}

describe('HistoryDrawerToggle', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
    useHistoryStore.getState().reset();
    seedSessionAndCase();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the History button and the run-count badge when runs exist', () => {
    seedRun('r1');
    seedRun('r2');
    render(<HistoryDrawerToggle />);
    const btn = screen.getByTestId('history-drawer-toggle');
    expect(btn).toHaveTextContent('History');
    expect(btn).toHaveTextContent('(2)');
  });

  it('clicking the toggle opens the drawer', async () => {
    const user = userEvent.setup();
    render(<HistoryDrawerToggle />);
    expect(useHistoryStore.getState().drawerOpen).toBe(false);
    await user.click(screen.getByTestId('history-drawer-toggle'));
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
  });

  it('clicking again closes the drawer', async () => {
    const user = userEvent.setup();
    useHistoryStore.setState({ drawerOpen: true });
    render(<HistoryDrawerToggle />);
    await user.click(screen.getByTestId('history-drawer-toggle'));
    expect(useHistoryStore.getState().drawerOpen).toBe(false);
  });
});

describe('HistoryDrawer', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
    });
    useHistoryStore.getState().reset();
    seedSessionAndCase();
    toastInfoMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('does NOT mount the drawer body while closed (deferred mount)', () => {
    render(<HistoryDrawer />);
    expect(screen.queryByTestId('history-drawer')).toBeNull();
  });

  it('renders an empty state when no runs are retained', () => {
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    expect(screen.getByTestId('history-drawer-empty')).toBeInTheDocument();
  });

  it('lists every retained run in most-recent-first order', () => {
    seedRun('r1');
    seedRun('r2');
    seedRun('r3');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    const list = screen.getByTestId('history-drawer-list');
    // Direct children only — nested test ids on swatches/buttons would
    // otherwise leak in via the [data-run-id] attribute filter.
    const rows = list.querySelectorAll('[data-testid="history-run-row-r1"], [data-testid="history-run-row-r2"], [data-testid="history-run-row-r3"]');
    // r3 first (most recent), r1 last.
    const ids = Array.from(rows).map((el) => el.getAttribute('data-run-id'));
    expect(ids).toEqual(['r3', 'r2', 'r1']);
  });

  it('pinning a row from the drawer updates the overlay set + fires toast.info', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-run-row-pin-r1'));
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
    // Per Unit 3 of the v2.0 polish plan: pin/unpin toasts route
    // through the global surface (sonner) rather than the in-drawer
    // alert div.
    expect(toastInfoMock).toHaveBeenCalledWith('Pinned to overlay');
    expect(screen.queryByTestId('history-drawer-toast')).toBeNull();
  });

  it('overlay count summary reflects how many runs are pinned', async () => {
    seedRun('r1');
    seedRun('r2');
    useRunsStore.getState().addOverlayRun('r1');
    useRunsStore.getState().addOverlayRun('r2');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    expect(screen.getByTestId('history-drawer-overlay-count')).toHaveTextContent(
      '2 pinned to overlay',
    );
  });

  it('Clear overlay button empties overlayRunIds + fires toast.info', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useRunsStore.getState().addOverlayRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-drawer-clear-overlay'));
    expect(useRunsStore.getState().overlayRunIds.size).toBe(0);
    expect(toastInfoMock).toHaveBeenCalledWith('Overlay cleared');
    expect(screen.queryByTestId('history-drawer-toast')).toBeNull();
  });

  it('reset row fires toast.info "Run dropped from history"', async () => {
    const user = userEvent.setup();
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    await user.click(screen.getByTestId('history-run-row-reset-r1'));
    expect(toastInfoMock).toHaveBeenCalledWith('Run dropped from history');
  });

  it('Clear overlay button is disabled when nothing is pinned', () => {
    seedRun('r1');
    useHistoryStore.getState().openDrawer();
    render(<HistoryDrawer />);
    const btn = screen.getByTestId('history-drawer-clear-overlay') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
