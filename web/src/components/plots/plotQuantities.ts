import { parseColumnName } from '@/store/plot';
import type { ParsedSeries, VarGroup } from '@/store/plot';

/**
 * The quantities the plot's toggle buttons flip (see ``PlotQuantityToggles``):
 * which series make up a quantity, whether it is on the plot, and the selection
 * after it is flipped. Pure, so the choices are testable without a chart.
 *
 * A quantity turned on takes the elements that its partner (the voltage of a
 * bus for its angle, the speed of a machine for its rotor angle) is already
 * drawn for, so the two end up on the same buses and machines; with no partner
 * drawn it takes the first ``MAX_ELEMENTS`` elements, the number the picker
 * selects by default. Turned off, it takes all its series off the plot.
 */

/** Elements a quantity takes when it has no partner to follow (the picker's default cap). */
export const MAX_ELEMENTS = 12;

export interface Quantity {
  group: VarGroup;
  field: string;
  /** The other quantity of the pair, drawn on the other axis. */
  partner: string;
  label: string;
  /** What an element of this group is called, for the button's hint. */
  noun: string;
}

export const QUANTITIES: readonly Quantity[] = [
  { group: 'bus_v', field: 'v', partner: 'a', label: 'Bus voltage', noun: 'buses' },
  { group: 'bus_v', field: 'a', partner: 'v', label: 'Bus angle', noun: 'buses' },
  {
    group: 'gen_state',
    field: 'omega',
    partner: 'delta',
    label: 'Generator speed',
    noun: 'generators',
  },
  {
    group: 'gen_state',
    field: 'delta',
    partner: 'omega',
    label: 'Generator angle',
    noun: 'generators',
  },
];

/** The series of ``columnNames`` that measure ``group``'s ``field``, in column order. */
export function seriesOf(
  columnNames: readonly string[],
  group: VarGroup,
  field: string,
): readonly ParsedSeries[] {
  const out: ParsedSeries[] = [];
  for (const name of columnNames) {
    const parsed = parseColumnName(name);
    if (parsed && parsed.group === group && parsed.field === field) out.push(parsed);
  }
  return out;
}

/** Whether any series of the quantity is on the plot. */
export function isQuantityOn(
  columnNames: readonly string[],
  selected: ReadonlySet<string>,
  quantity: Pick<Quantity, 'group' | 'field'>,
): boolean {
  return seriesOf(columnNames, quantity.group, quantity.field).some((s) => selected.has(s.name));
}

/**
 * The selection after ``quantity`` is flipped: off when any of its series was
 * on, otherwise on for the elements described in the file header.
 */
export function toggleQuantity(
  columnNames: readonly string[],
  selected: ReadonlySet<string>,
  quantity: Pick<Quantity, 'group' | 'field' | 'partner'>,
): Set<string> {
  const next = new Set(selected);
  const own = seriesOf(columnNames, quantity.group, quantity.field);
  if (own.some((s) => next.has(s.name))) {
    for (const s of own) next.delete(s.name);
    return next;
  }
  const partnerElements = new Set(
    seriesOf(columnNames, quantity.group, quantity.partner)
      .filter((s) => selected.has(s.name))
      .map((s) => s.elementIdx),
  );
  const followed = own.filter((s) => partnerElements.has(s.elementIdx));
  const chosen = followed.length > 0 ? followed : own.slice(0, MAX_ELEMENTS);
  for (const s of chosen) next.add(s.name);
  return next;
}
