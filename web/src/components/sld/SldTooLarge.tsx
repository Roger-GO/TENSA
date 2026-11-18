import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export interface SldTooLargeProps {
  /** How many buses the case has. */
  buses: number;
  /** The person asked for the diagram all the same. */
  onDraw: () => void;
  className?: string;
}

/**
 * SldTooLarge: stands where the diagram would, for a case with more buses
 * than `DRAW_AT_ONCE_BUSES`. It says why and what still works, and offers the
 * diagram to anyone who is willing to wait for it.
 */
export function SldTooLarge({ buses, onDraw, className }: SldTooLargeProps) {
  return (
    <div
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
          The diagram of {buses.toLocaleString('en-US')} buses is not drawn yet
        </h2>
        <p className="text-muted-foreground text-sm">
          A diagram this large takes minutes to draw, and the page does not answer while it does.
          The tables, the power flow and its violations, and the analyses work without it, and so do
          their exports.
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="md"
        onClick={onDraw}
        data-testid="sld-draw-anyway"
      >
        Draw the diagram anyway
      </Button>
    </div>
  );
}
