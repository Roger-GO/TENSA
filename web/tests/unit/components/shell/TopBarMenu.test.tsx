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
 * - An item with a `title` shows it as a tooltip on a hover (not on a focus), and
 *   gives it to assistive technology as the item's description.
 * - An item with an `unavailableReason` stays in the menu and in the arrow-key order,
 *   shows the reason, and does nothing when activated.
 * - The open menu and an item's tooltip are drawn above the toasts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  TopBarMenu,
  TopBarMenuItem,
  TopBarMenuLabel,
  TopBarMenuLink,
  TopBarMenuSeparator,
} from '@/components/shell/TopBarMenu';
import { TOAST_Z_INDEX, TOP_BAR_MENU_Z_INDEX } from '@/components/ui/layers';

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

function Glyph({ className }: { className?: string }) {
  return <svg data-testid="glyph" className={className} />;
}

describe('<TopBarMenu /> — icon-only trigger', () => {
  it('draws the icon and no label or chevron, and keeps the label as its name', () => {
    render(
      <TopBarMenu label="Help" icon={Glyph} iconOnly testId="topbar-menu-help">
        <TopBarMenuItem testId="item-a">A</TopBarMenuItem>
      </TopBarMenu>,
    );
    const trigger = screen.getByTestId('topbar-menu-help-trigger');
    expect(screen.getByRole('button', { name: 'Help' })).toBe(trigger);
    expect(trigger).toHaveAttribute('title', 'Help');
    expect(trigger).not.toHaveTextContent('Help');
    // The icon is the only drawing: no chevron beside it.
    expect(trigger.querySelectorAll('svg')).toHaveLength(1);
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
  });

  it('still opens its menu', async () => {
    const user = userEvent.setup();
    render(
      <TopBarMenu label="Help" icon={Glyph} iconOnly testId="topbar-menu-help">
        <TopBarMenuItem testId="item-a">A</TopBarMenuItem>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-help-trigger'));
    expect(await screen.findByTestId('item-a')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-help-content')).toHaveAttribute('aria-label', 'Help');
  });

  it('keeps the label and the chevron on a trigger that is not icon-only', () => {
    render(
      <TopBarMenu label="Sample" icon={Glyph} testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-a">A</TopBarMenuItem>
      </TopBarMenu>,
    );
    const trigger = screen.getByTestId('topbar-menu-sample-trigger');
    expect(trigger).toHaveTextContent('Sample');
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger.querySelectorAll('svg')).toHaveLength(2);
  });
});

describe('<TopBarMenu /> — link items', () => {
  it('renders a real link that opens in a new tab without handing over the opener', async () => {
    const user = userEvent.setup();
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuLink testId="link-a" href="https://example.com/a" hint="example.com">
          Docs
        </TopBarMenuLink>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const link = await screen.findByTestId('link-a');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('role', 'menuitem');
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('Docs');
    expect(link).toHaveTextContent('example.com');
  });

  it('is part of the arrow-key order, and keeps the menu open when a handler prevents the follow', async () => {
    const user = userEvent.setup();
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-a">A</TopBarMenuItem>
        <TopBarMenuLink
          testId="link-b"
          href="https://example.com/b"
          onClick={(event) => event.preventDefault()}
        >
          B
        </TopBarMenuLink>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await screen.findByTestId('link-b');
    await waitFor(() => expect(screen.getByTestId('item-a')).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('link-b')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('topbar-menu-sample-content')).toBeInTheDocument();
  });

  it('closes the menu when it is followed', async () => {
    const user = userEvent.setup();
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuLink testId="link-a" href="https://example.com/a">
          A
        </TopBarMenuLink>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await user.click(await screen.findByTestId('link-a'));
    await waitFor(() =>
      expect(screen.queryByTestId('topbar-menu-sample-content')).not.toBeInTheDocument(),
    );
  });
});

describe('<TopBarMenu /> — over the toasts', () => {
  it("draws the open menu and an item's tooltip above the toasts", async () => {
    // The toasts appear where the menus on the right open, and one lying over a
    // menu would hide its entries for as long as the pointer rested on it.
    const user = userEvent.setup();
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-a" title="What A does, in a sentence.">
          Item A
        </TopBarMenuItem>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const content = await screen.findByTestId('topbar-menu-sample-content');
    expect(Number(content.style.zIndex)).toBe(TOP_BAR_MENU_Z_INDEX);
    expect(Number(content.style.zIndex)).toBeGreaterThan(TOAST_Z_INDEX);

    await user.hover(screen.getByTestId('item-a'));
    const tooltip = (await screen.findByRole('tooltip')).parentElement;
    expect(Number(tooltip?.style.zIndex)).toBe(TOP_BAR_MENU_Z_INDEX);
  });
});

describe('<TopBarMenu /> item hover text', () => {
  function renderTitled() {
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-a" title="What A does, in a sentence.">
          Item A
        </TopBarMenuItem>
        <TopBarMenuItem testId="item-b">Item B</TopBarMenuItem>
      </TopBarMenu>,
    );
  }

  it('shows the title as a tooltip on a hover, and takes it away on leaving', async () => {
    const user = userEvent.setup();
    renderTitled();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const itemA = await screen.findByTestId('item-a');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.hover(itemA);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('What A does, in a sentence.');
    await user.unhover(itemA);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('keeps the browser tooltip off the item and the title out of its name', async () => {
    const user = userEvent.setup();
    renderTitled();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const itemA = await screen.findByTestId('item-a');
    expect(itemA).not.toHaveAttribute('title');
    expect(itemA).toHaveAccessibleName('Item A');
    expect(itemA).toHaveAttribute('aria-description', 'What A does, in a sentence.');
    expect(screen.getByTestId('item-b')).not.toHaveAttribute('aria-description');
  });

  it('does not open the tooltip when the menu focuses its first item', async () => {
    const user = userEvent.setup();
    renderTitled();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const itemA = await screen.findByTestId('item-a');
    await waitFor(() => expect(itemA).toHaveFocus());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('<TopBarMenu /> an item with a note', () => {
  it('shows the note under the label, and the reason in its place while unavailable', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-figure" note="The publication look" onClick={onClick}>
          Figure for a paper…
        </TopBarMenuItem>
        <TopBarMenuItem
          testId="item-off"
          note="The publication look"
          unavailableReason="No diagram."
        >
          Figure for a paper…
        </TopBarMenuItem>
        <TopBarMenuItem testId="item-plain">Plain</TopBarMenuItem>
      </TopBarMenu>,
    );
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const item = await screen.findByTestId('item-figure');
    expect(within(item).getByTestId('item-figure-note')).toHaveTextContent('The publication look');
    // Part of what the item reads as, so a search of the page for the word finds it.
    expect(item).toHaveTextContent('Figure for a paper…The publication look');
    expect(screen.queryByTestId('item-off-note')).toBeNull();
    expect(screen.getByTestId('item-off-reason')).toHaveTextContent('No diagram.');
    expect(screen.queryByTestId('item-plain-note')).toBeNull();
    // It still runs as any item.
    await user.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('<TopBarMenu /> unavailable items', () => {
  function renderUnavailable(onClickLocked = vi.fn()) {
    render(
      <TopBarMenu label="Sample" testId="topbar-menu-sample">
        <TopBarMenuItem testId="item-a">Item A</TopBarMenuItem>
        <TopBarMenuItem
          testId="item-locked"
          unavailableReason="Do this first."
          onClick={onClickLocked}
        >
          Locked item
        </TopBarMenuItem>
        <TopBarMenuItem testId="item-c">Item C</TopBarMenuItem>
      </TopBarMenu>,
    );
  }

  it('shows the reason under the label, and names and describes the item', async () => {
    const user = userEvent.setup();
    renderUnavailable();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    const locked = await screen.findByTestId('item-locked');
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).not.toBeDisabled();
    expect(within(locked).getByTestId('item-locked-reason')).toHaveTextContent('Do this first.');
    // The reason is the description, not part of the name.
    expect(locked).toHaveAccessibleName('Locked item');
    expect(locked).toHaveAccessibleDescription('Do this first.');
  });

  it('does nothing when clicked, and leaves the menu open', async () => {
    const user = userEvent.setup();
    const onClickLocked = vi.fn();
    renderUnavailable(onClickLocked);
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await user.click(await screen.findByTestId('item-locked'));
    expect(onClickLocked).not.toHaveBeenCalled();
    expect(screen.getByTestId('topbar-menu-sample-content')).toBeInTheDocument();
  });

  it('is reached by the arrow keys, so the reason can be found without a mouse', async () => {
    const user = userEvent.setup();
    renderUnavailable();
    await user.click(screen.getByTestId('topbar-menu-sample-trigger'));
    await screen.findByTestId('item-locked');
    await waitFor(() => expect(screen.getByTestId('item-a')).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('item-locked')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('topbar-menu-sample-content')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('item-c')).toHaveFocus();
  });
});
