/**
 * BottomDrawerToggle (v3 Unit 2).
 *
 * Icon-only TopBar button that flips
 * ``useLayoutStore.bottomDrawerCollapsed``. The chevron points DOWN
 * when the drawer is open (drag-it-shut) and UP when collapsed
 * (drag-it-open). Mirrors VS Code's "Toggle Panel" affordance.
 *
 * Unread badge: per the F-DESIGN-5 resolution, when a Run fires while
 * the drawer is collapsed the layout slice flips
 * ``drawerHasUnreadResults`` to true. This button renders a small dot
 * (``bg-primary``, 6px round) in its top-right corner whenever that
 * bit is true; clicking the button toggles the drawer AND clears the
 * unread bit so the badge disappears the moment the user opens the
 * drawer to see the results.
 *
 * Companion command ``view.toggleBottomDrawer`` (registered in
 * ``@/lib/commands``) wires the same action to ⌘J / Ctrl+J via
 * ``<GlobalShortcuts />`` — the command's ``action`` calls
 * ``toggleBottomDrawer()`` AND ``clearDrawerUnread()`` so the keyboard
 * path matches the click path.
 */
import { Button } from '@/components/ui/button';
import { useLayoutStore } from '@/store/layout';
import { cn } from '@/lib/cn';

export interface BottomDrawerToggleProps {
  className?: string;
}

export function BottomDrawerToggle({ className }: BottomDrawerToggleProps) {
  const collapsed = useLayoutStore((s) => s.bottomDrawerCollapsed);
  const hasUnread = useLayoutStore((s) => s.drawerHasUnreadResults);
  const toggle = useLayoutStore((s) => s.toggleBottomDrawer);
  const clearUnread = useLayoutStore((s) => s.clearDrawerUnread);

  const onClick = () => {
    toggle();
    // Clear the unread badge as soon as the user reaches for the
    // drawer — matches the ⌘J command's action so click + shortcut
    // paths are interchangeable.
    if (hasUnread) clearUnread();
  };

  const tooltip = collapsed
    ? 'Show bottom drawer (⌘J)'
    : 'Hide bottom drawer (⌘J)';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      data-testid="top-bar-toggle-drawer"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-active={collapsed ? 'false' : 'true'}
      data-has-unread={hasUnread ? 'true' : 'false'}
      aria-label={tooltip}
      aria-pressed={!collapsed}
      title={tooltip}
      className={cn(
        'relative px-2',
        'data-[active=true]:bg-muted data-[active=true]:text-foreground',
        className,
      )}
    >
      <DrawerChevron collapsed={collapsed} className="h-4 w-4" />
      {hasUnread ? (
        <span
          data-testid="top-bar-toggle-drawer-unread-dot"
          aria-hidden="true"
          className={cn(
            // Slightly larger dot (size-2 vs 1.5) + ring halo so it
            // reads as a notification pip rather than a stray pixel.
            'absolute -top-0.5 -right-0.5 size-2 rounded-full',
            'bg-primary ring-background ring-2',
            'animate-pulse',
          )}
        />
      ) : null}
    </Button>
  );
}

interface DrawerChevronProps {
  collapsed: boolean;
  className?: string;
}

/**
 * Inline chevron glyph. When ``collapsed`` is true the arrow points
 * UP (the affordance: "lift the drawer up"); when false it points
 * DOWN (the affordance: "drop the drawer down"). The horizontal tick
 * on the bottom edge reads as "panel below".
 */
function DrawerChevron({ collapsed, className }: DrawerChevronProps) {
  const testid = collapsed
    ? 'top-bar-toggle-drawer-icon-expand'
    : 'top-bar-toggle-drawer-icon-collapse';
  return (
    <svg
      data-testid={testid}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Bottom edge tick — anchors the glyph as a "panel below". */}
      <path d="M4 20h16" />
      {collapsed ? (
        // Up-pointing chevron: drawer is hidden, click expands it.
        <path d="M8 14l4-4 4 4" />
      ) : (
        // Down-pointing chevron: drawer is visible, click collapses it.
        <path d="M8 10l4 4 4-4" />
      )}
    </svg>
  );
}
