import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Spacing scale step. Maps to Tailwind's default 4px-baseline scale —
 * `gap-1` = 4px, `gap-2` = 8px, … `gap-16` = 64px. Restricted here to the
 * 8 steps the v0.1 plan calls out so spacing decisions go through a finite
 * vocabulary rather than arbitrary `gap-N` choices in component files.
 */
export type SpacingStep = 0 | 1 | 2 | 3 | 4 | 6 | 8 | 12 | 16;

export type StackAlign = 'start' | 'center' | 'end' | 'stretch';
export type StackJustify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between children, in 4px-baseline steps. Default: 2 (8px). */
  gap?: SpacingStep;
  /** Cross-axis alignment. Default: stretch. */
  align?: StackAlign;
  /** Main-axis distribution. Default: start. */
  justify?: StackJustify;
  /** Wrap children when they overflow. Default: false. */
  wrap?: boolean;
  /** Render as inline-flex instead of flex. Default: false. */
  inline?: boolean;
}

const GAP_CLASS: Record<SpacingStep, string> = {
  0: 'gap-0',
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  6: 'gap-6',
  8: 'gap-8',
  12: 'gap-12',
  16: 'gap-16',
};

const ALIGN_CLASS: Record<StackAlign, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
};

const JUSTIFY_CLASS: Record<StackJustify, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
  around: 'justify-around',
  evenly: 'justify-evenly',
};

/**
 * Stack. Vertical flex container. Thin wrapper around `<div>` whose only
 * purpose is to funnel spacing decisions through the token scale (rather
 * than letting components scatter `flex flex-col gap-N` across the codebase).
 */
export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  {
    gap = 2,
    align = 'stretch',
    justify = 'start',
    wrap = false,
    inline = false,
    className,
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        inline ? 'inline-flex' : 'flex',
        'flex-col',
        GAP_CLASS[gap],
        ALIGN_CLASS[align],
        JUSTIFY_CLASS[justify],
        wrap && 'flex-wrap',
        className,
      )}
      {...props}
    />
  );
});
