/**
 * Input — canonical controlled-input primitive (Unit 5 of v2.0 polish).
 *
 * Wraps a native `<input>` with two specific behaviours that every
 * controlled text/number/search input in the app should share:
 *
 * 1. Always-controlled API. The component takes `value: string` and
 *    `onChange: (next: string) => void` (NOT the raw event). Callers
 *    can't accidentally mix in `defaultValue`, can't forget to wire
 *    `value`, and don't get the option to read `e.target.value` from a
 *    SyntheticEvent that may have been pooled. This is the "textbook
 *    controlled component" shape from the React docs, just with the
 *    string surfaced directly.
 *
 * 2. IME composition guard. Asian input methods (CJK) emit a stream of
 *    `compositionstart` → intermediate `input` events → `compositionend`
 *    while the user composes a character. Calling onChange on each
 *    intermediate event causes React state to thrash and, in some
 *    bindings, breaks composition entirely (the input value reverts on
 *    re-render). We track an internal `isComposing` flag and DEFER the
 *    parent's onChange until composition ends, at which point we fire
 *    once with the final value.
 *
 *    This matters even on Latin-only deployments: the same code path is
 *    triggered by the macOS dead-key flow (e.g., `option-e` then `e`
 *    → `é`) and by browser autofill on some platforms.
 *
 * The Playwright-test note (also captured in `web/AGENTS.md`):
 * `locator.fill()` calls `el.value = 'x'` directly, which DOESN'T
 * trigger React's synthetic input event in jsdom-style harnesses and
 * can lose the first character in some browsers. Tests should prefer
 * `locator.pressSequentially()` for typing, or use the React-friendly
 * setter hack:
 *
 *     const desc = Object.getOwnPropertyDescriptor(
 *       window.HTMLInputElement.prototype, 'value');
 *     desc!.set!.call(el, 'x');
 *     el.dispatchEvent(new Event('input', { bubbles: true }));
 *
 * The Input component itself doesn't need to "fix" this — the
 * React-friendly setter pattern works because the bubbling 'input'
 * event triggers the React onChange handler. We just need to make sure
 * the IME guard doesn't swallow it (it doesn't: a programmatic input
 * event has no associated `compositionstart`, so `isComposing` is
 * false and the change propagates through immediately).
 */
import { forwardRef, useRef } from 'react';
import type { CompositionEvent, InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Props mirror the native `<input>`'s HTML attributes EXCEPT we strip
 * `value`, `defaultValue`, and `onChange` and replace them with our
 * controlled-component contract:
 *
 * - `value: string` is required (no defaultValue escape hatch).
 * - `onChange(next: string)` receives the new string directly.
 *
 * We keep `onCompositionStart` / `onCompositionEnd` exposed so a caller
 * who wants to react to composition (rare; usually for analytics) can,
 * but the IME guard always runs regardless of those props.
 */
export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange'
> {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Default styling. Matches the existing project pattern (border + focus
 * ring + small font). Callers may override via `className`; we use a
 * simple string concat (`cn`) so trailing classes can win.
 */
const DEFAULT_CLASSES = cn(
  'border-border bg-background text-foreground',
  'h-9 rounded-[var(--radius-sm)] border px-2 py-1.5 text-sm',
  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { value, onChange, className, onCompositionStart, onCompositionEnd, ...rest },
  ref,
) {
  // Track whether an IME composition is in flight. Using a ref
  // (not state) because we only need the flag inside event handlers;
  // re-rendering on every composition transition would defeat the
  // whole purpose.
  const isComposingRef = useRef(false);

  const handleCompositionStart = (event: CompositionEvent<HTMLInputElement>) => {
    isComposingRef.current = true;
    onCompositionStart?.(event);
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLInputElement>) => {
    isComposingRef.current = false;
    onCompositionEnd?.(event);
    // Fire onChange once with the final value. compositionend in React
    // fires AFTER the final 'input' event, so el.value is already the
    // composed string at this point. (See: w3.org's IME spec, "compose
    // a character" sequence.)
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      onChange(target.value);
    }
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => {
        // Skip while composing — we'll fire on compositionend instead.
        if (isComposingRef.current) return;
        onChange(e.target.value);
      }}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      className={cn(DEFAULT_CLASSES, className)}
      {...rest}
    />
  );
});
