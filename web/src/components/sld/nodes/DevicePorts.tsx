import { Handle, Position } from '@xyflow/react';
import { DEVICE_PORT, type Side } from '../graph';

const PORTS: Array<{ side: Side; position: Position }> = [
  { side: 'north', position: Position.Top },
  { side: 'east', position: Position.Right },
  { side: 'south', position: Position.Bottom },
  { side: 'west', position: Position.Left },
];

/**
 * The ports of a generator, load or shunt node: one at the middle of each
 * face (`DEVICE_PORT`). The connector to the bus leaves from the one on the
 * face that points at the bus, wherever the device was put, so a device
 * moved to the side of its bus, or across it, is still connected from the
 * near face. The ports draw nothing.
 */
export function DevicePorts() {
  return (
    <>
      {PORTS.map(({ side, position }) => (
        <Handle
          key={side}
          type="source"
          position={position}
          id={DEVICE_PORT[side]}
          className="!h-0 !min-h-0 !w-0 !min-w-0 !border-0 !bg-transparent"
        />
      ))}
    </>
  );
}
