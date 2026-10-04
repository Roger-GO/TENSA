/**
 * What a right-click, or a press by touch or pen, on the diagram is read as: from
 * the React Flow node or edge it landed on, or from the DOM around where it landed.
 */
import { describe, expect, it } from 'vitest';

import {
  contextTargetAt,
  contextTargetFromEdge,
  contextTargetFromNode,
  sameContextTarget,
} from '@/components/sld/contextTarget';
import type { SldContextTarget } from '@/components/sld/contextTarget';

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

describe('contextTargetAt', () => {
  const nodes = [
    { id: '7', type: 'bus', data: { idx: '7', name: 'BUS7' } },
    { id: 'generator-2', type: 'generator', data: { idx: '2', name: 'G2' } },
  ];
  const edges = [
    { id: 'line-5', type: 'topology', data: { idx: '5', name: 'L5' } },
    { id: 'stub-g2', type: 'stub', data: { idx: '2' } },
  ];

  /** A canvas as React Flow draws it: a node wrapper and an edge wrapper, each with its id. */
  function canvas(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="react-flow__edges"><svg>
        <g class="react-flow__edge" data-id="line-5"><path id="line-path" /></g>
        <g class="react-flow__edge" data-id="stub-g2"><path id="stub-path" /></g>
        <g class="react-flow__edge" data-id="gone"><path id="gone-path" /></g>
      </svg></div>
      <div class="react-flow__node" data-id="7"><span id="bus-label">BUS7</span>
        <div class="react-flow__handle" data-id="rf-7-a-source"></div></div>
      <div class="react-flow__node" data-id="generator-2"><span id="gen-body">G2</span></div>
      <div class="react-flow__node" data-id="no-such-node"><span id="gone-node">?</span></div>
      <div id="background"></div>`;
    return root;
  }

  const at = (root: HTMLElement, selector: string): SldContextTarget =>
    contextTargetAt(root.querySelector(selector) as Element, nodes, edges);

  it('reads a press inside a node wrapper as that node, a handle of it included', () => {
    const root = canvas();
    expect(at(root, '#bus-label')).toEqual({ kind: 'bus', idx: '7', name: 'BUS7', nodeId: '7' });
    expect(at(root, '.react-flow__handle')).toEqual({
      kind: 'bus',
      idx: '7',
      name: 'BUS7',
      nodeId: '7',
    });
    expect(at(root, '#gen-body')).toEqual({
      kind: 'device',
      element: { kind: 'generator', idx: '2' },
      name: 'G2',
      nodeId: 'generator-2',
    });
  });

  it('reads a press on an edge as that edge, and on a stub as the canvas', () => {
    const root = canvas();
    expect(at(root, '#line-path')).toEqual({
      kind: 'branch',
      idx: '5',
      name: 'L5',
      transformer: false,
    });
    expect(at(root, '#stub-path')).toEqual({ kind: 'canvas' });
  });

  it('reads a press on nothing, or on a wrapper of a node or edge the canvas no longer draws, as the canvas', () => {
    const root = canvas();
    expect(at(root, '#background')).toEqual({ kind: 'canvas' });
    expect(at(root, '#gone-node')).toEqual({ kind: 'canvas' });
    expect(at(root, '#gone-path')).toEqual({ kind: 'canvas' });
  });
});

describe('sameContextTarget', () => {
  it('is true for equal targets, labels included, and false otherwise', () => {
    const bus: SldContextTarget = { kind: 'bus', idx: '7', name: 'BUS7', nodeId: '7' };
    expect(sameContextTarget(bus, { ...bus })).toBe(true);
    expect(sameContextTarget({ kind: 'canvas' }, { kind: 'canvas' })).toBe(true);
    expect(sameContextTarget(bus, { ...bus, name: 'Renamed' })).toBe(false);
    expect(sameContextTarget(bus, { kind: 'canvas' })).toBe(false);
  });
});
