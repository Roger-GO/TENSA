/**
 * The layout a save sends with the system.
 *
 * Every way of saving carries the placement of the diagram: Save and Save
 * system as write it beside the case file, a snapshot keeps it, and a bundle
 * holds it as `layout.json`. They all take it from here, so they all send the
 * same thing: the diagram as it is drawn now.
 *
 * Kept apart from the hooks that use it because both `@/api/queries` (the
 * snapshot mutation) and the save hooks built on `@/api/queries` need it.
 */
import type { SidecarLayout } from '@/api/types';
import { hasSavedPositions } from '@/components/sld/sidecarCore';
import { useCaseStore } from '@/store/case';

/**
 * The diagram as it is drawn now, every position and route (see
 * `captureLayout`), stamped with the time of the save. `null` when the diagram
 * of the open case has not been drawn, or shows nothing placed; the server
 * then falls back to the layout saved beside the case file.
 *
 * Read from the store when called, not subscribed to: the canvas rewrites it
 * on every rebuild of the diagram, and no caller should re-render for that.
 */
export function diagramLayoutForSave(): SidecarLayout | null {
  const layout = useCaseStore.getState().diagramLayout;
  if (!hasSavedPositions(layout)) return null;
  return { ...layout, last_modified: new Date().toISOString() };
}
