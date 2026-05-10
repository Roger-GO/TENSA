/**
 * InspectorToggle (v3 Unit 2).
 *
 * Icon-only TopBar button that flips
 * ``useLayoutStore.rightInspectorCollapsed``. The chevron orientation
 * reflects the *affordance* — when the inspector is open, the chevron
 * points RIGHT (drag-it-shut, mirror image of the SidebarToggle);
 * when collapsed, it points LEFT (drag-it-open into the canvas).
 *
 * Per the F-DESIGN-2 resolution, a TopBar toggle is the only re-discovery
 * affordance for the right inspector when it's at size=0 — without this
 * button a user with no current selection would have no signal that an
 * inspector exists.
 *
 * Companion command ``view.toggleRightInspector`` (registered in
 * ``@/lib/commands``) wires the same action to ⌘\\ / Ctrl+\\ via
 * ``<GlobalShortcuts />``.
 */
import { Button } from '@/components/ui/button';
import { useLayoutStore } from '@/store/layout';
import { cn } from '@/lib/cn';

export interface InspectorToggleProps {
  className?: string;
}

export function InspectorToggle({ className }: InspectorToggleProps) {
  const collapsed = useLayoutStore((s) => s.rightInspectorCollapsed);
  const toggle = useLayoutStore((s) => s.toggleRightInspector);

  const tooltip = collapsed
    ? 'Show inspector (⌘\\)'
    : 'Hide inspector (⌘\\)';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={toggle}
      data-testid="top-bar-toggle-inspector"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={tooltip}
      aria-pressed={!collapsed}
      title={tooltip}
      className={cn('px-2', className)}
    >
      <InspectorChevron collapsed={collapsed} className="h-4 w-4" />
    </Button>
  );
}

interface InspectorChevronProps {
  collapsed: boolean;
  className?: string;
}

/**
 * Inline chevron glyph mirroring ``SidebarChevron`` across the vertical
 * axis. The vertical tick sits on the right edge so the glyph reads as
 * "right-side panel". When ``collapsed`` is true the arrow points left
 * (the affordance: "expand toward the canvas"); when false it points
 * right (the affordance: "collapse toward the edge").
 */
function InspectorChevron({ collapsed, className }: InspectorChevronProps) {
  const testid = collapsed
    ? 'top-bar-toggle-inspector-icon-expand'
    : 'top-bar-toggle-inspector-icon-collapse';
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
      {/* Right edge tick + chevron — reads as an inspector glyph at 16px. */}
      <path d="M20 4v16" />
      {collapsed ? (
        // Left-pointing chevron: inspector is hidden, click expands it.
        <path d="M14 8l-4 4 4 4" />
      ) : (
        // Right-pointing chevron: inspector is visible, click collapses it.
        <path d="M10 8l4 4-4 4" />
      )}
    </svg>
  );
}
