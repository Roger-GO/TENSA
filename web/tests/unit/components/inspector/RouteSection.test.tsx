/**
 * Tests for `<RouteSection />`.
 *
 * Under a selected line or transformer the section says how its route on
 * the diagram is drawn and has the two things to do about it: Move route by
 * hand asks the canvas for the handles of the line, and Reset route for the
 * automatic routing again. A button that can do nothing says why beside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RouteSection } from '@/components/inspector/RouteSection';
import { useCaseStore } from '@/store/case';
import type { SelectedElement } from '@/store/case';
import { subscribeRouteEdit, useSldStore } from '@/store/sld';

function select(selectedElement: SelectedElement | null) {
  useCaseStore.setState({ selectedElement });
}

afterEach(() => {
  cleanup();
  select(null);
  useSldStore.setState({ manualBranchIdxes: [], diagramLocked: false });
});

describe('<RouteSection />', () => {
  it('shows for a line and a transformer, and for nothing else', () => {
    select({ kind: 'bus', idx: '4' });
    const { rerender } = render(<RouteSection />);
    expect(screen.queryByTestId('route-section')).not.toBeInTheDocument();
    select({ kind: 'line', idx: 'Line_3' });
    rerender(<RouteSection />);
    expect(screen.getByRole('region', { name: 'Route on the diagram' })).toBeInTheDocument();
    select({ kind: 'transformer', idx: 'Line_17' });
    rerender(<RouteSection />);
    expect(screen.getByTestId('route-section')).toBeInTheDocument();
  });

  it('asks the diagram for the handles of the line, and says there is nothing to reset on a route the diagram drew', async () => {
    const user = userEvent.setup();
    const asked = vi.fn();
    const unsubscribe = subscribeRouteEdit(asked);
    select({ kind: 'line', idx: 'Line_3' });
    render(<RouteSection />);
    expect(screen.getByTestId('route-section-status')).toHaveTextContent('Routed automatically');
    expect(screen.getByRole('button', { name: 'Reset route' })).toBeDisabled();
    expect(screen.getByTestId('route-section-note')).toHaveTextContent(
      'The diagram drew this route, so there is nothing to reset.',
    );
    await user.click(screen.getByRole('button', { name: 'Move route by hand' }));
    expect(asked).toHaveBeenCalledWith('Line_3', 'edit');
    unsubscribe();
  });

  it('gives a route that was drawn by hand back to the diagram', async () => {
    const user = userEvent.setup();
    const asked = vi.fn();
    const unsubscribe = subscribeRouteEdit(asked);
    useSldStore.setState({ manualBranchIdxes: ['Line_3'] });
    select({ kind: 'line', idx: 'Line_3' });
    render(<RouteSection />);
    expect(screen.getByTestId('route-section-status')).toHaveTextContent('Routed by hand');
    await user.click(screen.getByRole('button', { name: 'Reset route' }));
    expect(asked).toHaveBeenCalledWith('Line_3', 'reset');
    // Another line is still the diagram's.
    unsubscribe();
    cleanup();
    select({ kind: 'line', idx: 'Line_4' });
    render(<RouteSection />);
    expect(screen.getByRole('button', { name: 'Reset route' })).toBeDisabled();
  });

  it('says that the diagram is locked, with both buttons off', () => {
    useSldStore.setState({ manualBranchIdxes: ['Line_3'], diagramLocked: true });
    select({ kind: 'line', idx: 'Line_3' });
    render(<RouteSection />);
    expect(screen.getByRole('button', { name: 'Move route by hand' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset route' })).toBeDisabled();
    expect(screen.getByTestId('route-section-note')).toHaveTextContent('The diagram is locked');
  });
});
