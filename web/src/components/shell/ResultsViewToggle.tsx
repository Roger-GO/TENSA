/**
 * ResultsViewToggle (v3.1).
 *
 * Icon-only TopBar button that flips ``useLayoutStore.resultsViewActive``.
 * When the results view is OFF the glyph reads as "maximize" (expand
 * results into the full content area); when ON it reads as "minimize"
 * (return to the diagram + parameters). Mirrors the SidebarToggle /
 * InspectorToggle / BottomDrawerToggle pattern so the four pane controls
 * read as one perceptual family in the TopBar right cluster.
 *
 * Companion command ``view.toggle-results-view`` (registered in
 * ``@/lib/commands``) wires the same action to ⌘⇧M / Ctrl+⇧M via
 * ``<GlobalShortcuts />`` — clicking the button and pressing the shortcut
 * both call ``useLayoutStore.getState().toggleResultsView()``.
 *
 * The inline-SVG glyph follows the project convention established by
 * ``ThemeToggle.tsx`` (no Lucide dep).
 */
import { Button } from '@/components/ui/button';
import { useLayoutStore } from '@/store/layout';
import { cn } from '@/lib/cn';

export interface ResultsViewToggleProps {
  className?: string;
}

export function ResultsViewToggle({ className }: ResultsViewToggleProps) {
  const active = useLayoutStore((s) => s.resultsViewActive);
  const toggle = useLayoutStore((s) => s.toggleResultsView);

  const tooltip = active ? 'Exit results view (⌘⇧M)' : 'Maximize results (⌘⇧M)';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={toggle}
      data-testid="top-bar-toggle-results-view"
      data-active={active ? 'true' : 'false'}
      aria-label={tooltip}
      aria-pressed={active}
      title={tooltip}
      className={cn(
        'px-2',
        // Active (results view open) state: subtle filled chip so the user
        // can see at a glance which surface they're on, matching the other
        // pane toggles.
        'data-[active=true]:bg-muted data-[active=true]:text-foreground',
        className,
      )}
    >
      <ResultsViewGlyph active={active} className="h-4 w-4" />
    </Button>
  );
}

interface ResultsViewGlyphProps {
  active: boolean;
  className?: string;
}

/**
 * Inline expand/contract glyph. When ``active`` is false the arrows point
 * OUTWARD (the affordance: "maximize results to fill the page"); when true
 * they point INWARD (the affordance: "minimize back to the diagram"). The
 * shape mirrors a fullscreen-toggle corner-arrows motif at 16px.
 */
function ResultsViewGlyph({ active, className }: ResultsViewGlyphProps) {
  const testid = active
    ? 'top-bar-toggle-results-view-icon-minimize'
    : 'top-bar-toggle-results-view-icon-maximize';
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
      {active ? (
        // Inward corner arrows — minimize back to the chassis.
        <>
          <path d="M9 3v3a3 3 0 0 1-3 3H3" />
          <path d="M21 9h-3a3 3 0 0 1-3-3V3" />
          <path d="M3 15h3a3 3 0 0 1 3 3v3" />
          <path d="M15 21v-3a3 3 0 0 1 3-3h3" />
        </>
      ) : (
        // Outward corner arrows — maximize results to fill the page.
        <>
          <path d="M3 9V3h6" />
          <path d="M21 9V3h-6" />
          <path d="M3 15v6h6" />
          <path d="M21 15v6h-6" />
        </>
      )}
    </svg>
  );
}
