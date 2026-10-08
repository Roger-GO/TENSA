import type { ReactNode } from 'react';
import { ControllerGlyph } from '@/components/sld/nodes/ControllerGlyph';
import { cn } from '@/lib/cn';

/**
 * The symbol of a kind of element the app can add (`ELEMENT_KINDS`): the one
 * the diagram draws for it (`src/icons/iec60617`), as an inline SVG. A row of
 * the Components palette shows it, and so does a draft on the diagram and in
 * the Inspector, so a kind reads the same wherever it is offered or placed.
 *
 * Stroke is currentColor so the symbol takes the colour of the text around it
 * in both themes; an exciter and a governor use the glyph of their badge on
 * the diagram.
 */
export interface ElementKindGlyphProps {
  /** A `value` of `ELEMENT_KINDS`; a kind without a symbol of its own gets a plain block. */
  kind: string;
  /** The size of the symbol. Default: 18 px square, the size of a palette row. */
  className?: string;
}

const DEFAULT_SIZE = 'h-[18px] w-[18px]';

export function ElementKindGlyph({ kind, className = DEFAULT_SIZE }: ElementKindGlyphProps) {
  const controller = CONTROLLER_GLYPHS[kind];
  if (controller !== undefined)
    return <ControllerGlyph subKind={controller} className={className} />;
  const draw = GLYPHS[kind] ?? blockGlyph;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(className)}
    >
      {draw}
    </svg>
  );
}

const CONTROLLER_GLYPHS: Readonly<Record<string, 'exciter' | 'governor'>> = {
  IEEEX1: 'exciter',
  ESDC2A: 'exciter',
  EXST1: 'exciter',
  SEXS: 'exciter',
  TGOV1: 'governor',
  IEEEG1: 'governor',
};

// The bar a bus is drawn as, with its two end ticks.
const busGlyph = (
  <>
    <line x1="3" y1="12" x2="21" y2="12" strokeWidth="2.5" />
    <line x1="3" y1="9" x2="3" y2="15" />
    <line x1="21" y1="9" x2="21" y2="15" />
  </>
);

// Two terminal dots + a horizontal line between them.
const lineGlyph = (
  <>
    <line x1="4" y1="12" x2="20" y2="12" />
    <circle cx="4" cy="12" r="1.5" fill="currentColor" />
    <circle cx="20" cy="12" r="1.5" fill="currentColor" />
  </>
);

// Two overlapping circles — the conventional 2-winding transformer.
const transformerGlyph = (
  <>
    <circle cx="9" cy="12" r="5" />
    <circle cx="15" cy="12" r="5" />
  </>
);

// A circle with one sine wave: the source of the power flow.
const generatorGlyph = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M6 12q3-4.5 6 0t6 0" />
  </>
);

// The generator's circle and sine, over the winding of a synchronous machine.
const machineGlyph = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M6 10q3-4.5 6 0t6 0" />
    <path d="M7 16q.5 2 1.6 2 1.2 0 1.5-2 .3-2 1.5-2 1.2 0 1.5 2 .3 2 1.5 2 1.1 0 1.6-2" />
  </>
);

// The arrow a load is drawn as: a stem into a triangle that points down.
const loadGlyph = (
  <>
    <line x1="12" y1="2" x2="12" y2="8" />
    <path d="M4 8h16l-8 14z" />
  </>
);

// A capacitor from the bus to the three bars of ground.
const shuntGlyph = (
  <>
    <line x1="12" y1="2" x2="12" y2="9" />
    <line x1="6" y1="9" x2="18" y2="9" />
    <line x1="6" y1="12.5" x2="18" y2="12.5" />
    <line x1="12" y1="12.5" x2="12" y2="17" />
    <line x1="7" y1="17" x2="17" y2="17" />
    <line x1="9.5" y1="19.75" x2="14.5" y2="19.75" />
    <line x1="11.25" y1="22.25" x2="12.75" y2="22.25" />
  </>
);

// A cell on its side with its terminal cap, and the two plates of the
// battery symbol inside it.
const batteryGlyph = (
  <>
    <rect x="3" y="7" width="16" height="10" rx="1.5" />
    <line x1="21.5" y1="10.5" x2="21.5" y2="13.5" />
    <line x1="9.5" y1="9.5" x2="9.5" y2="14.5" />
    <line x1="12.5" y1="11" x2="12.5" y2="13" />
  </>
);

// A plain block, for a kind the list gains before it has a symbol here.
const blockGlyph = <rect x="5" y="7" width="14" height="10" rx="1.5" />;

const GLYPHS: Readonly<Record<string, ReactNode>> = {
  Bus: busGlyph,
  Line: lineGlyph,
  Transformer2W: transformerGlyph,
  PV: generatorGlyph,
  Slack: generatorGlyph,
  GENROU: machineGlyph,
  GENCLS: machineGlyph,
  ESD1: batteryGlyph,
  PQ: loadGlyph,
  ZIP: loadGlyph,
  Shunt: shuntGlyph,
};
