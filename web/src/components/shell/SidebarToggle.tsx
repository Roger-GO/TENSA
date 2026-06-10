/**
 * SidebarToggle (v3 Unit 2).
 *
 * Icon-only TopBar button that flips ``useLayoutStore.leftSidebarCollapsed``.
 * The chevron orientation reflects the *affordance* — when the sidebar
 * is open, the chevron points LEFT (drag-it-shut); when collapsed, it
 * points RIGHT (drag-it-open). Mirrors the VS Code Activity Bar toggle.
 *
 * Companion command ``view.toggleLeftSidebar`` (registered in
 * ``@/lib/commands``) wires the same action to ⌘B / Ctrl+B via
 * ``<GlobalShortcuts />`` — clicking the button and pressing the
 * shortcut both call ``useLayoutStore.getState().toggleLeftSidebar()``.
 *
 * The inline-SVG glyph follows the project convention established by
 * ``ThemeToggle.tsx`` (no Lucide dep).
 */
import { Button } from '@/components/ui/button';
import { useLayoutStore } from '@/store/layout';
import { cn } from '@/lib/cn';

export interface SidebarToggleProps {
  className?: string;
}

export function SidebarToggle({ className }: SidebarToggleProps) {
  const collapsed = useLayoutStore((s) => s.leftSidebarCollapsed);
  const toggle = useLayoutStore((s) => s.toggleLeftSidebar);

  const tooltip = collapsed ? 'Show left sidebar (⌘B)' : 'Hide left sidebar (⌘B)';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={toggle}
      data-testid="top-bar-toggle-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-active={collapsed ? 'false' : 'true'}
      aria-label={tooltip}
      aria-pressed={!collapsed}
      title={tooltip}
      className={cn(
        'px-2',
        // Active (panel open) state: subtle filled chip so the user can
        // see at a glance which panes are open without parsing chevrons.
        'data-[active=true]:bg-muted data-[active=true]:text-foreground',
        className,
      )}
    >
      <SidebarChevron collapsed={collapsed} className="h-4 w-4" />
    </Button>
  );
}

interface SidebarChevronProps {
  collapsed: boolean;
  className?: string;
}

/**
 * Inline chevron glyph. When ``collapsed`` is true the arrow points
 * right (the affordance: "expand toward the canvas"); when false it
 * points left (the affordance: "collapse toward the edge"). Shape is
 * compatible with Lucide's ``ChevronLeft`` / ``ChevronRight`` for a
 * future no-op swap.
 */
function SidebarChevron({ collapsed, className }: SidebarChevronProps) {
  const testid = collapsed
    ? 'top-bar-toggle-sidebar-icon-expand'
    : 'top-bar-toggle-sidebar-icon-collapse';
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
      {/* Left edge tick + chevron — reads as a sidebar glyph at 16px. */}
      <path d="M4 4v16" />
      {collapsed ? (
        // Right-pointing chevron: sidebar is hidden, click expands it.
        <path d="M10 8l4 4-4 4" />
      ) : (
        // Left-pointing chevron: sidebar is visible, click collapses it.
        <path d="M14 8l-4 4 4 4" />
      )}
    </svg>
  );
}
