import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

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
 * "Transformer"); the canvas decodes and routes to
 * ``useCaseStore.openAddPanel(kind, dropCoord)``.
 *
 * The library kinds use UI-facing labels (e.g., "Generator" rather
 * than "PV" / "Slack" / "GENROU"); the AddElementPanel's kind picker
 * still surfaces the full ANDES-class breakdown so the user picks the
 * right model once the form opens. Drag-from-tile sets the picker's
 * top-level kind only; the user finishes the picker selection inside
 * the form.
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
 * ZIP). The Component Library only carries the top-level family
 * — the picker handles the rest.
 */
export type ComponentLibraryKind = 'Bus' | 'Generator' | 'Load' | 'Shunt' | 'Line' | 'Transformer';

interface TileSpec {
  kind: ComponentLibraryKind;
  label: string;
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
];

export interface ComponentLibraryProps {
  className?: string;
}

export function ComponentLibrary({ className }: ComponentLibraryProps) {
  return (
    <div
      data-testid="component-library"
      className={cn('grid grid-cols-3 gap-1.5 px-2 pt-1 pb-3', className)}
    >
      {TILES.map((tile) => (
        <Tile key={tile.kind} {...tile} />
      ))}
    </div>
  );
}

function Tile({ kind, label, glyph }: TileSpec) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      data-testid={`component-library-tile-${kind}`}
      data-component-kind={kind}
      aria-label={`Drag ${label} onto canvas`}
      onDragStart={(e) => {
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
        'text-foreground hover:bg-muted/60 hover:border-muted-foreground/40',
        'cursor-grab active:cursor-grabbing',
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
// can scan the 3x2 grid at a glance. Stroke=currentColor so the icons
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
