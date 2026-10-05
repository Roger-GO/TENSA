import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useAddComponent } from '@/lib/useAddComponent';

/**
 * ComponentLibrary (v3 Unit 5).
 *
 * 3-column grid of draggable tiles representing the supported element
 * kinds. Each tile is HTML5-draggable (``draggable=true`` + native
 * ``onDragStart``); the canvas (``SldCanvas``) consumes the drag via a
 * matching ``onDrop`` handler.
 *
 * MIME type: ``application/andes-component-type``. Custom MIME avoids
 * collision with browser-default DnD types (image, link, plain text)
 * that the canvas would otherwise inadvertently handle. The payload is
 * the kind string ("Bus", "Generator", "Load", "Shunt", "Line",
 * "Transformer", "Battery"); the canvas decodes and routes to
 * ``useCaseStore.openAddPanel(kind, dropCoord)``.
 *
 * A tile can also be clicked (or reached with Tab and pressed with Enter or
 * Space), which opens the same form without a drag: dragging is a fiddly gesture
 * on a trackpad, and from the keyboard it is not possible at all. A line under
 * the tiles says so, and says instead why nothing can be added when that is so
 * (``useAddComponent``). With no case open, a click starts a blank system as a
 * drop on the empty canvas does.
 *
 * The library kinds use UI-facing labels (e.g., "Generator" rather
 * than "PV" / "Slack" / "GENROU"); the AddElementPanel's kind picker
 * still surfaces the full ANDES-class breakdown so the user picks the
 * right model once the form opens. A tile sets the picker's top-level
 * kind only (the panel opens a family on its most common model); the
 * user finishes the picker selection inside the form.
 *
 * The Battery tile is the one that names a single model, ANDES's ESD1: storage
 * is what a user looks for here, and the picker's Storage group is out of sight
 * until a form is open. Its name and tooltip say "ESD1 storage" as well, so it
 * is found under either word. The line under the tiles says where the models
 * without a tile are.
 *
 * Drag image: leaves the browser default for v3.0 (no
 * ``dataTransfer.setDragImage`` call). Design-iterator can polish in
 * a later phase per the v3 Risk table.
 */

/** Custom DnD MIME — avoids collision with browser-default drag types. */
export const COMPONENT_DND_MIME = 'application/andes-component-type';

/**
 * Element-kind handle used in the DnD payload. These map to the
 * ``addPanelKind`` values the AddElementPanel kind picker accepts; the
 * panel reads ``addPanelKind`` and renders the matching ANDES-model
 * sub-picker (Generators → PV / Slack / GENROU / GENCLS; Loads → PQ /
 * ZIP; Battery → ESD1). The Component Library only carries the top-level
 * family — the picker handles the rest.
 */
export type ComponentLibraryKind =
  | 'Bus'
  | 'Generator'
  | 'Load'
  | 'Shunt'
  | 'Line'
  | 'Transformer'
  | 'Battery';

interface TileSpec {
  kind: ComponentLibraryKind;
  label: string;
  /** What else the tile is known as, added to its name and tooltip in brackets. */
  detail?: string;
  /** Inline-SVG glyph rendered above the label. */
  glyph: ReactNode;
}

const TILES: readonly TileSpec[] = [
  { kind: 'Bus', label: 'Bus', glyph: <BusGlyph /> },
  { kind: 'Generator', label: 'Generator', glyph: <GeneratorGlyph /> },
  { kind: 'Load', label: 'Load', glyph: <LoadGlyph /> },
  { kind: 'Shunt', label: 'Shunt', glyph: <ShuntGlyph /> },
  { kind: 'Line', label: 'Line', glyph: <LineGlyph /> },
  { kind: 'Transformer', label: 'Transformer', glyph: <TransformerGlyph /> },
  { kind: 'Battery', label: 'Battery', detail: 'ESD1 storage', glyph: <BatteryGlyph /> },
];

/** Shown under the tiles while a tile can add. */
const HINT =
  "Click a tile to add that element, or drag it onto the diagram. The form's Kind list has the other models: machines, exciters, governors.";

export interface ComponentLibraryProps {
  className?: string;
}

export function ComponentLibrary({ className }: ComponentLibraryProps) {
  const { blockedReason, add } = useAddComponent();
  return (
    <div data-testid="component-library" className={cn('px-2 pt-1 pb-3', className)}>
      <div className="grid grid-cols-3 gap-1.5">
        {TILES.map((tile) => (
          <Tile key={tile.kind} {...tile} blockedReason={blockedReason} onAdd={add} />
        ))}
      </div>
      <p
        data-testid="component-library-hint"
        className={cn(
          'mt-2 px-0.5 text-[11px] leading-snug',
          blockedReason === null ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {blockedReason ?? HINT}
      </p>
    </div>
  );
}

interface TileProps extends TileSpec {
  /** Why nothing can be added now, or `null`. */
  blockedReason: string | null;
  onAdd: (kind: string) => void;
}

function Tile({ kind, label, detail, glyph, blockedReason, onAdd }: TileProps) {
  const blocked = blockedReason !== null;
  const also = detail === undefined ? '' : ` (${detail})`;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!blocked}
      aria-disabled={blocked ? true : undefined}
      data-testid={`component-library-tile-${kind}`}
      data-component-kind={kind}
      aria-label={`Add ${label}${also}`}
      title={
        blocked
          ? blockedReason
          : `Add a ${label.toLowerCase()}${also}: click here, or drag it onto the diagram`
      }
      onClick={() => {
        if (!blocked) onAdd(kind);
      }}
      onKeyDown={(e) => {
        // A button made of a div has to answer Enter and Space itself.
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!blocked) onAdd(kind);
      }}
      onDragStart={(e) => {
        if (blocked) {
          e.preventDefault();
          return;
        }
        // Native HTML5 DnD: write the kind payload + force the copy
        // cursor so the user gets a "+" affordance over the canvas.
        // The canvas onDrop reads the same MIME below.
        e.dataTransfer.setData(COMPONENT_DND_MIME, kind);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      className={cn(
        'flex flex-col items-center justify-center gap-1',
        'min-h-[56px] px-1 py-2',
        'rounded-[var(--radius-sm)] border',
        'border-border bg-background',
        blocked
          ? 'cursor-not-allowed opacity-50'
          : [
              'text-foreground hover:bg-muted/60 hover:border-muted-foreground/40',
              'cursor-pointer active:cursor-grabbing',
            ],
        'transition-colors duration-[var(--duration-fast)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'select-none',
      )}
    >
      <span aria-hidden="true" className="text-muted-foreground">
        {glyph}
      </span>
      <span className="text-[10px] leading-none font-medium tracking-wide">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline-SVG glyphs. Each is small + visually distinguishable so the user
// can scan the 3-column grid at a glance. Stroke=currentColor so the icons
// inherit `text-muted-foreground` from the wrapper.
// ---------------------------------------------------------------------------

function BusGlyph() {
  // Circle — matches the BusNode's circular bus marker on the SLD.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-5 w-5"
    >
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

function GeneratorGlyph() {
  // Lightning bolt — visually maps to "energy source".
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}

function LoadGlyph() {
  // Diamond / rotated square — visually distinct from circle + triangle.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M12 3 21 12 12 21 3 12z" />
    </svg>
  );
}

function ShuntGlyph() {
  // Triangle — the conventional reactive-shunt symbol in single-line
  // diagrams.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M12 4 21 20H3z" />
    </svg>
  );
}

function LineGlyph() {
  // Two terminal dots + a horizontal line between them.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-5 w-5"
    >
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" />
      <circle cx="20" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function TransformerGlyph() {
  // Two overlapping circles — the conventional 2-winding transformer.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-5 w-5"
    >
      <circle cx="9" cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </svg>
  );
}

function BatteryGlyph() {
  // A cell on its side with its terminal cap, and the two plates of the
  // battery symbol inside it.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <rect x="3" y="7" width="16" height="10" rx="1.5" />
      <line x1="21.5" y1="10.5" x2="21.5" y2="13.5" />
      <line x1="9.5" y1="9.5" x2="9.5" y2="14.5" />
      <line x1="12.5" y1="11" x2="12.5" y2="13" />
    </svg>
  );
}
