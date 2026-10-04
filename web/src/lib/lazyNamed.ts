/**
 * lazyNamed: ``React.lazy`` for a module's named export.
 *
 * ``lazy`` wants a default export; every component here is a named one. The
 * call site passes the dynamic import and the export's name, and the props keep
 * their types:
 *
 *   const AnalysisTab = lazyNamed(() => import('@/components/data-grid/AnalysisTab'), 'AnalysisTab');
 *
 * Render the result inside a ``<Suspense>`` (or ``LazyMount``).
 *
 * A chunk can fail to load: the page was left open across an upgrade (the
 * hashed file is gone), or the server stopped. ``lazy`` would throw that into
 * the tree, and with no error boundary above it React unmounts the whole app.
 * The loader catches it instead, so one panel or dialog fails and the rest of
 * the app keeps working:
 *
 * - ``'panel'`` (default): the region shows ``LazyLoadFailed``, with a button
 *   that reloads the page.
 * - ``'overlay'`` (dialogs, drawers, palettes, which have no region of their
 *   own to put a message in): ``LazyLoadFailedQuietly`` renders nothing and
 *   toasts.
 *
 * A failed load is not retried for the lifetime of the page, because ``lazy``
 * keeps the first result. A reload is the way out, which is what both messages
 * offer. An overlay asked for again after a failure toasts again, so a second
 * attempt is not silent (see ``LazyMount``'s ``onLoadFailed``).
 */
import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { LazyLoadFailed, LazyLoadFailedQuietly } from '@/components/ui/Lazy';

type PropsOf<C> = C extends ComponentType<infer P> ? P : never;

export type LazyFailure = 'panel' | 'overlay';

export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
  failure: LazyFailure = 'panel',
): LazyExoticComponent<ComponentType<PropsOf<M[K]>>> {
  return lazy(async () => {
    try {
      const mod = await load();
      return { default: mod[name] as unknown as ComponentType<PropsOf<M[K]>> };
    } catch (err) {
      console.error(`[lazyNamed] could not load ${String(name)}`, err);
      return { default: failure === 'overlay' ? LazyLoadFailedQuietly : LazyLoadFailed };
    }
  });
}
