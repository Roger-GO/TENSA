/**
 * What a right-click on the single-line diagram landed on, worked out from the
 * React Flow node or edge, or, for a press by touch or pen, from the DOM around
 * it. Pure, so the mapping is testable without a canvas; `SldContextMenu` draws
 * the menu for it.
 */
import type { Edge, Node } from '@xyflow/react';

import { subKindForControllerClass } from '@/lib/controllers';
import type { ControllerSubKind } from '@/lib/controllers';
import type { SelectedElement } from '@/store/case';

/** What a right-click landed on. */
export type SldContextTarget =
  | { kind: 'canvas' }
  | { kind: 'bus'; idx: string; name: string; nodeId: string }
  | { kind: 'branch'; idx: string; name: string; transformer: boolean }
  | { kind: 'device'; element: SelectedElement; name: string; nodeId: string };

/** The shape of a node's `data` that a menu needs. */
interface NodeData {
  idx?: string;
  name?: string;
  kind?: string;
  subKind?: ControllerSubKind;
}

/** The target for a right-click on a React Flow node. */
export function contextTargetFromNode(node: Pick<Node, 'id' | 'type' | 'data'>): SldContextTarget {
  const data = node.data as NodeData;
  const idx = data.idx ?? node.id;
  const name = data.name ?? idx;
  switch (node.type) {
    case 'bus':
      return { kind: 'bus', idx, name, nodeId: node.id };
    case 'generator':
    case 'load':
    case 'shunt':
      return { kind: 'device', element: { kind: node.type, idx }, name, nodeId: node.id };
    case 'controller': {
      const modelClass = data.kind ?? '';
      const subKind = data.subKind ?? subKindForControllerClass(modelClass);
      return {
        kind: 'device',
        element: { kind: 'controller', subKind, modelClass, idx },
        name,
        nodeId: node.id,
      };
    }
    default:
      return { kind: 'canvas' };
  }
}

/**
 * The target for a right-click on a React Flow edge. A stub (the short link from a
 * generator, load or shunt to its bus) is not an element of its own, so it gives
 * the canvas menu, as a click on it selects nothing.
 */
export function contextTargetFromEdge(edge: Pick<Edge, 'type' | 'data'>): SldContextTarget {
  const data = edge.data as { idx?: string; name?: string } | undefined;
  const idx = data?.idx;
  if (!idx || edge.type === 'stub') return { kind: 'canvas' };
  return {
    kind: 'branch',
    idx,
    name: data?.name ?? idx,
    transformer: edge.type === 'transformer',
  };
}

/**
 * The target for a press on the diagram, found from the DOM: the React Flow node
 * or edge wrapper that holds `element` (they carry the node's or edge's id as
 * `data-id`), looked up in the nodes and edges the canvas draws. A press on
 * neither is the canvas's. For touch and pen, which open the menu from a long
 * press that iOS reports with no `contextmenu` event, so React Flow's own
 * right-click handlers never say what was pressed.
 */
export function contextTargetAt(
  element: Element,
  nodes: ReadonlyArray<Pick<Node, 'id' | 'type' | 'data'>>,
  edges: ReadonlyArray<Pick<Edge, 'id' | 'type' | 'data'>>,
): SldContextTarget {
  const wrapper = element.closest('.react-flow__node, .react-flow__edge');
  const id = wrapper?.getAttribute('data-id');
  if (!wrapper || !id) return { kind: 'canvas' };
  if (wrapper.classList.contains('react-flow__edge')) {
    const edge = edges.find((e) => e.id === id);
    return edge ? contextTargetFromEdge(edge) : { kind: 'canvas' };
  }
  const node = nodes.find((n) => n.id === id);
  return node ? contextTargetFromNode(node) : { kind: 'canvas' };
}

/** Whether two targets are the same, down to the labels (they are plain data). */
export function sameContextTarget(a: SldContextTarget, b: SldContextTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
