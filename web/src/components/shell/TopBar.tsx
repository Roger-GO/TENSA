import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { BundleExportDialog } from '@/components/bundle/BundleExportDialog';
import { ReportDialog } from '@/components/reports/ReportDialog';
import { HistoryDrawer, HistoryDrawerToggle } from '@/components/history/HistoryDrawer';
import { Button } from '@/components/ui/button';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { ThemeToggle } from '@/components/shell/ThemeToggle';

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
 *   "Hide labels" toggle. The TopBar adds the command-palette hint,
 *   the theme toggle (Unit 12), and History trigger after the slot
 *   content so they always sit at the rightmost edge regardless of
 *   what the App chooses to inject.
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
        <TopBarDivider />
        <CommandPaletteHint />
        <TopBarDivider />
        <ThemeToggle />
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
      className="gap-1.5 px-2 text-xs"
    >
      <span>Search</span>
      <kbd
        aria-hidden="true"
        className={cn(
          'inline-flex h-4 min-w-[1.25rem] items-center justify-center px-1',
          'rounded border font-mono text-[10px]',
          'border-border bg-muted text-muted-foreground',
        )}
      >
        ⌘K
      </kbd>
    </Button>
  );
}

/**
 * Hairline vertical separator used to group the right-cluster items
 * (Export menu / Labels toggle / ⌘K hint / Theme toggle / History) into
 * three perceptual groups: caller-supplied controls, search, then
 * theme + history. Without these dividers the cluster reads as eight
 * undifferentiated chips.
 */
function TopBarDivider() {
  return (
    <span
      aria-hidden="true"
      data-testid="top-bar-divider"
      className="bg-border mx-1.5 h-5 w-px shrink-0"
    />
  );
}
