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
 * through the values, or when another connector would run through them on
 * the right and the left is free (`data.readoutSpot`: a line that lands on
 * the bar just right of the device). The far side of a device is where the
 * neighbouring buses and devices crowd in, and where the control chain of a
 * generating unit is drawn out; this strip is clear of them in the default
 * layout (`DEVICE_VALUE_LABEL` in `graph.ts`). The one device that gets its
 * readout on the far side is one that hangs close under its bus, where the
 * strip holds the label of the bus, or one with no place free on either side
 * of its connector (`data.readoutSpot`: a line lands on each side of it, or a
 * symbol stands there), which may also stand beside the symbol. Shown only
 * after a converged PF that has
 * a row for the device, never under "Hide labels", and, on a case with many
 * devices, only while the canvas is zoomed in far enough to read it
 * (`labelDensity.ts`).
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
  // Default: the generator sits above its bus, the load below it. With no
  // place free on the side of the bus, the readout hangs off the far side,
  // or stands beside the symbol.
  const facing = data.valueSide ?? (kind === 'generator' ? 'below' : 'above');
  const spot = data.readoutSpot;
  const side = spot === 'far' ? (facing === 'below' ? 'above' : 'below') : facing;
  const besideSymbol = spot === 'east' || spot === 'west';
  // The connector leaves from the middle of a face. When that is the face
  // the readout hangs off, the readout stands just beside the connector and
  // not on it: on the right, unless that is the way the connector goes or
  // the canvas found the left clearer of other connectors.
  const besideConnector =
    spot !== 'far' &&
    !besideSymbol &&
    data.connectorFace === (side === 'below' ? 'south' : 'north');
  const leftOfConnector = besideConnector && (data.connectorLean === 1 || spot === 'left');
  return (
    <span
      data-testid={`${kind}-values-${data.idx}`}
      data-beside-connector={besideConnector ? (leftOfConnector ? 'left' : 'true') : undefined}
      data-readout-spot={spot === 'far' || besideSymbol ? spot : undefined}
      className={cn(
        'bg-background/80 pointer-events-none absolute rounded px-1',
        'font-mono text-[9px] leading-[10px] whitespace-nowrap',
        besideSymbol
          ? cn(
              'top-1/2 -translate-y-1/2',
              spot === 'east' ? 'left-full ml-1 text-left' : 'right-full mr-1 text-right',
            )
          : cn(
              leftOfConnector
                ? 'right-1/2 mr-1 text-right'
                : besideConnector
                  ? 'left-1/2 ml-1 text-left'
                  : 'left-1/2 -translate-x-1/2 text-center',
              side === 'below' ? 'top-full mt-0.5' : 'bottom-full mb-0.5',
            ),
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
