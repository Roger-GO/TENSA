import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/cn';

/**
 * ToggleGroup. Wraps Radix ToggleGroup, used for the top bar's view-mode
 * toggles (e.g., "Show voltage labels", "Show flow arrows", "Show element
 * IDs"). Single or multiple-selection — caller picks via Radix's `type`
 * prop.
 */
export const ToggleGroup = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(function ToggleGroup({ className, ...props }, ref) {
  return (
    <ToggleGroupPrimitive.Root
      ref={ref}
      className={cn(
        'bg-muted inline-flex items-center gap-1 rounded-[var(--radius-md)] p-1',
        className,
      )}
      {...props}
    />
  );
});

export const ToggleGroupItem = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(function ToggleGroupItem({ className, ...props }, ref) {
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)]',
        'text-muted-foreground px-2.5 py-1 text-sm',
        'transition-[background-color,color]',
        'duration-[var(--duration-fast)] ease-[var(--ease-out-spring)]',
        'hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
});
