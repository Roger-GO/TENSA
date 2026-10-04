import { memo } from 'react';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { useDeviceLabelsVisible } from '../labelDensity';
import { getDeviceOverlayState } from '../overlay';
import type { SldNodeData } from './BusNode';

export interface DeviceValueLabelProps {
  kind: 'generator' | 'load';
  data: SldNodeData;
}

/**
 * Post-PF P / Q readout of a generator or load node (MW over MVAr).
 *
 * Positioned absolutely on the face of the node away from the bus
 * (`data.busSide`), so it adds nothing to the node's measured box: the
 * stub anchor, the layout footprint and the push-out math are the same
 * with or without values. Shown only after a converged PF that has a row
 * for the device, never under "Hide labels", and only while the canvas is
 * zoomed in far enough to read it (`labelDensity.ts`).
 *
 * The values are the steady-state PF reading, like the bus voltage
 * labels: they stay put while a TDS run streams.
 */
export const DeviceValueLabel = memo(function DeviceValueLabel({
  kind,
  data,
}: DeviceValueLabelProps) {
  const pflowResult = usePflowStore((s) => s.lastRun);
  const hideLabels = useUiStore((s) => s.hideLabels);
  const zoomedIn = useDeviceLabelsVisible();
  const overlay = getDeviceOverlayState(kind, data.pflowIdx ?? data.idx, pflowResult, hideLabels);
  if (!zoomedIn || (overlay.p_label === null && overlay.q_label === null)) return null;
  return (
    <span
      data-testid={`${kind}-values-${data.idx}`}
      className={cn(
        'bg-background/80 pointer-events-none absolute left-1/2 -translate-x-1/2 rounded px-1',
        'text-center font-mono text-[9px] leading-tight whitespace-nowrap',
        data.busSide === 'south' ? 'top-full mt-0.5' : 'bottom-full mb-0.5',
      )}
    >
      {overlay.p_label !== null ? (
        <span data-testid={`${kind}-p-${data.idx}`} className="text-foreground block">
          {overlay.p_label}
        </span>
      ) : null}
      {overlay.q_label !== null ? (
        <span data-testid={`${kind}-q-${data.idx}`} className="text-muted-foreground block">
          {overlay.q_label}
        </span>
      ) : null}
    </span>
  );
});
