/**
 * Tests for ``<InFlightChip />`` (v3.1 Phase 3, Unit 11).
 *
 * Coverage:
 *  - 0 active jobs → renders nothing (hidden).
 *  - 1 active job → kind-aware label ("Running PF…").
 *  - ≥3 active jobs → "Running N jobs" + a hover tooltip listing each.
 *  - Clicking the chip opens the Activity panel (BottomDrawer → activity
 *    tab, expand, Active sub-tab).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useJobsStore } from '@/store/jobs';
import { InFlightChip } from '@/components/shell/InFlightChip';

function seedJob(rec: { id: string; kind?: string; status?: string; started_at?: number }) {
  const now = Date.now() / 1000;
  const full = {
    id: rec.id,
    kind: (rec.kind ?? 'pflow') as never,
    status: (rec.status ?? 'running') as never,
    started_at: rec.started_at ?? now,
    updated_at: now,
    can_cancel: false,
    request_summary: {},
    repeated_count: 1,
  };
  useJobsStore.setState((s) => ({ jobs: { ...s.jobs, [rec.id]: full as never } }));
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
});

describe('<InFlightChip />', () => {
  it('renders nothing when there are no active jobs', () => {
    const { container } = render(<InFlightChip />);
    expect(screen.queryByTestId('in-flight-chip')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores terminal jobs (still hidden)', () => {
    seedJob({ id: 'd1', status: 'done' });
    seedJob({ id: 'f1', status: 'failed' });
    render(<InFlightChip />);
    expect(screen.queryByTestId('in-flight-chip')).not.toBeInTheDocument();
  });

  it('shows a kind-aware label for a single active job', () => {
    seedJob({ id: 'j1', kind: 'pflow', status: 'running' });
    render(<InFlightChip />);
    expect(screen.getByTestId('in-flight-chip-label')).toHaveTextContent('Running PF…');
  });

  it('shows a kind-aware label for a single EIG job', () => {
    seedJob({ id: 'j1', kind: 'eig', status: 'running' });
    render(<InFlightChip />);
    expect(screen.getByTestId('in-flight-chip-label')).toHaveTextContent('Running EIG…');
  });

  it('collapses to "Running N jobs" with ≥3 active', () => {
    seedJob({ id: 'a', kind: 'pflow', status: 'running' });
    seedJob({ id: 'b', kind: 'eig', status: 'running' });
    seedJob({ id: 'c', kind: 'se', status: 'pending' });
    render(<InFlightChip />);
    expect(screen.getByTestId('in-flight-chip-label')).toHaveTextContent('Running 3 jobs');
    expect(screen.getByTestId('in-flight-chip')).toHaveAttribute('data-count', '3');
  });

  it('exposes a tooltip listing each job when ≥3 active', async () => {
    const user = userEvent.setup();
    seedJob({ id: 'a', kind: 'pflow', status: 'running' });
    seedJob({ id: 'b', kind: 'eig', status: 'running' });
    seedJob({ id: 'c', kind: 'se', status: 'pending' });
    render(<InFlightChip />);

    await user.hover(screen.getByTestId('in-flight-chip'));
    const tip = await screen.findByTestId('in-flight-chip-tooltip');
    expect(tip).toHaveTextContent('Power flow');
    expect(tip).toHaveTextContent('Eigenvalue analysis');
    expect(tip).toHaveTextContent('State estimation');
  });

  it('clicking the chip opens the Activity panel', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    seedJob({ id: 'j1', kind: 'pflow', status: 'running' });
    render(<InFlightChip />);

    await user.click(screen.getByTestId('in-flight-chip'));
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('activity');
    expect(layout.activityPanelTab).toBe('active');
    expect(layout.bottomDrawerCollapsed).toBe(false);
  });
});
