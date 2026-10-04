/**
 * Ask the browser to confirm before this tab is closed or reloaded while it holds
 * work that would be lost (``unsavedWork``).
 *
 * The browser shows its own generic prompt: pages cannot supply the text, and a
 * handler that does not cancel the event leaves the page free to go, so the guard
 * is silent for a tab with nothing to lose. Mounted once from ``App.tsx``.
 */
import { useEffect } from 'react';
import { hasUnsavedWork } from './unsavedWork';

export function useUnsavedWorkGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return;
      // Cancelling the event is what makes the browser prompt. Older browsers want
      // ``returnValue`` set as well; the text is ignored everywhere.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
