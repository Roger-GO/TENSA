/**
 * useSafeTimeout — a ``setTimeout`` that cannot outlive its component.
 *
 * The dialogs that close themselves a beat after a success (so the user
 * sees the confirmation first) used a bare ``setTimeout``. Dismissing the
 * dialog by hand inside that beat and opening it again let the old timer
 * close the new dialog, and a timer that fired after unmount touched state
 * nobody owned any more.
 *
 * ``schedule(callback, delayMs)`` starts a timer. Every pending timer is
 * cleared when the component unmounts, and a call made after unmount (a
 * request that resolved after the dialog was dismissed) starts nothing.
 */
import { useCallback, useEffect, useRef } from 'react';

export function useSafeTimeout(): (callback: () => void, delayMs: number) => void {
  const pending = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const mounted = useRef(true);

  useEffect(() => {
    // Strict Mode runs the effect twice (mount, cleanup, mount), so the flag
    // is set again here rather than only as the ref's initial value.
    mounted.current = true;
    const timers = pending.current;
    return () => {
      mounted.current = false;
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return useCallback((callback, delayMs) => {
    if (!mounted.current) return;
    const timer = setTimeout(() => {
      pending.current.delete(timer);
      callback();
    }, delayMs);
    pending.current.add(timer);
  }, []);
}
