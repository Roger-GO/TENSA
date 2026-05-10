import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/cn';

/**
 * Visual variant. Controls background + foreground + hover state.
 *
 * - `primary`: filled with `--color-primary`. Default for the destination of
 *   the active task (e.g., "Run PF").
 * - `secondary`: filled with `--color-muted`. Used for non-primary actions
 *   that share top-level prominence with the primary action.
 * - `ghost`: transparent until hover. Used for icon-only and tertiary actions.
 * - `outline`: bordered, transparent fill. Used for "neutral" actions where
 *   `secondary` would compete visually with adjacent primary.
 * - `danger`: filled with `--color-danger`. Used only for destructive
 *   confirmations (R18 reserves modals for these).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';

/**
 * Visual size. Maps to height + horizontal padding + text size. The `icon`
 * size is square, intended for icon-only buttons (e.g., a close affordance).
 */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * When true, render the child element instead of a `<button>`, forwarding
   * all props to it. Mirrors Radix's `asChild` pattern; useful for wrapping
   * a `<Link>` while keeping button styling.
   */
  asChild?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: cn(
    'bg-primary text-primary-foreground shadow-sm',
    'hover:bg-[color-mix(in_oklch,var(--color-primary)_92%,white)] hover:shadow',
    'active:translate-y-px active:shadow-none',
  ),
  secondary: cn(
    'bg-muted text-foreground shadow-sm',
    'hover:bg-[color-mix(in_oklch,var(--color-muted)_88%,var(--color-foreground))]',
    'active:translate-y-px',
  ),
  ghost: cn('bg-transparent text-foreground', 'hover:bg-muted', 'active:translate-y-px'),
  outline: cn(
    'border border-border bg-transparent text-foreground',
    'hover:bg-muted',
    'active:translate-y-px',
  ),
  danger: cn(
    'bg-danger text-danger-foreground shadow-sm',
    'hover:bg-[color-mix(in_oklch,var(--color-danger)_90%,white)] hover:shadow',
    'active:translate-y-px active:shadow-none',
  ),
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-6 text-base',
  icon: 'h-9 w-9 p-0',
};

/**
 * Button. Wraps a native `<button>` with the project's design tokens. When
 * `asChild` is set, forwards to the child element via Radix's `Slot` so the
 * button's styling can ride on top of an arbitrary tag (e.g., `<a>`).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', asChild = false, className, type, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(
        // base
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-medium',
        'whitespace-nowrap select-none',
        'transition-[background-color,box-shadow,transform,color]',
        'duration-[var(--duration-fast)] ease-[var(--ease-out-spring)]',
        // focus
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'focus-visible:ring-offset-background focus-visible:ring-offset-2',
        // disabled
        'disabled:pointer-events-none disabled:opacity-50',
        // svg children
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    />
  );
});
