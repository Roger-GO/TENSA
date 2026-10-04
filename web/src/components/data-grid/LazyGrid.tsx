import { Suspense } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { LoadingPanel } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';

export type GridTab = 'buses' | 'lines' | 'generators' | 'loads' | 'shunts' | 'violations';

/**
 * The element tables and the Violations table share ``DataGrid`` and
 * ``react-window`` and draw nothing until the drawer's Buses, Lines, Generators,
 * Loads, Shunts or Violations tab is on screen, so they load when the first of
 * those is shown. They stay out of the
 * entry chunk, which would otherwise carry them for a first screen (the case
 * list, no case loaded) that has no table in it. The tabs share one chunk for
 * their common code, so the second table costs only its own file.
 */
const GRIDS: Record<GridTab, LazyExoticComponent<ComponentType>> = {
  buses: lazyNamed(() => import('./BusesGrid'), 'BusesGrid'),
  lines: lazyNamed(() => import('./LinesGrid'), 'LinesGrid'),
  generators: lazyNamed(() => import('./GeneratorsGrid'), 'GeneratorsGrid'),
  loads: lazyNamed(() => import('./LoadsGrid'), 'LoadsGrid'),
  shunts: lazyNamed(() => import('./ShuntsGrid'), 'ShuntsGrid'),
  violations: lazyNamed(() => import('./ViolationsGrid'), 'ViolationsGrid'),
};

export function LazyGrid({ tab }: { tab: GridTab }) {
  const Grid = GRIDS[tab];
  return (
    <Suspense fallback={<LoadingPanel />}>
      <Grid />
    </Suspense>
  );
}
