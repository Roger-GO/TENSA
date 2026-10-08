import type { ControllerSubKind } from '@/lib/controllers';
import { cn } from '@/lib/cn';
import { CONTROLLER_GLYPH_BOX, CONTROLLER_GLYPH_PARTS } from './controllerGlyphShapes';

/**
 * Inline line glyph for a controller sub-kind. Stroke uses `currentColor`,
 * so the icon inherits the surrounding text colour. Shared by the SLD
 * `ControllerNode` badge (Unit 19) and the rows of the inspector's
 * `GeneratingUnitSection` so both surfaces stay visually consistent.
 *
 * Per-class IEC 60617 art is deferred; these are neutral schematic symbols
 * discriminated by sub-kind only. Their parts are in
 * `controllerGlyphShapes.ts`, which the figure of the diagram draws from as
 * well.
 */
export function ControllerGlyph({
  subKind,
  className,
}: {
  subKind: ControllerSubKind;
  className?: string;
}) {
  const { size, strokeWidth } = CONTROLLER_GLYPH_BOX;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-3.5 w-3.5', className)}
    >
      {CONTROLLER_GLYPH_PARTS[subKind].map((part, i) =>
        'd' in part ? (
          <path key={i} d={part.d} />
        ) : 'circle' in part ? (
          <circle key={i} {...part.circle} />
        ) : (
          <rect key={i} {...part.rect} />
        ),
      )}
    </svg>
  );
}
