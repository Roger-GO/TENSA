import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  ELEMENT_KINDS,
  groupElementKinds,
  searchElementKinds,
  type ElementKind,
} from '@/components/elements/elementKinds';
import { ControllerGlyph } from '@/components/sld/nodes/ControllerGlyph';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { useAddComponent } from '@/lib/useAddComponent';
import { useCaseStore } from '@/store/case';

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
 * is the Kind picker's own value; the canvas decodes and routes to
 * ``useCaseStore.openAddPanel(kind, dropCoord)``, so the form opens on
 * exactly the model that was dragged.
 *
 * A row can also be clicked (or reached with Tab and pressed with Enter or
 * Space), which opens the same form without a drag: dragging is a fiddly gesture
 * on a trackpad, and from the keyboard it is not possible at all. The arrow
 * keys move between the rows, and down from the search box into them. A line
 * under the search box says how to add, and says instead why nothing can be
 * added when that is so (``useAddComponent``). With no case open, a click
 * starts a blank system as a drop on the empty canvas does, and the line says
 * that too.
 *
 * Drag image: leaves the browser default (no ``dataTransfer.setDragImage``
 * call), which is a picture of the row.
 */

/** Custom DnD MIME — avoids collision with browser-default drag types. */
export const COMPONENT_DND_MIME = 'application/andes-component-type';

/** Shown under the search box while a row can add: to a case that is open, and with none. */
const HINT = 'Click a component to add it, or drag it onto the diagram.';
const HINT_NO_CASE =
  'Click a component, or drag it onto the diagram, to start a blank system with it.';

export interface ComponentLibraryProps {
  className?: string;
}

export function ComponentLibrary({ className }: ComponentLibraryProps) {
  const { blockedReason, add } = useAddComponent();
  const caseOpen = useCaseStore((s) => s.selection !== null);
  const [query, setQuery] = useState('');
  const sections = useMemo(() => groupElementKinds(searchElementKinds(query)), [query]);
  const shown = sections.reduce((count, section) => count + section.kinds.length, 0);
  const searching = query.trim() !== '';
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
  onAdd: (kind: string) => void;
}

function Group({ group, kinds, blockedReason, blockedId, onAdd }: GroupProps) {
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
            <Row kind={kind} blockedReason={blockedReason} blockedId={blockedId} onAdd={onAdd} />
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
  onAdd: (kind: string) => void;
}

function Row({ kind, blockedReason, blockedId, onAdd }: RowProps) {
  const blocked = blockedReason !== null;
  const descriptionId = useId();
  return (
    <div
      role="button"
      tabIndex={0}
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
      }}
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
        {GLYPHS[kind.value] ?? <BlockGlyph />}
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

// ---------------------------------------------------------------------------
// Inline-SVG glyphs: the symbol the diagram draws for the kind
// (`src/icons/iec60617`), so a row reads as what it puts there. Stroke is
// currentColor so the icons inherit `text-muted-foreground` from the wrapper
// in both themes; an exciter and a governor use the glyph of their badge on
// the diagram.
// ---------------------------------------------------------------------------

const GLYPH_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'h-[18px] w-[18px]',
} as const;

const GLYPHS: Readonly<Record<string, ReactNode>> = {
  Bus: <BusGlyph />,
  Line: <LineGlyph />,
  Transformer2W: <TransformerGlyph />,
  PV: <GeneratorGlyph />,
  Slack: <GeneratorGlyph />,
  GENROU: <MachineGlyph />,
  GENCLS: <MachineGlyph />,
  IEEEX1: <ControllerGlyph subKind="exciter" className="h-[18px] w-[18px]" />,
  ESDC2A: <ControllerGlyph subKind="exciter" className="h-[18px] w-[18px]" />,
  EXST1: <ControllerGlyph subKind="exciter" className="h-[18px] w-[18px]" />,
  SEXS: <ControllerGlyph subKind="exciter" className="h-[18px] w-[18px]" />,
  TGOV1: <ControllerGlyph subKind="governor" className="h-[18px] w-[18px]" />,
  IEEEG1: <ControllerGlyph subKind="governor" className="h-[18px] w-[18px]" />,
  ESD1: <BatteryGlyph />,
  PQ: <LoadGlyph />,
  ZIP: <LoadGlyph />,
  Shunt: <ShuntGlyph />,
};

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

function BusGlyph() {
  // The bar a bus is drawn as, with its two end ticks.
  return (
    <svg {...GLYPH_PROPS}>
      <line x1="3" y1="12" x2="21" y2="12" strokeWidth="2.5" />
      <line x1="3" y1="9" x2="3" y2="15" />
      <line x1="21" y1="9" x2="21" y2="15" />
    </svg>
  );
}

function LineGlyph() {
  // Two terminal dots + a horizontal line between them.
  return (
    <svg {...GLYPH_PROPS}>
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" />
      <circle cx="20" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function TransformerGlyph() {
  // Two overlapping circles — the conventional 2-winding transformer.
  return (
    <svg {...GLYPH_PROPS}>
      <circle cx="9" cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </svg>
  );
}

function GeneratorGlyph() {
  // A circle with one sine wave: the source of the power flow.
  return (
    <svg {...GLYPH_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 12q3-4.5 6 0t6 0" />
    </svg>
  );
}

function MachineGlyph() {
  // The generator's circle and sine, over the winding of a synchronous machine.
  return (
    <svg {...GLYPH_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 10q3-4.5 6 0t6 0" />
      <path d="M7 16q.5 2 1.6 2 1.2 0 1.5-2 .3-2 1.5-2 1.2 0 1.5 2 .3 2 1.5 2 1.1 0 1.6-2" />
    </svg>
  );
}

function LoadGlyph() {
  // The arrow a load is drawn as: a stem into a triangle that points down.
  return (
    <svg {...GLYPH_PROPS}>
      <line x1="12" y1="2" x2="12" y2="8" />
      <path d="M4 8h16l-8 14z" />
    </svg>
  );
}

function ShuntGlyph() {
  // A capacitor from the bus to the three bars of ground.
  return (
    <svg {...GLYPH_PROPS}>
      <line x1="12" y1="2" x2="12" y2="9" />
      <line x1="6" y1="9" x2="18" y2="9" />
      <line x1="6" y1="12.5" x2="18" y2="12.5" />
      <line x1="12" y1="12.5" x2="12" y2="17" />
      <line x1="7" y1="17" x2="17" y2="17" />
      <line x1="9.5" y1="19.75" x2="14.5" y2="19.75" />
      <line x1="11.25" y1="22.25" x2="12.75" y2="22.25" />
    </svg>
  );
}

function BatteryGlyph() {
  // A cell on its side with its terminal cap, and the two plates of the
  // battery symbol inside it.
  return (
    <svg {...GLYPH_PROPS}>
      <rect x="3" y="7" width="16" height="10" rx="1.5" />
      <line x1="21.5" y1="10.5" x2="21.5" y2="13.5" />
      <line x1="9.5" y1="9.5" x2="9.5" y2="14.5" />
      <line x1="12.5" y1="11" x2="12.5" y2="13" />
    </svg>
  );
}

function BlockGlyph() {
  // A plain block, for a kind the list gains before it has a symbol here.
  return (
    <svg {...GLYPH_PROPS}>
      <rect x="5" y="7" width="14" height="10" rx="1.5" />
    </svg>
  );
}
