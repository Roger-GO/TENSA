/**
 * How wide the values a power flow puts on the diagram are: the P / Q
 * readout of each generator and load, and the flow label of each line, with
 * the values they show. A picture gives each the room it takes, not the room
 * of the longest value there could be (`PictureOptions.labelWidths`).
 *
 * One function for the canvas and for the figure made of it, so that both
 * keep the same room for the same value.
 */
import type { PflowResult } from '@/api/types';
import type { ConnectionEdge } from './connections';
import { flowLabelWidth, readoutWidth, type LabelNode } from './labels';
import { getDeviceOverlayState, getLineOverlayState } from './overlay';

/** The row of the power flow result a generator or load node prints; `null` for one that prints none. */
export function pflowKeyOf(node: LabelNode): string | null {
  const data = (node.data ?? {}) as { idx?: string; pflowIdx?: string | null };
  return data.pflowIdx === undefined ? (data.idx ?? null) : data.pflowIdx;
}

/** The widths of the readouts and of the flow labels of a diagram: what `PictureOptions.labelWidths` takes. */
export interface ValueLabelWidths {
  /** By the id of the node of each generator and load. */
  readouts: Map<string, number>;
  /** By the id of the edge of each line. */
  flows: Map<string, number>;
}

/** The widths of the readouts and the flow labels of a diagram, by node id and by edge id. */
export function valueLabelWidths(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  pflowResult: PflowResult | null,
): ValueLabelWidths {
  const readouts = new Map<string, number>();
  for (const n of nodes) {
    if (n.type !== 'generator' && n.type !== 'load') continue;
    const { p_label, q_label } = getDeviceOverlayState(n.type, pflowKeyOf(n), pflowResult);
    readouts.set(n.id, readoutWidth(p_label, q_label));
  }
  const flows = new Map<string, number>();
  for (const e of edges) {
    const data = e.data as { idx?: string; bucket?: string } | undefined;
    if (data?.bucket !== 'line' || data.idx === undefined) continue;
    const { p_label, loading_label } = getLineOverlayState(data.idx, pflowResult);
    flows.set(e.id, flowLabelWidth(p_label, loading_label));
  }
  return { readouts, flows };
}
