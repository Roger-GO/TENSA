/**
 * useLatest: the value of the render that was last committed, for code that
 * runs outside render and is not to start again when the value changes (an
 * effect that calls the newest handler, a listener a library holds).
 *
 * The ref is written in a layout effect, not while rendering: React may render
 * a component more than once, or throw a render away, before it commits one.
 * A layout effect runs as the render is committed, before the passive effects
 * of the same commit and before the browser hands the page another event, so
 * an effect, a handler or a callback reads the value of the render on screen.
 * The render itself must not read it: there it is the value of the render
 * before.
 */
import { useLayoutEffect, useRef } from 'react';

export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
