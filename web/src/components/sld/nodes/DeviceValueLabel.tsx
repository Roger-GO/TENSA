import { memo } from 'react';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { deviceValueCount, useDeviceLabelsVisible } from '../labelDensity';
import { getDeviceOverlayState } from '../overlay';
import type { SldNodeData } from './BusNode';

export interface DeviceValueLabelProps {
  kind: 'generator' | 'load';
  data: SldNodeData;
}

/**
 * Post-PF P / Q readout of a generator or load node (MW over MVAr).
 *
 * Positioned absolutely on the side of the node that faces its bus
 * (`data.valueSide`), in the strip the stub crosses, so it adds nothing to
 * the node's measured box: the ports, the layout footprint and the
 * push-out math are the same with or without values. It is centred on the
 * node unless the connector leaves by that same face (`data.connectorFace`),
 * in which case it stands beside the connector: to its right, or to its
 * left when the connector itself goes off to the right
 * (`data.connectorLean`), so a connector drawn at an angle does not run
 * through the values. The far side of a device is where the neighbouring
 * buses, devices and controller badges crowd in; this strip is clear of
 * them in the default layout (`DEVICE_VALUE_LABEL`, `CONTROLLER_DOCK` in
 * `graph.ts`). The one device that gets its readout on the far side is one
 * that hangs close under its bus, where the strip holds the label of the
 * bus. Shown only after a converged PF that has a row for the device, never
 * under "Hide labels", and, on a case with many devices, only while the
 * canvas is zoomed in far enough to read it (`labelDensity.ts`).
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
  const deviceCount = usePflowStore((s) => deviceValueCount(s.lastRun));
  const zoomedIn = useDeviceLabelsVisible(deviceCount);
  const overlay = getDeviceOverlayState(
    kind,
    data.pflowIdx === undefined ? data.idx : data.pflowIdx,
    pflowResult,
    hideLabels,
  );
  if (!zoomedIn || (overlay.p_label === null && overlay.q_label === null)) return null;
  // Default: the generator sits above its bus, the load below it.
  const side = data.valueSide ?? (kind === 'generator' ? 'below' : 'above');
  // The connector leaves from the middle of a face. When that is the face
  // the readout hangs off, the readout stands just beside the connector and
  // not on it: on the right, unless that is the way the connector goes.
  const besideConnector = data.connectorFace === (side === 'below' ? 'south' : 'north');
  const leftOfConnector = besideConnector && data.connectorLean === 1;
  return (
    <span
      data-testid={`${kind}-values-${data.idx}`}
      data-beside-connector={besideConnector ? (leftOfConnector ? 'left' : 'true') : undefined}
      className={cn(
        'bg-background/80 pointer-events-none absolute rounded px-1',
        leftOfConnector
          ? 'right-1/2 mr-1 text-right'
          : besideConnector
            ? 'left-1/2 ml-1 text-left'
            : 'left-1/2 -translate-x-1/2 text-center',
        'font-mono text-[9px] leading-[10px] whitespace-nowrap',
        side === 'below' ? 'top-full mt-0.5' : 'bottom-full mb-0.5',
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
