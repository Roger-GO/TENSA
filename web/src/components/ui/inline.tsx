import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import type { SpacingStep, StackAlign, StackJustify } from './stack';

export interface InlineProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between children, in 4px-baseline steps. Default: 2 (8px). */
  gap?: SpacingStep;
  /** Cross-axis alignment. Default: center. */
  align?: StackAlign;
  /** Main-axis distribution. Default: start. */
  justify?: StackJustify;
  /** Wrap children when they overflow. Default: false. */
  wrap?: boolean;
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
 * Inline. Horizontal flex container. Counterpart to `Stack`. Defaults to
 * `align: center` because the vast majority of horizontal flex layouts in
 * the v0.1 UI (top-bar controls, table-cell pairs, button rows) center
 * their children vertically.
 */
export const Inline = forwardRef<HTMLDivElement, InlineProps>(function Inline(
  { gap = 2, align = 'center', justify = 'start', wrap = false, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-row',
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
