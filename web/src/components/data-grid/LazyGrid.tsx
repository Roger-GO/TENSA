import { Suspense } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { LoadingPanel } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';

export type GridTab =
  | 'buses'
  | 'lines'
  | 'generators'
  | 'loads'
  | 'shunts'
  | 'machines'
  | 'exciters'
  | 'governors'
  | 'violations';

/**
 * The element tables, the tables of the dynamic models and the Violations table
 * share ``DataGrid`` and ``react-window`` and draw nothing until the drawer's
 * Buses, Lines, Generators, Loads, Shunts, Machines, Exciters, Governors or
 * Violations tab is on screen, so they load when the first of those is shown. They stay out of the
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
  machines: lazyNamed(() => import('./ModelParamsGrid'), 'MachinesGrid'),
  exciters: lazyNamed(() => import('./ModelParamsGrid'), 'ExcitersGrid'),
  governors: lazyNamed(() => import('./ModelParamsGrid'), 'GovernorsGrid'),
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
