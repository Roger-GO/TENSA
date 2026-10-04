/**
 * Zoom-dependent label density for the SLD.
 *
 * The canvas zooms between 0.5x and 2x and the device value labels are
 * 9 px text, so at the zoomed-out end they render under 6 px. A small
 * or medium case still shows them there, like its bus labels and device
 * names (also 9 px), so the values are on screen as soon as a power flow
 * has run. A case with more than `DEVICE_LABEL_DENSE_COUNT` of them would
 * be buried, so below `DEVICE_LABEL_MIN_ZOOM` its generator / load P and
 * Q labels are left off, and they come back as soon as the user zooms in.
 * The names, the bus labels and the line flows are not gated here.
 */
import { useStore } from '@xyflow/react';
import type { PflowResult } from '@/api/types';

/** Zoom factor at and above which a dense case shows its P and Q labels. */
export const DEVICE_LABEL_MIN_ZOOM = 0.65;

/** Most device readouts a case can hold and still show them at every zoom. */
export const DEVICE_LABEL_DENSE_COUNT = 40;

/** Number of device readouts a PF result can put on the diagram. */
export function deviceValueCount(pflowResult: PflowResult | null): number {
  if (!pflowResult || !pflowResult.converged) return 0;
  return (
    Object.keys(pflowResult.generator_outputs ?? {}).length +
    Object.keys(pflowResult.load_consumption ?? {}).length
  );
}

/** Pure form of the rule, exported for testing. */
export function deviceLabelsVisibleAtZoom(zoom: number, deviceCount: number): boolean {
  return deviceCount <= DEVICE_LABEL_DENSE_COUNT || zoom >= DEVICE_LABEL_MIN_ZOOM;
}

/**
 * True while the canvas shows the device value labels. The selector
 * returns a boolean, so a node re-renders only when the zoom crosses the
 * threshold of a dense case, not on every pan or zoom frame.
 */
export function useDeviceLabelsVisible(deviceCount: number): boolean {
  return useStore((s) => deviceLabelsVisibleAtZoom(s.transform[2], deviceCount));
}
