/**
 * Tests for `<BottomDrawerToggle />` (v3 Unit 2).
 *
 * Wraps ``useLayoutStore.toggleBottomDrawer`` AND
 * ``useLayoutStore.clearDrawerUnread``. Coverage:
 *
 *  - Renders with the correct testid + accessibility attributes.
 *  - Icon swaps direction based on collapsed state.
 *  - Click flips ``bottomDrawerCollapsed``; second click flips back.
 *  - Unread badge dot renders ONLY when ``drawerHasUnreadResults`` is
 *    true; clicking the toggle clears the badge.
 *  - Drawer toggle does NOT affect the sibling sidebar / inspector
 *    collapse bits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BottomDrawerToggle } from '@/components/shell/BottomDrawerToggle';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('<BottomDrawerToggle />', () => {
  it('renders with testid + accessible label', () => {
    render(<BottomDrawerToggle />);
    const btn = screen.getByTestId('top-bar-toggle-drawer');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label');
    expect(btn).toHaveAttribute('aria-pressed');
  });

  it('renders the collapse-affordance chevron when drawer is expanded', () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: false });
    render(<BottomDrawerToggle />);
    expect(screen.getByTestId('top-bar-toggle-drawer-icon-collapse')).toBeInTheDocument();
    expect(screen.queryByTestId('top-bar-toggle-drawer-icon-expand')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-drawer')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the expand-affordance chevron when drawer is collapsed', () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    render(<BottomDrawerToggle />);
    expect(screen.getByTestId('top-bar-toggle-drawer-icon-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('top-bar-toggle-drawer-icon-collapse')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-drawer')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking flips bottomDrawerCollapsed; second click flips it back', async () => {
    const user = userEvent.setup();
    render(<BottomDrawerToggle />);
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);

    await user.click(screen.getByTestId('top-bar-toggle-drawer'));
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(true);

    await user.click(screen.getByTestId('top-bar-toggle-drawer'));
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
  });

  it('does NOT render the unread dot when drawerHasUnreadResults is false', () => {
    useLayoutStore.setState({ drawerHasUnreadResults: false });
    render(<BottomDrawerToggle />);
    expect(screen.queryByTestId('top-bar-toggle-drawer-unread-dot')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-drawer')).toHaveAttribute('data-has-unread', 'false');
  });

  it('renders the unread dot when drawerHasUnreadResults is true', () => {
    useLayoutStore.setState({ drawerHasUnreadResults: true });
    render(<BottomDrawerToggle />);
    expect(screen.getByTestId('top-bar-toggle-drawer-unread-dot')).toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-drawer')).toHaveAttribute('data-has-unread', 'true');
  });

  it('clicking the toggle clears drawerHasUnreadResults', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({
      drawerHasUnreadResults: true,
      bottomDrawerCollapsed: true,
    });
    render(<BottomDrawerToggle />);
    expect(screen.getByTestId('top-bar-toggle-drawer-unread-dot')).toBeInTheDocument();

    await user.click(screen.getByTestId('top-bar-toggle-drawer'));

    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(false);
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
    expect(screen.queryByTestId('top-bar-toggle-drawer-unread-dot')).not.toBeInTheDocument();
  });

  it('does NOT mutate sidebar / inspector collapse when clicked', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({
      leftSidebarCollapsed: false,
      rightInspectorCollapsed: false,
    });
    render(<BottomDrawerToggle />);
    await user.click(screen.getByTestId('top-bar-toggle-drawer'));
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(false);
  });
});
