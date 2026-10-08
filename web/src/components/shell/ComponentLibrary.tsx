import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ElementKindGlyph } from '@/components/elements/ElementKindGlyph';
import {
  ELEMENT_KINDS,
  groupElementKinds,
  searchElementKinds,
  type ElementKind,
} from '@/components/elements/elementKinds';
import { ReloadedCaseNote } from '@/components/case/ReloadedCaseNote';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { useAddComponent } from '@/lib/useAddComponent';
import { useCaseStore } from '@/store/case';
import { useLayoutStore } from '@/store/layout';
import { useSldStore } from '@/store/sld';

/**
 * ComponentLibrary: the palette of the left sidebar's Components tab.
 *
 * Every kind of element the Add element form can add (`ELEMENT_KINDS`, the
 * list its Kind picker shows), grouped the way the picker groups them, each
 * with its symbol, its name and a line that says what it is. A search box
 * over the list keeps the kinds that hold every word typed, by name, model,
 * group or one of the other words a kind is known under ("avr" finds the
 * exciters, "storage" the battery), so a model is found without knowing which
 * group it is in.
 *
 * Each row is HTML5-draggable (``draggable=true`` + native ``onDragStart``);
 * the canvas (``SldCanvas``) consumes the drag via a matching ``onDrop``
 * handler.
 *
 * MIME type: ``application/andes-component-type``. Custom MIME avoids
 * collision with browser-default DnD types (image, link, plain text)
 * that the canvas would otherwise inadvertently handle. The payload is
 * the kind's ``value`` ("Bus", "PV", "GENROU", "Transformer2W", ...), which
 * is the Kind picker's own value; the canvas places a draft of exactly the
 * model that was dragged where it was dropped (``store/drafts.ts``), and the
 * Inspector opens on its form.
 *
 * A row can also be clicked (or reached with Tab and pressed with Enter or
 * Space), which opens the Add element form on its model without a drag: dragging
 * is a fiddly gesture on a trackpad, and from the keyboard it is not possible at all. The arrow
 * keys move between the rows, and down from the search box into them. The rows
 * are one stop for the Tab key between them (the row the keyboard was last on,
 * or the first), so Tab leaves the list in one press. A line
 * under the search box says how to add, and says instead why nothing can be
 * added when that is so (``useAddComponent``). With no case open, a click
 * starts a blank system as a drop on the empty canvas does, and the line says
 * that too. The saved cases are on the sidebar's other tab, which the palette
 * hides, so with no case open a line above the search box leads there; and
 * after a reload of the page, which closes the case, a note over that line
 * names the case and reopens it (``ReloadedCaseNote``).
 *
 * Drag image: leaves the browser default (no ``dataTransfer.setDragImage``
 * call), which is a picture of the row.
 */

/** Custom DnD MIME — avoids collision with browser-default drag types. */
export const COMPONENT_DND_MIME = 'application/andes-component-type';

/** Shown under the search box while a row can add: to a case that is open, and with none. */
const HINT =
  'Click a component to add it, or drag it onto the diagram to place it as a draft. Dropped on a bus, it is connected to that bus.';
const HINT_NO_CASE =
  'Click a component, or drag it onto the diagram, to start a blank system with it.';

export interface ComponentLibraryProps {
  className?: string;
}

export function ComponentLibrary({ className }: ComponentLibraryProps) {
  const { blockedReason, add } = useAddComponent();
  const caseOpen = useCaseStore((s) => s.selection !== null);
  const caseLoading = useCaseStore((s) => s.loadingPath !== null);
  const showLeftSidebarTab = useLayoutStore((s) => s.showLeftSidebarTab);
  const [query, setQuery] = useState('');
  const sections = useMemo(() => groupElementKinds(searchElementKinds(query)), [query]);
  const shownKinds = sections.flatMap((section) => section.kinds);
  const shown = shownKinds.length;
  const searching = query.trim() !== '';
  // The one row Tab stops at: the row that last had the focus while the search
  // still shows it, and the first row otherwise.
  const [lastRow, setLastRow] = useState<string | null>(null);
  const tabStop = shownKinds.some((kind) => kind.value === lastRow)
    ? lastRow
    : (shownKinds[0]?.value ?? null);
  const hintId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-component-kind]') ?? []);

  const clearSearch = () => {
    setQuery('');
    searchRef.current?.focus();
  };

  // The arrow keys walk the rows; up from the first one is the search box.
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const all = rows();
    const at = all.indexOf(e.target as HTMLElement);
    if (at === -1) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && at === 0) {
      searchRef.current?.focus();
      return;
    }
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? all.length - 1
          : at + (e.key === 'ArrowDown' ? 1 : -1);
    all[Math.min(Math.max(next, 0), all.length - 1)]?.focus();
  };

  return (
    <div data-testid="component-library" className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* The search box and the line under it stay put while the list scrolls. */}
      <div className="border-border flex shrink-0 flex-col gap-1.5 border-b px-2 pt-2 pb-2">
        {/* With no case open: where the saved cases are, which this tab hides, and
            after a reload the case it closed. Above the search box, so that Tab
            still goes from the box straight into the rows. */}
        {!caseOpen && !caseLoading ? (
          <>
            <ReloadedCaseNote placement="components" />
            <p
              data-testid="component-library-no-case"
              className="text-muted-foreground px-0.5 text-[11px] leading-snug"
            >
              No case is open. To open a saved one, go to the{' '}
              <button
                type="button"
                onClick={() => showLeftSidebarTab('project')}
                data-testid="component-library-open-project"
                className={cn(
                  'text-foreground underline underline-offset-2',
                  'hover:text-primary focus-visible:outline-none',
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
                  'rounded-[var(--radius-sm)]',
                )}
              >
                Project tab
              </button>
              .
            </p>
          </>
        ) : null}
        <div className="relative">
          <SearchGlyph />
          <Input
            ref={searchRef}
            type="text"
            value={query}
            onChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.preventDefault();
                setQuery('');
              } else if (e.key === 'ArrowDown') {
                const first = rows()[0];
                if (first === undefined) return;
                e.preventDefault();
                first.focus();
              }
            }}
            placeholder="Search components"
            aria-label="Search components"
            data-testid="component-library-search"
            className="h-7 w-full py-0 pr-7 pl-7 text-xs"
          />
          {query !== '' ? (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear the search"
              data-testid="component-library-search-clear"
              className={cn(
                'text-muted-foreground hover:text-foreground',
                'absolute top-1/2 right-1 -translate-y-1/2',
                'rounded px-1.5 text-sm leading-none',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              )}
            >
              ×
            </button>
          ) : null}
        </div>
        <p
          id={hintId}
          data-testid="component-library-hint"
          className={cn(
            'text-[11px] leading-snug',
            blockedReason === null
              ? 'text-muted-foreground px-0.5'
              : 'border-warning/50 bg-warning/20 text-foreground rounded-[var(--radius-sm)] border px-2 py-1',
          )}
        >
          {blockedReason ?? (caseOpen ? HINT : HINT_NO_CASE)}
        </p>
        {/* Always in the tree, so a screen reader hears the count change as it is typed. */}
        <p
          role="status"
          data-testid="component-library-count"
          className={
            searching ? 'text-muted-foreground px-0.5 text-[11px] leading-none' : 'sr-only'
          }
        >
          {searching ? `${shown} of ${ELEMENT_KINDS.length} components` : ''}
        </p>
      </div>

      <div
        ref={listRef}
        onKeyDown={onListKeyDown}
        data-testid="component-library-list"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pt-2.5 pb-3"
      >
        {sections.length === 0 ? (
          <div
            data-testid="component-library-empty"
            className="text-muted-foreground flex flex-col items-start gap-1.5 px-0.5 pt-1 text-xs leading-snug"
          >
            <p>
              No component matches{' '}
              <span className="text-foreground font-medium break-all">“{query.trim()}”</span>.
              Search by name, model or category: “exciter”, “GENROU”, “load”.
            </p>
            <button
              type="button"
              onClick={clearSearch}
              data-testid="component-library-empty-clear"
              className={cn(
                'border-border text-primary rounded-[var(--radius-sm)] border px-2 py-0.5',
                'text-[11px] font-medium',
                'hover:bg-muted transition-colors duration-[var(--duration-fast)]',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              )}
            >
              Show all components
            </button>
          </div>
        ) : (
          sections.map(({ group, kinds }) => (
            <Group
              key={group}
              group={group}
              kinds={kinds}
              blockedReason={blockedReason}
              blockedId={hintId}
              tabStop={tabStop}
              onRowFocus={setLastRow}
              onAdd={add}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface GroupProps {
  group: string;
  kinds: readonly ElementKind[];
  /** Why nothing can be added now, or `null`. */
  blockedReason: string | null;
  /** The id of the element that shows `blockedReason`. */
  blockedId: string;
  /** The kind whose row is the list's stop for the Tab key, or `null` with no row. */
  tabStop: string | null;
  onRowFocus: (kind: string) => void;
  onAdd: (kind: string) => void;
}

function Group({ group, kinds, blockedReason, blockedId, tabStop, onRowFocus, onAdd }: GroupProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`component-library-group-${group}`}
      className="flex flex-col gap-0.5"
    >
      <h2
        id={headingId}
        className={cn(
          // Room under the heading for the focus ring of the first row.
          'text-muted-foreground/90 px-1 pb-1.5',
          'text-[10px] leading-none font-semibold tracking-[0.12em] uppercase',
        )}
      >
        {group}
      </h2>
      <ul role="list" className="flex flex-col gap-0.5">
        {kinds.map((kind) => (
          <li key={kind.value}>
            <Row
              kind={kind}
              blockedReason={blockedReason}
              blockedId={blockedId}
              tabStop={kind.value === tabStop}
              onFocus={onRowFocus}
              onAdd={onAdd}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  kind: ElementKind;
  blockedReason: string | null;
  blockedId: string;
  /** Whether Tab stops at this row; the arrow keys reach every row. */
  tabStop: boolean;
  onFocus: (kind: string) => void;
  onAdd: (kind: string) => void;
}

function Row({ kind, blockedReason, blockedId, tabStop, onFocus, onAdd }: RowProps) {
  const blocked = blockedReason !== null;
  const descriptionId = useId();
  return (
    <div
      role="button"
      tabIndex={tabStop ? 0 : -1}
      onFocus={() => onFocus(kind.value)}
      draggable={!blocked}
      aria-disabled={blocked ? true : undefined}
      data-testid={`component-library-item-${kind.value}`}
      data-component-kind={kind.value}
      aria-label={`Add ${kind.label}`}
      // What the kind is, then why it cannot be added now.
      aria-describedby={blocked ? `${descriptionId} ${blockedId}` : descriptionId}
      title={blocked ? blockedReason : `Add ${kind.label}: click here, or drag it onto the diagram`}
      onClick={() => {
        if (!blocked) onAdd(kind.value);
      }}
      onKeyDown={(e) => {
        // A button made of a div has to answer Enter and Space itself.
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!blocked) onAdd(kind.value);
      }}
      onDragStart={(e) => {
        if (blocked) {
          e.preventDefault();
          return;
        }
        // Native HTML5 DnD: write the kind payload + force the copy
        // cursor so the user gets a "+" affordance over the canvas.
        // The canvas onDrop reads the same MIME below.
        e.dataTransfer.setData(COMPONENT_DND_MIME, kind.value);
        e.dataTransfer.effectAllowed = 'copy';
        // A drop target cannot read the payload before the drop: the diagram
        // marks the bus under the pointer only for a kind that connects to one.
        useSldStore.getState().setPaletteDragKind(kind.value);
      }}
      onDragEnd={() => useSldStore.getState().setPaletteDragKind(null)}
      className={cn(
        'flex items-start gap-2 px-1 py-1',
        'rounded-[var(--radius-sm)] border border-transparent',
        blocked
          ? 'cursor-not-allowed opacity-50'
          : [
              'text-foreground hover:bg-muted hover:border-border',
              'cursor-pointer active:cursor-grabbing',
            ],
        'transition-colors duration-[var(--duration-fast)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'select-none',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'border-border bg-muted/40 text-muted-foreground',
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border',
        )}
      >
        <ElementKindGlyph kind={kind.value} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs leading-tight font-medium">{kind.label}</span>
        <span id={descriptionId} className="text-muted-foreground text-[11px] leading-snug">
          {kind.description}
        </span>
      </span>
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </svg>
  );
}
