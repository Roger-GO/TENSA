/**
 * The ports of a generator, load and shunt node: one at the middle of each
 * face, so the connector to the bus can leave by whichever points at it.
 *
 * React Flow's `Handle` needs a provider, so it is stubbed with an element
 * that shows what it was given.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Handle: ({ id, type, position }: { id: string; type: string; position: string }) =>
      React.createElement('span', {
        'data-testid': 'handle',
        'data-handle-id': id,
        'data-handle-type': type,
        'data-handle-position': position,
      }),
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
  };
});

import { GeneratorNode } from '@/components/sld/nodes/GeneratorNode';
import { LoadNode } from '@/components/sld/nodes/LoadNode';
import { ShuntNode } from '@/components/sld/nodes/ShuntNode';
import { DEVICE_PORT } from '@/components/sld/graph';

function props(idx: string, kind: string): Parameters<typeof GeneratorNode>[0] {
  return {
    id: `n-${idx}`,
    data: { idx, name: idx, kind },
    selected: false,
    type: 'generator',
    isConnectable: true,
    dragging: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as Parameters<typeof GeneratorNode>[0];
}

afterEach(cleanup);

describe('device ports', () => {
  it.each([
    ['generator', GeneratorNode, 'PV'],
    ['load', LoadNode, 'PQ'],
    ['shunt', ShuntNode, 'Shunt'],
  ] as const)('gives a %s a source port at the middle of each face', (_name, Node, kind) => {
    const { getAllByTestId } = render(<Node {...props('1', kind)} />);
    const ports = getAllByTestId('handle').map((el) => ({
      id: el.getAttribute('data-handle-id'),
      type: el.getAttribute('data-handle-type'),
      position: el.getAttribute('data-handle-position'),
    }));
    expect(ports).toEqual([
      { id: DEVICE_PORT.north, type: 'source', position: 'top' },
      { id: DEVICE_PORT.east, type: 'source', position: 'right' },
      { id: DEVICE_PORT.south, type: 'source', position: 'bottom' },
      { id: DEVICE_PORT.west, type: 'source', position: 'left' },
    ]);
  });

  it('names the four ports apart', () => {
    expect(new Set(Object.values(DEVICE_PORT)).size).toBe(4);
  });
});
