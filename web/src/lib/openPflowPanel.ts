/**
 * Bring the power-flow tab (the options and the system summary) into view:
 * the bottom drawer's Analysis tab on its PF sub-tab, with the drawer open.
 * The non-convergence banner's "Adjust options" and the Run menu's PF entry
 * point here, so there is one answer to "where are the power-flow options".
 */
import { useLayoutStore } from '@/store/layout';

export function openPflowPanel(): void {
  const layout = useLayoutStore.getState();
  layout.setActiveBottomDrawerTab('analysis');
  layout.setActiveAnalysisSubTab('pf');
  layout.setBottomDrawerCollapsed(false);
  layout.clearDrawerUnread();
}
