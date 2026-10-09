/**
 * The values of a power flow that the diagram does not draw.
 *
 * A value is drawn only where it has a place that is clear of everything
 * else (`picture.ts`): on a crowded diagram some have none, and are left off
 * so that nothing is drawn over anything else. `valuesLeftOff` says which,
 * so the diagram can say so itself (`SldValuesLeftOff`): the count stands
 * over the diagram, and its list has each value that is missing with what it
 * reads and where it belongs.
 *
 * Three kinds of value can go without a place:
 *
 * - the flow of a line, whose label has no clear place on its route or
 *   beside it (`LabelPlace.hidden`);
 * - the P and Q of a generator or a load, whose readout has no clear place
 *   beside its connector or its symbol (`ReadoutPlace.spot` is `none`);
 * - the voltage and the angle of a bus, whose label has room next to its
 *   bar for the name alone (`BusLabel.compact`).
 *
 * A value the user hid (Labels / Hide), one a case has no result for, and
 * the readouts a crowded case leaves off until it is zoomed in
 * (`labelDensity.ts`) are not missing in this sense, and are not listed.
 * The figure of the diagram counts by the same three rules
 * (`DrawnFigure.leftOff`).
 *
 * Pure: no React, nothing read but the arguments.
 */
import type { PflowResult } from '@/api/types';
import { voltageDisplay, type UnitMode } from '@/lib/units';
import type { ConnectionEdge } from './connections';
import type { LabelNode } from './labels';
import { getBusOverlayState, getDeviceOverlayState, getLineOverlayState } from './overlay';
import type { Picture } from './picture';
import { pflowKeyOf } from './valueWidths';
import type { VoltageLimits } from './voltage';

/** What kind of value is left off: the flow of a line, the P and Q of a device, or the voltage and angle of a bus. */
export type LeftOffKind = 'flow' | 'readout' | 'bus';

/** One element of the diagram whose values are not drawn. */
export interface LeftOffValue {
  /** The id of its edge (a line) or of its node (a device, a bus) on the diagram. */
  id: string;
  kind: LeftOffKind;
  /** What it is called: `line Line_3`, `load PQ_4`, `generator 2`, `bus BUS14`. */
  name: string;
  /** What is not drawn, as the diagram would have written it: `→ 25.97 MW`, `21.7 MW`, `1.036 pu`. */
  values: string[];
}

/** The part of a picture that says which values have no place. */
export type PlacesOfValues = Pick<
  Picture<ConnectionEdge>,
  'busLabels' | 'readouts' | 'labelPlaces'
>;

interface NamedData {
  idx?: string | number;
  name?: string;
  baseKv?: number | null;
  voltageLimits?: VoltageLimits;
}

const calledOf = (data: NamedData | undefined, id: string): string =>
  String(data?.name || data?.idx || id);

/**
 * The values of `pflow` that `picture`, the diagram of `nodes` and `edges`
 * as it is drawn with the values showing, has no place for: the flows of
 * the lines first, then the devices, then the buses, each in the order of
 * the diagram. Empty before a power flow.
 */
export function valuesLeftOff(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
  picture: PlacesOfValues,
  pflow: PflowResult | null,
  unitMode: UnitMode = 'pu',
): LeftOffValue[] {
  if (pflow === null || !pflow.converged) return [];
  const flows: LeftOffValue[] = [];
  for (const edge of edges) {
    // A transformer carries its symbol where a line carries its flow, and
    // the connector of a device carries nothing.
    const data = edge.data as (NamedData & { bucket?: string }) | undefined;
    if (data?.bucket !== 'line' || data.idx === undefined) continue;
    if (picture.labelPlaces.get(edge.id)?.hidden !== true) continue;
    const overlay = getLineOverlayState(String(data.idx), pflow);
    if (!overlay.has_data || overlay.p_label === null) continue;
    const arrow =
      overlay.direction === 'forward' ? '→ ' : overlay.direction === 'reverse' ? '← ' : '';
    flows.push({
      id: edge.id,
      kind: 'flow',
      name: `line ${calledOf(data, edge.id)}`,
      values: [
        `${arrow}${overlay.p_label}`,
        ...(overlay.loading_label !== null ? [overlay.loading_label] : []),
      ],
    });
  }
  const readouts: LeftOffValue[] = [];
  const buses: LeftOffValue[] = [];
  for (const node of nodes) {
    const data = node.data as NamedData | undefined;
    if (node.type === 'generator' || node.type === 'load') {
      if (picture.readouts.get(node.id)?.spot !== 'none') continue;
      const overlay = getDeviceOverlayState(node.type, pflowKeyOf(node), pflow);
      const values = [overlay.p_label, overlay.q_label].filter((text) => text !== null);
      if (values.length === 0) continue;
      readouts.push({
        id: node.id,
        kind: 'readout',
        name: `${node.type} ${calledOf(data, node.id)}`,
        values,
      });
      continue;
    }
    if ((node.type ?? 'bus') !== 'bus' || picture.busLabels.get(node.id)?.compact !== true) {
      continue;
    }
    const overlay = getBusOverlayState(
      String(data?.idx ?? node.id),
      pflow,
      false,
      data?.voltageLimits,
      voltageDisplay(unitMode, data?.baseKv),
    );
    const values = [overlay.voltage_label, overlay.angle_label].filter((text) => text !== null);
    if (values.length === 0) continue;
    buses.push({ id: node.id, kind: 'bus', name: `bus ${calledOf(data, node.id)}`, values });
  }
  return [...flows, ...readouts, ...buses];
}

/** `count` values, in words: `1 value`, `12 values`. */
export function valuesCount(count: number): string {
  return `${count} ${count === 1 ? 'value' : 'values'}`;
}
