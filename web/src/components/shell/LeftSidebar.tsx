import type { ReactNode } from 'react';
import { CaseNav } from '@/components/case/CaseNav';
import { SavedCasesList } from './SavedCasesList';
import { ComponentLibrary } from './ComponentLibrary';
import { cn } from '@/lib/cn';

/**
 * LeftSidebar (v3 Unit 3).
 *
 * Vertical stack of three sections separated by hairline ``border-border``
 * dividers. Each section has a small uppercase tracking-wider heading
 * (per the v3 plan's IA spec) and a content body.
 *
 * Sections:
 *
 *  1. **Case** — wraps the existing ``<CaseNav />`` (file picker /
 *     summary card). CaseNav stays mounted unchanged so the case-load
 *     logic (parse-workspace-path, blank-system, change-case confirm)
 *     keeps working without duplication.
 *  2. **Saved cases** — workspace files + per-case snapshots
 *     (``<SavedCasesList />``, Unit 4).
 *  3. **Component library** — drag-and-drop palette of element kinds
 *     (``<ComponentLibrary />``, Unit 5). Drag onto the canvas to open
 *     the AddElementPanel pre-filled with the dropped kind.
 *
 * The sidebar itself scrolls only when its content overflows; each
 * section grows to fit its content rather than competing for fixed
 * heights. CaseNav's summary card is short, the saved-cases list grows
 * with workspace size (with internal scroll past N rows in Unit 4), and
 * the Component Library is fixed-grid 6 tiles.
 */
export interface LeftSidebarProps {
  className?: string;
}

export function LeftSidebar({ className }: LeftSidebarProps) {
  return (
    <div
      data-testid="left-sidebar"
      className={cn(
        'flex h-full min-h-0 flex-col overflow-y-auto',
        // Sidebar background uses the chassis bg; the AppShell aside
        // wrapper already paints the right border.
        'bg-background',
        className,
      )}
    >
      <Section heading="Case" testId="left-sidebar-section-case">
        <CaseNav />
      </Section>
      <Section heading="Saved cases" testId="left-sidebar-section-saved-cases">
        <SavedCasesList />
      </Section>
      <Section heading="Component library" testId="left-sidebar-section-component-library">
        <ComponentLibrary />
      </Section>
    </div>
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
          'text-[10px] font-semibold uppercase leading-none',
          'tracking-[0.12em]',
        )}
      >
        {heading}
      </h2>
      <div className="min-h-0">{children}</div>
    </section>
  );
}
