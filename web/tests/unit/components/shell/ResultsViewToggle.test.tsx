/**
 * Tests for `<ResultsViewToggle />` (v3.1).
 *
 * Mirrors the `<SidebarToggle />` / `<InspectorToggle />` shape — flips
 * ``useLayoutStore.resultsViewActive``. The glyph swaps between a
 * maximize affordance (results view off) and a minimize affordance
 * (results view on); the active state surfaces via aria-pressed +
 * data-active so the TopBar pane-toggle group reads consistently.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResultsViewToggle } from '@/components/shell/ResultsViewToggle';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('<ResultsViewToggle />', () => {
  it('renders with testid + accessible label + aria-pressed', () => {
    render(<ResultsViewToggle />);
    const btn = screen.getByTestId('top-bar-toggle-results-view');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label');
    expect(btn).toHaveAttribute('aria-pressed');
  });

  it('renders the maximize affordance when results view is off', () => {
    useLayoutStore.setState({ resultsViewActive: false });
    render(<ResultsViewToggle />);
    expect(
      screen.getByTestId('top-bar-toggle-results-view-icon-maximize'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('top-bar-toggle-results-view-icon-minimize'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-results-view')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('renders the minimize affordance when results view is on', () => {
    useLayoutStore.setState({ resultsViewActive: true });
    render(<ResultsViewToggle />);
    expect(
      screen.getByTestId('top-bar-toggle-results-view-icon-minimize'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('top-bar-toggle-results-view-icon-maximize'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-results-view')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('clicking flips resultsViewActive; second click flips it back', async () => {
    const user = userEvent.setup();
    render(<ResultsViewToggle />);
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);

    await user.click(screen.getByTestId('top-bar-toggle-results-view'));
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);

    await user.click(screen.getByTestId('top-bar-toggle-results-view'));
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);
  });

  it('exposes the active state via data-active', () => {
    useLayoutStore.setState({ resultsViewActive: true });
    render(<ResultsViewToggle />);
    expect(screen.getByTestId('top-bar-toggle-results-view')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('does NOT touch bottomDrawerCollapsed when clicked', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    render(<ResultsViewToggle />);
    await user.click(screen.getByTestId('top-bar-toggle-results-view'));
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);
  });
});
