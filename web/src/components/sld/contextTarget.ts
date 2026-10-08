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
  /** Several buses and devices picked together: `count` of them. */
  | { kind: 'selection'; count: number }
  | { kind: 'bus'; idx: string; name: string; nodeId: string }
  | {
      kind: 'branch';
      idx: string;
      name: string;
      transformer: boolean;
      /** The id of its edge, which is what a route is kept under; absent where it is not known. */
      edgeId?: string;
      /** Whether its route was drawn by hand. */
      manual?: boolean;
    }
  /**
   * A draft: its symbol, its connector, or the line it is drawn as once it
   * names both its buses. `nodeId` is the node of its symbol, when it has one.
   */
  | { kind: 'draft'; id: string; name: string; nodeId: string | null }
  /**
   * The connector of a generator, load or shunt to its bus: `name` is the
   * device's, and `nodeId` the node it is drawn as, where that is known.
   */
  | { kind: 'connector'; edgeId: string; name: string; manual: boolean; nodeId?: string }
  | {
      kind: 'device';
      element: SelectedElement;
      name: string;
      nodeId: string;
      /**
       * Set for a generator that stands for a unit of several models: the idx
       * the unit goes by, and whether its control chain is drawn out now.
       */
      unit?: { idx: string; expanded: boolean };
    };

/** The shape of a node's `data` that a menu needs. */
interface NodeData {
  idx?: string;
  name?: string;
  kind?: string;
  subKind?: ControllerSubKind;
  unit?: { expanded?: boolean };
}

/**
 * The draft a node or an edge is drawn for (`draftGraph` marks both), as a
 * target: whatever of a draft is right-clicked, the menu is the draft's.
 */
function draftTarget(data: unknown, nodeId: string | null): SldContextTarget | null {
  const marked = data as { draft?: unknown; draftId?: unknown; idx?: unknown; name?: unknown };
  if (marked?.draft !== true) return null;
  const id = marked.draftId ?? marked.idx;
  if (typeof id !== 'string') return null;
  return { kind: 'draft', id, name: typeof marked.name === 'string' ? marked.name : id, nodeId };
}

/** The target for a right-click on a React Flow node. */
export function contextTargetFromNode(node: Pick<Node, 'id' | 'type' | 'data'>): SldContextTarget {
  const draft = draftTarget(node.data, node.id);
  if (draft !== null) return draft;
  const data = node.data as NodeData;
  const idx = data.idx ?? node.id;
  const name = data.name ?? idx;
  switch (node.type) {
    case 'bus':
      return { kind: 'bus', idx, name, nodeId: node.id };
    case 'generator':
      // The symbol stands for a whole unit, whose static generator and
      // machine can have the same idx, so the element names its model.
      return {
        kind: 'device',
        element:
          data.kind === undefined
            ? { kind: 'generator', idx }
            : { kind: 'generator', idx, modelClass: data.kind },
        name,
        nodeId: node.id,
        ...(data.unit === undefined
          ? {}
          : { unit: { idx, expanded: data.unit.expanded === true } }),
      };
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
 * generator, load or shunt to its bus) is not an element of its own: its menu is
 * about how it is drawn, which can be changed by hand like the route of a line.
 */
export function contextTargetFromEdge(
  edge: Pick<Edge, 'type' | 'data'> & { id?: string; source?: string },
): SldContextTarget {
  // The connector of a draft, or the line a draft is drawn as, is the draft's:
  // its route is worked out until the draft is added to the system.
  const draft = draftTarget(edge.data, edge.type === 'stub' ? (edge.source ?? null) : null);
  if (draft !== null) return draft;
  const data = edge.data as { idx?: string; name?: string; bendManual?: boolean } | undefined;
  const manual = data?.bendManual === true;
  if (edge.type === 'stub') {
    return edge.id === undefined
      ? { kind: 'canvas' }
      : {
          kind: 'connector',
          edgeId: edge.id,
          name: data?.name ?? 'the device',
          manual,
          ...(edge.source === undefined ? {} : { nodeId: edge.source }),
        };
  }
  const idx = data?.idx;
  if (!idx) return { kind: 'canvas' };
  return {
    kind: 'branch',
    idx,
    name: data?.name ?? idx,
    transformer: edge.type === 'transformer',
    ...(edge.id === undefined ? {} : { edgeId: edge.id, manual }),
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
  edges: ReadonlyArray<Pick<Edge, 'id' | 'type' | 'data'> & { source?: string }>,
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
