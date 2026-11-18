import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { ComponentDropZone } from './ComponentDropZone';
import { tooLargeToOffer } from './largeCase';

export interface SldTooLargeProps {
  /** How many buses the case has. */
  buses: number;
  /** The person asked for the diagram all the same. */
  onDraw: () => void;
  /**
   * The diagram was asked for and is about to be drawn: the button gives way to
   * a line that says the page will not answer, which is on screen before the
   * page stops answering.
   */
  drawing?: boolean;
  className?: string;
}

/**
 * SldTooLarge: stands where the diagram would, for a case with more buses
 * than `DRAW_AT_ONCE_BUSES`. It says why and what still works. Up to
 * `DRAW_ON_REQUEST_BUSES` it offers the diagram to anyone who is willing to
 * wait for it; above that it does not, since the page would stop answering
 * for longer than the server keeps its session.
 *
 * It is a drop target like the empty page of a system with no buses: a row of the Components
 * palette dropped here has no diagram to stand on, so it opens the form for that kind (the way
 * to add an element to a case whose diagram is not drawn) and a notice says why, where a drop
 * that did nothing would leave the person wondering.
 */
export function SldTooLarge({ buses, onDraw, drawing = false, className }: SldTooLargeProps) {
  const offered = !tooLargeToOffer(buses);
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  return (
    <ComponentDropZone
      onDropComponent={(kind) => {
        openAddPanel(kind);
        toast.info('The diagram is not drawn, so there is nothing to drop it on', {
          id: 'sld-too-large-drop',
          description: 'The form to add it opens instead.',
        });
      }}
      role="status"
      data-testid="sld-too-large"
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-4 p-8',
        'text-center',
        className,
      )}
    >
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-foreground text-base font-semibold">
          The diagram of {buses.toLocaleString('en-US')} buses is not drawn
          {offered ? ' yet' : ''}
        </h2>
        <p className="text-muted-foreground text-sm">
          {offered
            ? 'A diagram this large takes up to a minute to draw, and the page does not answer while it does. '
            : 'A diagram this large takes five minutes or more to draw. The page does not answer for that long, and the server closes the session of a page that is silent for three. '}
          The tables, the power flow and its violations, and the analyses work without it, and so do
          their exports.
        </p>
      </div>
      {!offered ? null : drawing ? (
        <p className="text-foreground text-sm font-medium" data-testid="sld-drawing">
          Drawing the diagram. The page does not answer until it is done.
        </p>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="md"
          onClick={onDraw}
          data-testid="sld-draw-anyway"
        >
          Draw the diagram anyway
        </Button>
      )}
    </ComponentDropZone>
  );
}
