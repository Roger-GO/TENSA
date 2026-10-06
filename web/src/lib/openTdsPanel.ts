/**
 * Bring the settings of a time-domain run into view: the bottom drawer's
 * Analysis tab on its TDS sub-tab (the end time, the step, the integrator,
 * what the run records, its frequency controllers), with the drawer open.
 * The Disturbances list of the sidebar and the empty plot point here: they
 * are where a first run is set up and where its results are looked for, and
 * neither said where the end time of the run is.
 */
import { useLayoutStore } from '@/store/layout';

export function openTdsPanel(): void {
  const layout = useLayoutStore.getState();
  layout.setActiveBottomDrawerTab('analysis');
  layout.setActiveAnalysisSubTab('tds');
  layout.setBottomDrawerCollapsed(false);
  layout.clearDrawerUnread();
}
