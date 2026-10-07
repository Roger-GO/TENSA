import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { CaseNav } from '@/components/case/CaseNav';
import { ScheduledDisturbances } from '@/components/disturbance/ScheduledDisturbances';
import { useCaseStore } from '@/store/case';
import {
  DEFAULT_LAYOUT,
  LEFT_SIDEBAR_TABS,
  isLeftSidebarTab,
  useLayoutStore,
  type LeftSidebarTab,
} from '@/store/layout';
import { SavedCasesList } from './SavedCasesList';
import { ComponentLibrary } from './ComponentLibrary';
import { cn } from '@/lib/cn';

/**
 * LeftSidebar (v3 Unit 3).
 *
 * Two tabs under a full-bleed strip (Radix Tabs used directly, as the
 * BottomDrawer does and for the same reason).
 *
 * **Project** is the work in hand: a vertical stack of sections separated by
 * hairline ``border-border`` dividers. Each section has a small uppercase
 * tracking-wider heading (per the v3 plan's IA spec) and a content body.
 *
 *  1. **Case** — wraps the existing ``<CaseNav />`` (file picker /
 *     summary card). CaseNav stays mounted unchanged so the case-load
 *     logic (parse-workspace-path, blank-system, change-case confirm)
 *     keeps working without duplication.
 *  2. **Disturbances** — what the next TDS run does to the loaded case,
 *     and the button that adds a fault (``<ScheduledDisturbances />``).
 *     Only while a case is loaded.
 *  3. **Saved cases** — the cases opened lately, the workspace files and
 *     the per-case snapshots (``<SavedCasesList />``, Unit 4).
 *
 * **Components** is what a system is built from: the searchable palette of
 * element kinds (``<ComponentLibrary />``). Click a row, or drag it onto the
 * canvas, to open the AddElementPanel on that kind.
 *
 * The tab shown is the user's (``useLayoutStore.leftSidebarTab``, kept in
 * localStorage), so it is the same after a reload. Both panels stay mounted
 * and the one not shown is hidden: a case that is opening, a snapshot that is
 * being restored and a blank system that is being started each finish in the
 * component that began them, and a tab switched meanwhile would otherwise
 * drop what they do when they land. The search of the palette is kept the
 * same way.
 *
 * A panel can send the user to the other tab (the empty case card links to
 * Components), and what was pressed is then hidden with its panel. The
 * keyboard focus goes to the tab that was opened, so it is not lost and a
 * screen reader says where the user is now.
 *
 * The Project panel scrolls as one when its content overflows; each
 * section grows to fit its content rather than competing for fixed
 * heights. The palette keeps its search box in view and scrolls its list.
 */
export interface LeftSidebarProps {
  className?: string;
}

const TAB_LABELS: Record<LeftSidebarTab, string> = {
  project: 'Project',
  components: 'Components',
};

/** What a tab holds, for the tooltip of its name. */
const TAB_TITLES: Record<LeftSidebarTab, string> = {
  project: 'The open case, its disturbances, the saved cases and the snapshots',
  components: 'What a system is built from: search the list, then click or drag to add',
};

/** A panel takes the keyboard focus (Radix), so it shows that it has it, inside its own edge. */
const PANEL_FOCUS =
  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none focus-visible:ring-inset';

export function LeftSidebar({ className }: LeftSidebarProps) {
  const caseLoaded = useCaseStore((s) => s.selection !== null);
  const storedTab = useLayoutStore((s) => s.leftSidebarTab);
  const setTab = useLayoutStore((s) => s.setLeftSidebarTab);
  // What the browser kept is not checked when it is read back, and a tab
  // that does not exist would show neither panel.
  const tab = isLeftSidebarTab(storedTab) ? storedTab : DEFAULT_LAYOUT.leftSidebarTab;

  // When something other than the tab strip changes the tab under the focus
  // (it was in the panel that is hidden now), the tab that was opened takes
  // it. A layout effect, so that it runs before the browser drops the focus
  // of what it no longer shows. A click or an arrow key on the strip leaves
  // the focus on a tab as it is.
  const rootRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const byTabStripRef = useRef(false);
  useLayoutEffect(() => {
    const byTabStrip = byTabStripRef.current;
    byTabStripRef.current = false;
    if (byTabStrip) return;
    const held = document.activeElement;
    if (held === null || rootRef.current?.contains(held) !== true) return;
    if (held.closest('[hidden]') === null) return;
    tabListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [tab]);

  return (
    <TabsPrimitive.Root
      ref={rootRef}
      value={tab}
      onValueChange={(next) => {
        if (!isLeftSidebarTab(next)) return;
        byTabStripRef.current = true;
        setTab(next);
      }}
      data-testid="left-sidebar"
      className={cn(
        'flex h-full min-h-0 flex-col',
        // Sidebar background uses the chassis bg; the AppShell aside
        // wrapper already paints the right border.
        'bg-background',
        className,
      )}
    >
      <TabsPrimitive.List
        ref={tabListRef}
        aria-label="Left sidebar tabs"
        className="border-border bg-muted/30 flex h-8 shrink-0 items-stretch border-b"
      >
        {LEFT_SIDEBAR_TABS.map((value) => (
          <TabsPrimitive.Trigger
            key={value}
            value={value}
            title={TAB_TITLES[value]}
            data-testid={`left-sidebar-tab-${value}`}
            className={cn(
              // The two fill the strip, each from the width of its own name, so
              // the longer one is not cut off in a sidebar at its narrowest.
              'relative inline-flex min-w-0 flex-auto items-center justify-center px-2',
              'text-sm font-medium whitespace-nowrap',
              'text-muted-foreground hover:text-foreground',
              'border-r-border border-r last:border-r-0',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none focus-visible:ring-inset',
              'data-[state=active]:bg-background data-[state=active]:text-foreground',
              // The same 2px primary top-rail as the active tab of the bottom drawer.
              'data-[state=active]:shadow-[inset_0_2px_0_0_var(--color-primary)]',
              'transition-colors duration-[var(--duration-fast)]',
            )}
          >
            <span className="truncate">{TAB_LABELS[value]}</span>
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>

      <TabsPrimitive.Content
        value="project"
        forceMount
        hidden={tab !== 'project'}
        data-testid="left-sidebar-tab-content-project"
        className={cn('min-h-0 flex-1 overflow-y-auto', PANEL_FOCUS)}
      >
        <Section heading="Case" testId="left-sidebar-section-case">
          <CaseNav />
        </Section>
        {caseLoaded ? (
          <Section heading="Disturbances" testId="left-sidebar-section-disturbances">
            <ScheduledDisturbances />
          </Section>
        ) : null}
        <Section heading="Saved cases" testId="left-sidebar-section-saved-cases">
          <SavedCasesList />
        </Section>
      </TabsPrimitive.Content>

      <TabsPrimitive.Content
        value="components"
        forceMount
        hidden={tab !== 'components'}
        data-testid="left-sidebar-tab-content-components"
        className={cn('flex min-h-0 flex-1 flex-col', PANEL_FOCUS)}
      >
        <ComponentLibrary />
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}

interface SectionProps {
  heading: string;
  testId: string;
  children: ReactNode;
}

function Section({ heading, testId, children }: SectionProps) {
  return (
    <section
      data-testid={testId}
      // border-t draws the divider above each section; the first
      // section's top border is invisible against the chassis edge so
      // we don't special-case it. Padding kept tight so the headings
      // read as section labels rather than card titles.
      className={cn('border-border flex flex-col border-t first:border-t-0')}
    >
      <h2
        data-testid={`${testId}-heading`}
        className={cn(
          'text-muted-foreground/90 px-3 pt-3 pb-1.5',
          // Wider tracking + slightly tighter line-height so the eyebrow
          // reads as a section label (not a card title). Letter-spacing
          // is the load-bearing change vs the previous tracking-wider.
          'text-[10px] leading-none font-semibold uppercase',
          'tracking-[0.12em]',
        )}
      >
        {heading}
      </h2>
      <div className="min-h-0">{children}</div>
    </section>
  );
}
