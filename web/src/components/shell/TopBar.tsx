import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { BundleExportDialog } from '@/components/bundle/BundleExportDialog';
import { ReportDialog } from '@/components/reports/ReportDialog';
import { HistoryDrawer, HistoryDrawerToggle } from '@/components/history/HistoryDrawer';
import { Button } from '@/components/ui/button';
import { useCommandPaletteStore } from '@/store/commandPalette';

/**
 * TopBar. Fixed-height (~44px) bar with three slots — left, center, right —
 * exposed as ReactNode props so other units can inject controls without the
 * shell needing to know about them.
 *
 * The three-prop shape was chosen over a children-with-data-slot or
 * subcomponent pattern because:
 *
 * - It keeps the public API trivially type-checked (each slot is just
 *   ReactNode).
 * - It avoids the runtime work of `React.Children.toArray` + filtering.
 * - It composes naturally with conditional rendering (`right={isLoaded ? …
 *   : null}`) without callers needing to remember a wrapper component.
 *
 * Per R18, the top bar is intentionally thin — it hosts the case label
 * (left), title or breadcrumbs (center), and run controls + view toggles
 * (right). All three slots are optional; an empty top bar still renders so
 * that the shell layout collapses predictably.
 *
 * Unit 8 of the v2.0 polish plan replaced the previous flat 14-button
 * layout with four grouped Radix-style menus (Workspace / Edit / Run /
 * Export). The TopBar now carries:
 *
 * - ``left``: a slot the App fills with the Workspace / Edit / Run
 *   triggers (the menus themselves render their own dropdown bodies via
 *   Radix Popover portals, so the bar only sees the trigger buttons).
 * - ``center``: the primary Run button + RunStatusBadge.
 * - ``right``: a slot the App fills with the Export trigger + the
 *   "Hide labels" toggle. The TopBar adds the dark-mode toggle
 *   placeholder + History trigger after the slot content so they
 *   always sit at the rightmost edge regardless of what the App
 *   chooses to inject.
 *
 * The dialog wrappers for store-driven flows (BundleExportDialog,
 * ReportDialog, HistoryDrawer) stay mounted here because their open-
 * close state is global (Zustand-backed). Mounting them at the TopBar
 * root keeps a single portal anchor across menu open/close cycles.
 */
export interface TopBarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(
  { left, center, right, className, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      role="banner"
      aria-label="Application top bar"
      data-testid="top-bar"
      className={cn(
        // 44px tall, full-width strip with a hairline border below.
        'flex h-11 w-full shrink-0 items-center gap-3 px-3',
        'border-border bg-background/95 border-b backdrop-blur-sm',
        // soft shadow to anchor the bar against the canvas
        'shadow-[0_1px_0_0_rgba(0,0,0,0.02),0_1px_2px_-1px_rgba(0,0,0,0.04)]',
        // ensure the focus ring of any contained interactive element
        // isn't clipped at the top
        'relative z-10',
        className,
      )}
      {...props}
    >
      <div
        data-slot="left"
        data-testid="top-bar-left"
        className="flex min-w-0 flex-1 items-center justify-start gap-1"
      >
        {left}
      </div>
      <div
        data-slot="center"
        data-testid="top-bar-center"
        className="flex min-w-0 flex-initial items-center justify-center gap-2"
      >
        {center}
      </div>
      <div
        data-slot="right"
        data-testid="top-bar-right"
        className="flex min-w-0 flex-1 items-center justify-end gap-1"
      >
        {right}
        <CommandPaletteHint />
        <DarkModeTogglePlaceholder />
        <HistoryDrawerToggle />
      </div>
      <BundleExportDialog />
      <ReportDialog />
      <HistoryDrawer />
    </header>
  );
});

/**
 * "⌘K" hint button (Unit 9). Mouse affordance for the command palette
 * — discovers the shortcut for users who don't read keyboard hints.
 * Sits between the Export menu / Hide-labels toggle (caller-provided
 * right-slot content) and the dark-mode placeholder, so it consistently
 * appears as the third-from-end control regardless of what the App
 * chooses to inject into the right slot.
 *
 * The button label uses the platform-agnostic "⌘K" glyph plus a
 * "Search" word so non-mac users still understand the affordance
 * without having to learn the symbol.
 */
function CommandPaletteHint() {
  const openPalette = useCommandPaletteStore((s) => s.openPalette);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={openPalette}
      data-testid="command-palette-hint"
      aria-label="Open command palette"
      className="gap-1 px-2 text-xs"
    >
      <span className="text-muted-foreground font-mono text-[10px]">⌘K</span>
      <span>Search</span>
    </Button>
  );
}

/**
 * Placeholder dark-mode toggle. Unit 8 only ships the visual slot; the
 * actual theme-switching logic lands in Unit 12. The button is a no-op
 * onClick so users clicking it pre-Unit-12 don't see the page change
 * unexpectedly. The icon flips between sun (visual cue for "switch to
 * dark") and moon would be wired by Unit 12 once the theme provider is
 * in place; for now we render the sun glyph statically.
 */
function DarkModeTogglePlaceholder() {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
        // intentional no-op — Unit 12 will wire the actual theme toggle.
      }}
      data-testid="dark-mode-toggle-placeholder"
      aria-label="Toggle dark mode (coming in Unit 12)"
      className="px-2"
    >
      <SunGlyph className="h-4 w-4" />
    </Button>
  );
}

/**
 * Inline sun glyph. The codebase ships icons inline (see RunButton's
 * Spinner) rather than depending on `lucide-react`, which is not in
 * the project's dependency set. Unit 12 may swap these to Lucide
 * components if/when the package lands; the icon shapes here are
 * shape-compatible with Lucide's.
 */
function SunGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}
