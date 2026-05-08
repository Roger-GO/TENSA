import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/cn';

/**
 * Tooltip. Wraps Radix Tooltip primitive. Behavior (delay, hover-vs-focus
 * triggers, ARIA labelling, portal rendering) is forwarded unchanged.
 *
 * The Provider is exposed so a single instance can wrap the app shell, but
 * individual Tooltip instances may also be used standalone — Radix handles
 * Provider absence gracefully.
 *
 * `<TooltipProvider delayDuration={...}>` is recommended at the app root.
 * Default delay is 200ms which matches `--duration-base`.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, children, ...props }, ref) {
  return (
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'border-border bg-foreground z-50 max-w-xs rounded-[var(--radius-sm)] border px-2.5 py-1.5',
        'text-background text-xs shadow-md',
        'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0',
        'data-[state=delayed-open]:zoom-in-95 data-[state=closed]:zoom-out-95',
        className,
      )}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  );
});
