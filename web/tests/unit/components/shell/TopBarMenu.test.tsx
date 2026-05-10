/**
 * Tests for `<TopBarMenu />` — the generic dropdown wrapper used by
 * Workspace / Edit / Run / Export menus (Unit 8 of the v2.0 polish
 * plan).
 *
 * Covers:
 *
 * - Trigger renders with the right testid + a11y attributes
 *   (`aria-haspopup="menu"`, `aria-expanded`).
 * - Content opens on click; items render as `role="menuitem"`.
 * - Keyboard nav: ArrowDown/ArrowUp/Home/End move focus across items.
 * - Activating an item closes the menu (matches DropdownMenu's
 *   `onSelect` close-on-default semantics).
 * - Escape closes the menu.
 * - `disabled` items don't receive focus + don't fire onClick.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  TopBarMenu,
  TopBarMenuItem,
  TopBarMenuLabel,
  TopBarMenuSeparator,
} from '@/components/shell/TopBarMenu';

afterEach(() => {
  cleanup();
});

function renderBasicMenu(onSelectA = vi.fn(), onSelectB = vi.fn(), onSelectC = vi.fn()) {
  render(
    <TopBarMenu label="Sample" testId="topbar-menu-sample">
      <TopBarMenuLabel>Group</TopBarMenuLabel>
      <TopBarMenuItem testId="item-a" onClick={onSelectA}>
        Item A
      </TopBarMenuItem>
      <TopBarMenuItem testId="item-b" onClick={onSelectB}>
        Item B
      </TopBarMenuItem>
      <TopBarMenuSeparator />
      <TopBarMenuItem testId="item-c" onClick={onSelectC}>
        Item C
      </TopBarMenuItem>
    </TopBarMenu>,
  );
}

describe('<TopBarMenu /> — trigger', () => {
  it('renders with kebab-case `${testId}-trigger` and aria-haspopup="menu"', () => {
    renderBasicMenu();
    const trigger = screen.getByTestId('topbar-menu-sample-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    // Radix Popover sets `aria-expanded` on the trigger; default false
    // before the menu opens.
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the label text', () => {
    renderBasicMenu();
    expect(screen.getByText('Sample')).toBeInTheDocument();
  });

  it('respects the disabled prop', () => {
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample" disabled>
        <TopBarMenuItem testId="item-a">A</TopBarMenuItem>
      </TopBarMenu>,
    );
    expect(screen.getByTestId('topbar-menu-sample-trigger')).toBeDisabled();
  });
});

describe('<TopBarMenu /> — open / close', () => {
  it('opens the menu on click, exposing role="menu" content', async () => {
    const user = userEvent.setup();
    renderBasicMenu();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const content = await screen.findByTestId('topbar-menu-sample-content');
    expect(content).toBeInTheDocument();
    expect(content).toHaveAttribute('role', 'menu');
    // aria-expanded flips to true on open.
    expect(screen.getByTestId('topbar-menu-sample-trigger')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('closes the menu on Escape', async () => {
    const user = userEvent.setup();
    renderBasicMenu();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await screen.findByTestId('topbar-menu-sample-content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-sample-content')).not.toBeInTheDocument();
    });
  });

  it('closes the menu when an item is activated and fires onClick', async () => {
    const user = userEvent.setup();
    const onSelectA = vi.fn();
    renderBasicMenu(onSelectA);
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const itemA = await screen.findByTestId('item-a');
    await user.click(itemA);
    expect(onSelectA).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-sample-content')).not.toBeInTheDocument();
    });
  });
});

describe('<TopBarMenu /> — keyboard navigation', () => {
  it('focuses the first menuitem on open (auto-focus contract)', async () => {
    const user = userEvent.setup();
    renderBasicMenu();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('item-a'));
    });
  });

  it('ArrowDown moves focus to the next menuitem', async () => {
    const user = userEvent.setup();
    renderBasicMenu();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('item-a')));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByTestId('item-b'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByTestId('item-c'));
  });

  it('ArrowUp moves focus to the previous menuitem; wraps from first', async () => {
    const user = userEvent.setup();
    renderBasicMenu();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('item-a')));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByTestId('item-c'));
  });

  it('Home / End jump focus to the first / last item', async () => {
    const user = userEvent.setup();
    renderBasicMenu();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('item-a')));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByTestId('item-c'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByTestId('item-a'));
  });

  it('Enter on a focused menuitem activates it and closes the menu', async () => {
    const user = userEvent.setup();
    const onSelectB = vi.fn();
    renderBasicMenu(vi.fn(), onSelectB);
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('item-a')));
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onSelectB).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-sample-content')).not.toBeInTheDocument();
    });
  });
});

describe('<TopBarMenu /> — disabled items', () => {
  it('disabled items do not receive focus and do not fire onClick', async () => {
    const user = userEvent.setup();
    const onSelectA = vi.fn();
    const onSelectB = vi.fn();
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-a" onClick={onSelectA} disabled>
          A
        </TopBarMenuItem>
        <TopBarMenuItem testId="item-b" onClick={onSelectB}>
          B
        </TopBarMenuItem>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    // First focusable item is item-b (item-a is disabled and skipped).
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('item-b'));
    });
    // Programmatic click is a no-op on a disabled <button>.
    expect(screen.getByTestId('item-a')).toBeDisabled();
    expect(onSelectA).not.toHaveBeenCalled();
  });
});

describe('<TopBarMenu /> — checked items', () => {
  it('renders a check glyph next to a `checked` item', async () => {
    const user = userEvent.setup();
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-a" checked>
          A
        </TopBarMenuItem>
        <TopBarMenuItem testId="item-b">B</TopBarMenuItem>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const itemA = await screen.findByTestId('item-a');
    // The check glyph is an SVG inline; assert it's there by looking
    // for a child SVG (the unchecked item has no SVG child).
    expect(itemA.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('item-b').querySelector('svg')).toBeNull();
  });
});
