/**
 * The kinds of element the app can add: one list for the Add element form's
 * Kind picker and for the Components palette of the left sidebar, so the two
 * never offer different things.
 *
 * ``value`` is the UI handle (e.g., "Transformer2W"); ``submitModel`` is what
 * the substrate's ``add_element`` endpoint expects (e.g., "Line": ANDES models
 * 2W transformers as Lines with a non-default ``tap``).
 *
 * ``defaultParams`` pre-fills the form on kind selection so transformer
 * adds default to ``tap=1.05`` (off-nominal, required for the
 * Line→Transformer split heuristic to route the new device into the
 * transformers bucket).
 *
 * ``description`` is the one line the palette shows under the name: what the
 * element is, and what it needs first when it cannot stand alone. Each says
 * what ANDES 2.0 says of the model it names. ``keywords`` are the other words
 * a user looks for it under, which the palette's search matches beside the
 * name and the group.
 */
export type ElementKindGroup =
  | 'Network'
  | 'Transformers'
  | 'Generators'
  | 'Exciters'
  | 'Governors'
  | 'Storage'
  | 'Loads'
  | 'Shunts';

export interface ElementKind {
  value: string;
  label: string;
  group: ElementKindGroup;
  submitModel: string;
  defaultParams?: Record<string, string | number | boolean>;
  description: string;
  keywords: readonly string[];
}

export const ELEMENT_KINDS: readonly ElementKind[] = [
  {
    value: 'Bus',
    label: 'Bus',
    group: 'Network',
    submitModel: 'Bus',
    description: 'A node of the network. Everything else connects to one.',
    keywords: ['node', 'busbar', 'substation'],
  },
  {
    value: 'Line',
    label: 'Line',
    group: 'Network',
    submitModel: 'Line',
    description: 'An AC line between two buses.',
    keywords: ['branch', 'transmission', 'cable', 'feeder'],
  },
  {
    value: 'Transformer2W',
    label: 'Transformer (2W)',
    group: 'Transformers',
    submitModel: 'Line',
    defaultParams: { tap: 1.05 },
    description: 'A two-winding transformer between two buses.',
    keywords: ['trafo', 'xfmr', 'tap', 'branch', 'two-winding'],
  },
  {
    value: 'PV',
    label: 'PV generator',
    group: 'Generators',
    submitModel: 'PV',
    description: 'Holds its active power and its bus voltage in the power flow.',
    keywords: ['static', 'source', 'plant', 'unit'],
  },
  {
    value: 'Slack',
    label: 'Slack generator',
    group: 'Generators',
    submitModel: 'Slack',
    description: 'The reference: holds the voltage and angle of its bus and balances the system.',
    keywords: ['swing', 'reference', 'static', 'source', 'infinite'],
  },
  {
    value: 'GENROU',
    label: 'GENROU (synchronous)',
    group: 'Generators',
    submitModel: 'GENROU',
    description:
      'Round-rotor machine for time-domain runs. Needs a PV or Slack generator on its bus.',
    keywords: ['machine', 'dynamic', 'round rotor', 'syngen', 'tds'],
  },
  {
    value: 'GENCLS',
    label: 'GENCLS (classic)',
    group: 'Generators',
    submitModel: 'GENCLS',
    description:
      'Classical machine for time-domain runs. Needs a PV or Slack generator on its bus.',
    keywords: ['machine', 'dynamic', 'classical', 'synchronous', 'syngen', 'tds'],
  },
  // Dynamic controllers attach to a synchronous machine (GENROU/GENCLS) via
  // the ``syn`` link. They make the machine's voltage (exciters) and speed
  // (governors) regulated, so a from-scratch dynamic system is no longer
  // GENROU-only. The machine link renders as a SynIdxSelect dropdown.
  {
    value: 'IEEEX1',
    label: 'IEEEX1 exciter',
    group: 'Exciters',
    submitModel: 'IEEEX1',
    description: 'IEEE type 1 DC exciter. Regulates the voltage of a machine.',
    keywords: ['avr', 'excitation', 'voltage regulator', 'controller', 'dynamic', 'tds'],
  },
  {
    value: 'ESDC2A',
    label: 'ESDC2A exciter',
    group: 'Exciters',
    submitModel: 'ESDC2A',
    description: 'IEEE type DC2A exciter. Regulates the voltage of a machine.',
    keywords: ['avr', 'excitation', 'voltage regulator', 'controller', 'dynamic', 'tds'],
  },
  {
    value: 'EXST1',
    label: 'EXST1 exciter',
    group: 'Exciters',
    submitModel: 'EXST1',
    description: 'IEEE type ST1 static exciter. Regulates the voltage of a machine.',
    keywords: ['avr', 'excitation', 'voltage regulator', 'controller', 'dynamic', 'tds', 'static'],
  },
  {
    value: 'SEXS',
    label: 'SEXS exciter (simple)',
    group: 'Exciters',
    submitModel: 'SEXS',
    description: 'Simplified exciter. Regulates the voltage of a machine.',
    keywords: [
      'avr',
      'excitation',
      'voltage regulator',
      'controller',
      'dynamic',
      'tds',
      'simplified',
    ],
  },
  {
    value: 'TGOV1',
    label: 'TGOV1 governor',
    group: 'Governors',
    submitModel: 'TGOV1',
    description: 'Steam turbine governor. Regulates the speed of a machine.',
    keywords: ['turbine', 'steam', 'speed', 'droop', 'frequency', 'controller', 'dynamic', 'tds'],
  },
  {
    value: 'IEEEG1',
    label: 'IEEEG1 governor',
    group: 'Governors',
    submitModel: 'IEEEG1',
    description: 'IEEE type 1 steam turbine governor. Regulates the speed of a machine.',
    keywords: ['turbine', 'steam', 'speed', 'droop', 'frequency', 'controller', 'dynamic', 'tds'],
  },
  // A battery takes over a static generator on its bus (the ``gen`` link, a
  // GenIdxSelect dropdown) when a time-domain run starts. The form says what
  // its parameters mean, and opens rated on the system base (`elementHelp`).
  {
    value: 'ESD1',
    label: 'ESD1 battery',
    group: 'Storage',
    submitModel: 'ESD1',
    description: 'Battery for time-domain runs. Needs a PV or Slack generator on its bus.',
    keywords: ['bess', 'energy', 'converter', 'inverter', 'dynamic', 'tds'],
  },
  {
    value: 'PQ',
    label: 'PQ load',
    group: 'Loads',
    submitModel: 'PQ',
    description: 'Draws a constant active and reactive power.',
    keywords: ['demand', 'consumer', 'static', 'constant power'],
  },
  {
    value: 'ZIP',
    label: 'ZIP load',
    group: 'Loads',
    submitModel: 'ZIP',
    description: 'Makes a PQ load follow the voltage in time-domain runs. Needs that PQ load.',
    keywords: ['demand', 'polynomial', 'impedance', 'current', 'dynamic', 'tds'],
  },
  {
    value: 'Shunt',
    label: 'Shunt',
    group: 'Shunts',
    submitModel: 'Shunt',
    description: 'A capacitor or a reactor between a bus and ground.',
    keywords: ['capacitor', 'reactor', 'compensation', 'var', 'reactive', 'bank'],
  },
];

/** One group of the list, in the order the list first names it. */
export interface ElementKindSection {
  group: ElementKindGroup;
  kinds: readonly ElementKind[];
}

/** `kinds` by group, each group where the list first names it. */
export function groupElementKinds(kinds: readonly ElementKind[]): ElementKindSection[] {
  const sections: { group: ElementKindGroup; kinds: ElementKind[] }[] = [];
  for (const kind of kinds) {
    const section = sections.find((s) => s.group === kind.group);
    if (section === undefined) sections.push({ group: kind.group, kinds: [kind] });
    else section.kinds.push(kind);
  }
  return sections;
}

/**
 * The kinds a search for `query` keeps: those that hold every word typed, in
 * the name, the model, the group or a keyword, whatever the case. An empty
 * query keeps them all. The descriptions are not searched: most of them name a
 * bus or a generator, so a search for "bus" would keep nearly everything.
 */
export function searchElementKinds(query: string): readonly ElementKind[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return ELEMENT_KINDS;
  return ELEMENT_KINDS.filter((kind) => {
    const haystack = [kind.label, kind.value, kind.group, ...kind.keywords]
      .join('\n')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
