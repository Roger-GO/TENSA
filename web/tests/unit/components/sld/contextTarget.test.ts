/**
 * What a right-click on the diagram is read as, from the React Flow node or edge
 * it landed on.
 */
import { describe, expect, it } from 'vitest';

import { contextTargetFromEdge, contextTargetFromNode } from '@/components/sld/contextTarget';

describe('contextTargetFromNode', () => {
  it('reads a bus node as a bus, with its name and node id', () => {
    expect(
      contextTargetFromNode({
        id: '7',
        type: 'bus',
        data: { idx: '7', name: 'BUS7', kind: 'Bus' },
      }),
    ).toEqual({ kind: 'bus', idx: '7', name: 'BUS7', nodeId: '7' });
  });

  it('falls back to the node id when the data has no idx or name', () => {
    expect(contextTargetFromNode({ id: '3', type: 'bus', data: {} })).toEqual({
      kind: 'bus',
      idx: '3',
      name: '3',
      nodeId: '3',
    });
  });

  it.each(['generator', 'load', 'shunt'] as const)(
    'reads a %s node as a device to inspect',
    (kind) => {
      expect(
        contextTargetFromNode({
          id: `${kind}-2`,
          type: kind,
          data: { idx: '2', name: 'X', kind: 'PV' },
        }),
      ).toEqual({ kind: 'device', element: { kind, idx: '2' }, name: 'X', nodeId: `${kind}-2` });
    },
  );

  it('reads a controller node with its sub-kind and model class', () => {
    const target = contextTargetFromNode({
      id: 'controller-IEEEG1-1',
      type: 'controller',
      data: { idx: '1', name: 'GOV1', kind: 'IEEEG1', subKind: 'governor' },
    });
    expect(target).toEqual({
      kind: 'device',
      element: { kind: 'controller', subKind: 'governor', modelClass: 'IEEEG1', idx: '1' },
      name: 'GOV1',
      nodeId: 'controller-IEEEG1-1',
    });
  });

  it('derives the controller sub-kind from the model class when the node has none', () => {
    const target = contextTargetFromNode({
      id: 'controller-IEEEX1-4',
      type: 'controller',
      data: { idx: '4', kind: 'IEEEX1' },
    });
    expect(target.kind).toBe('device');
    if (target.kind === 'device' && target.element.kind === 'controller') {
      expect(target.element.subKind).toBe('exciter');
    }
  });

  it('gives the canvas menu for a node of a type it does not know', () => {
    expect(contextTargetFromNode({ id: 'x', type: 'mystery', data: {} })).toEqual({
      kind: 'canvas',
    });
    expect(contextTargetFromNode({ id: 'x', data: {} })).toEqual({ kind: 'canvas' });
  });
});

describe('contextTargetFromEdge', () => {
  it('reads a line edge, routed or not, as a line', () => {
    for (const type of ['topology', 'routed']) {
      expect(contextTargetFromEdge({ type, data: { idx: '5', name: 'L5' } })).toEqual({
        kind: 'branch',
        idx: '5',
        name: 'L5',
        transformer: false,
      });
    }
  });

  it('reads a transformer edge as a transformer', () => {
    expect(contextTargetFromEdge({ type: 'transformer', data: { idx: '9' } })).toEqual({
      kind: 'branch',
      idx: '9',
      name: '9',
      transformer: true,
    });
  });

  it('gives the canvas menu for a stub, which is no element of its own, or an edge without an idx', () => {
    expect(contextTargetFromEdge({ type: 'stub', data: { idx: '1' } })).toEqual({ kind: 'canvas' });
    expect(contextTargetFromEdge({ type: 'topology', data: {} })).toEqual({ kind: 'canvas' });
    expect(contextTargetFromEdge({ type: 'topology' })).toEqual({ kind: 'canvas' });
  });
});
