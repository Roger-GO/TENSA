import { useCaseStore } from '@/store/case';
import { __requestRouteEdit, __requestRouteReset, useSldStore } from '@/store/sld';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * RouteSection.
 *
 * Rendered under the Properties of a selected line or transformer: how its
 * route on the diagram is drawn (by the diagram, or by hand), and the two
 * things to do about it. Move route by hand shows the handles of the line on
 * the diagram, as a click on the line does, and brings it into view; Reset
 * route gives a route that was drawn by hand back to the automatic routing.
 *
 * A line is a pixel or two wide, and this is where its route is reached
 * without aiming at it. The canvas does both (`__requestRouteEdit`,
 * `__requestRouteReset`): only it has the diagram as drawn. A button that
 * can do nothing says why beside it.
 */
export function RouteSection({ className }: { className?: string }) {
  const selected = useCaseStore((s) => s.selectedElement);
  const locked = useSldStore((s) => s.diagramLocked);
  const idx = selected?.kind === 'line' || selected?.kind === 'transformer' ? selected.idx : null;
  const manual = useSldStore((s) => idx !== null && s.manualBranchIdxes.includes(idx));
  if (selected === null || idx === null) return null;
  const what = selected.kind === 'transformer' ? 'transformer' : 'line';

  return (
    <section
      data-testid="route-section"
      aria-label="Route on the diagram"
      className={cn('border-border flex flex-col gap-1.5 border-t pt-2', className)}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-muted-foreground text-[10px] font-semibold tracking-[0.08em] uppercase">
          Route on the diagram
        </h3>
        <span
          data-testid="route-section-status"
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium',
            manual ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {manual ? 'Routed by hand' : 'Routed automatically'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked}
          data-testid="route-section-edit"
          title={`Shows the handles of this ${what} on the diagram: drag a run to slide it, a square to move a bend, a + to add one.`}
          onClick={() => __requestRouteEdit(idx)}
          className="h-7 px-2 text-xs"
        >
          Move route by hand
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked || !manual}
          data-testid="route-section-reset"
          title="Gives this route back to the automatic routing. Undo brings your route back."
          onClick={() => __requestRouteReset(idx)}
          className="h-7 px-2 text-xs"
        >
          Reset route
        </Button>
      </div>
      <p
        data-testid="route-section-note"
        className="text-muted-foreground text-[11px] leading-snug"
      >
        {locked
          ? 'The diagram is locked: unlock it with the padlock at its lower left to move a line.'
          : manual
            ? `You drew this route. Tidy diagram leaves it as it is; Reset route hands it back to the diagram.`
            : `The diagram drew this route, so there is nothing to reset. Move route by hand makes it yours.`}
      </p>
    </section>
  );
}
