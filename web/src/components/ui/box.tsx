import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import type { SpacingStep } from './stack';

export interface BoxProps extends HTMLAttributes<HTMLDivElement> {
  /** Padding on all sides, in 4px-baseline steps. */
  p?: SpacingStep;
  /** Horizontal padding (left + right). Overrides `p`. */
  px?: SpacingStep;
  /** Vertical padding (top + bottom). Overrides `p`. */
  py?: SpacingStep;
}

const P_CLASS: Record<SpacingStep, string> = {
  0: 'p-0',
  1: 'p-1',
  2: 'p-2',
  3: 'p-3',
  4: 'p-4',
  6: 'p-6',
  8: 'p-8',
  12: 'p-12',
  16: 'p-16',
};

const PX_CLASS: Record<SpacingStep, string> = {
  0: 'px-0',
  1: 'px-1',
  2: 'px-2',
  3: 'px-3',
  4: 'px-4',
  6: 'px-6',
  8: 'px-8',
  12: 'px-12',
  16: 'px-16',
};

const PY_CLASS: Record<SpacingStep, string> = {
  0: 'py-0',
  1: 'py-1',
  2: 'py-2',
  3: 'py-3',
  4: 'py-4',
  6: 'py-6',
  8: 'py-8',
  12: 'py-12',
  16: 'py-16',
};

/**
 * Box. Plain `<div>` with token-validated padding. Use when a region needs
 * spacing but no flex layout — e.g., a card-shaped container around content.
 */
export const Box = forwardRef<HTMLDivElement, BoxProps>(function Box(
  { p, px, py, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        p !== undefined && P_CLASS[p],
        px !== undefined && PX_CLASS[px],
        py !== undefined && PY_CLASS[py],
        className,
      )}
      {...props}
    />
  );
});
