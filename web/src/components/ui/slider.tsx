import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/cn';

/**
 * Slider. Wraps Radix Slider. Reserved for v0.2's time-scrub control on the
 * SLD. Included in v0.1's component library to keep the design system
 * complete in one unit and avoid retroactive token edits when v0.2 lands.
 *
 * Supports controlled (`value`) and uncontrolled (`defaultValue`) usage;
 * keyboard: arrow keys step by `step`, Page Up/Down step by 10×, Home/End
 * jump to min/max — all via Radix.
 */
export const Slider = forwardRef<
  ElementRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(function Slider({ className, ...props }, ref) {
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none items-center select-none',
        'data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="bg-muted relative h-1.5 w-full grow overflow-hidden rounded-full">
        <SliderPrimitive.Range className="bg-primary absolute h-full" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          'border-primary bg-background block h-4 w-4 rounded-full border shadow-sm',
          'transition-[transform,box-shadow]',
          'duration-[var(--duration-fast)] ease-[var(--ease-out-spring)]',
          'hover:scale-110',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      />
    </SliderPrimitive.Root>
  );
});
