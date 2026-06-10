/**
 * Tests for `<InspectorToggle />` (v3 Unit 2).
 *
 * Mirrors `<SidebarToggle />` shape — flips
 * ``useLayoutStore.rightInspectorCollapsed``. Per the F-DESIGN-2
 * resolution this button is the only re-discovery affordance for the
 * right inspector when it's at size=0, so the active-state styling
 * and aria coverage matters more than for a panel that always has
 * an in-canvas resize handle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InspectorToggle } from '@/components/shell/InspectorToggle';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('<InspectorToggle />', () => {
  it('renders with testid + accessible label', () => {
    render(<InspectorToggle />);
    const btn = screen.getByTestId('top-bar-toggle-inspector');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label');
    expect(btn).toHaveAttribute('aria-pressed');
  });

  it('renders the collapse-affordance chevron when inspector is expanded', () => {
    useLayoutStore.setState({ rightInspectorCollapsed: false });
    render(<InspectorToggle />);
    expect(screen.getByTestId('top-bar-toggle-inspector-icon-collapse')).toBeInTheDocument();
    expect(screen.queryByTestId('top-bar-toggle-inspector-icon-expand')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-inspector')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the expand-affordance chevron when inspector is collapsed', () => {
    useLayoutStore.setState({ rightInspectorCollapsed: true });
    render(<InspectorToggle />);
    expect(screen.getByTestId('top-bar-toggle-inspector-icon-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('top-bar-toggle-inspector-icon-collapse')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-bar-toggle-inspector')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking flips rightInspectorCollapsed; second click flips it back', async () => {
    const user = userEvent.setup();
    render(<InspectorToggle />);
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(false);

    await user.click(screen.getByTestId('top-bar-toggle-inspector'));
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(true);

    await user.click(screen.getByTestId('top-bar-toggle-inspector'));
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(false);
  });

  it('exposes the collapsed state via data-collapsed', () => {
    useLayoutStore.setState({ rightInspectorCollapsed: true });
    render(<InspectorToggle />);
    expect(screen.getByTestId('top-bar-toggle-inspector')).toHaveAttribute(
      'data-collapsed',
      'true',
    );
  });

  it('does NOT mutate drawerHasUnreadResults when clicked', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ drawerHasUnreadResults: true });
    render(<InspectorToggle />);
    await user.click(screen.getByTestId('top-bar-toggle-inspector'));
    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(true);
  });
});
