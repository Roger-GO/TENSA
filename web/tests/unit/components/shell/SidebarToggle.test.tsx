/**
 * Tests for `<SidebarToggle />` (v3 Unit 2).
 *
 * The toggle is a thin shell over ``useLayoutStore.toggleLeftSidebar``.
 * Tests assert:
 *  - Renders with the correct testid + accessibility attributes.
 *  - Icon swaps direction based on collapsed state.
 *  - Click flips ``useLayoutStore.leftSidebarCollapsed``; second click
 *    flips it back.
 *  - Toggling sidebar does NOT affect ``drawerHasUnreadResults``.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SidebarToggle } from '@/components/shell/SidebarToggle';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('<SidebarToggle />', () => {
  it('renders with testid + accessible label', () => {
    render(<SidebarToggle />);
    const btn = screen.getByTestId('top-bar-toggle-sidebar');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label');
    expect(btn).toHaveAttribute('aria-pressed');
  });

  it('renders the collapse-affordance chevron when sidebar is expanded', () => {
    useLayoutStore.setState({ leftSidebarCollapsed: false });
    render(<SidebarToggle />);
    expect(screen.getByTestId('top-bar-toggle-sidebar-icon-collapse')).toBeInTheDocument();
    expect(screen.queryByTestId('top-bar-toggle-sidebar-icon-expand')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-sidebar')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the expand-affordance chevron when sidebar is collapsed', () => {
    useLayoutStore.setState({ leftSidebarCollapsed: true });
    render(<SidebarToggle />);
    expect(screen.getByTestId('top-bar-toggle-sidebar-icon-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('top-bar-toggle-sidebar-icon-collapse')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-sidebar')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking flips leftSidebarCollapsed; second click flips it back', async () => {
    const user = userEvent.setup();
    render(<SidebarToggle />);
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);

    await user.click(screen.getByTestId('top-bar-toggle-sidebar'));
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true);

    await user.click(screen.getByTestId('top-bar-toggle-sidebar'));
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);
  });

  it('exposes the collapsed state via data-collapsed', () => {
    useLayoutStore.setState({ leftSidebarCollapsed: true });
    render(<SidebarToggle />);
    expect(screen.getByTestId('top-bar-toggle-sidebar')).toHaveAttribute('data-collapsed', 'true');
  });

  it('does NOT mutate drawerHasUnreadResults when clicked', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ drawerHasUnreadResults: true });
    render(<SidebarToggle />);
    await user.click(screen.getByTestId('top-bar-toggle-sidebar'));
    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(true);
  });
});
