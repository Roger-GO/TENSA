/**
 * What a right-click on the single-line diagram landed on, worked out from the
 * React Flow node or edge. Pure, so the mapping is testable without a canvas;
 * `SldContextMenu` draws the menu for it.
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
