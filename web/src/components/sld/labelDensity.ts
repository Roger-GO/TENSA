/**
 * Zoom-dependent label density for the SLD.
 *
 * The canvas zooms between 0.5x and 2x and the device value labels are
 * 9 px text, so at the zoomed-out end they render under 6 px: unreadable,
 * and enough of them to bury the diagram. Below `DEVICE_LABEL_MIN_ZOOM`
 * the generator / load P and Q labels are left off, and they come back
 * as soon as the user zooms in. The names, the bus labels and the line
 * flows are not gated here.
 */
import { useStore } from '@xyflow/react';

/** Zoom factor at and above which generator / load P and Q labels show. */
export const DEVICE_LABEL_MIN_ZOOM = 0.65;

/** Pure form of the rule, exported for testing. */
export function deviceLabelsVisibleAtZoom(zoom: number): boolean {
  return zoom >= DEVICE_LABEL_MIN_ZOOM;
}

/**
 * True while the canvas is zoomed in far enough for the device value
 * labels. The selector returns a boolean, so a node re-renders only when
 * the zoom crosses the threshold, not on every pan or zoom frame.
 */
export function useDeviceLabelsVisible(): boolean {
  return useStore((s) => deviceLabelsVisibleAtZoom(s.transform[2]));
}
