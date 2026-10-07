/**
 * What the rows of the diagram search are, and the words each is found by.
 *
 * A case names its elements by a number or by their model class (`3`,
 * `PQ_1`, `EXDC2_2`), so a person who looks for "the exciters" or "a load"
 * finds nothing by name. Each row therefore says what it is (a bus, a
 * machine, an exciter), and is found by that word, by the words that mean
 * the same and by its ANDES model class as well as by its name and idx. The
 * same categories are what the search can be narrowed to, which is how the
 * controllers of a case are browsed without knowing what they are called.
 *
 * Pure: nothing is read but what a node of the diagram carries.
 */
import { subKindForControllerClass, type ControllerSubKind } from '@/lib/controllers';
import type { UnitRole } from '@/lib/generatingUnits';
import { DYNAMIC_GENERATOR_KINDS } from '@/lib/topology';

export type SearchCategory =
  | 'bus'
  | 'line'
  | 'generator'
  | 'load'
  | 'shunt'
  | 'machine'
  | 'exciter'
  | 'governor'
  | 'pss'
  | 'renewable'
  | 'measurement'
  | 'profile'
  | 'controller';

export interface SearchCategoryInfo {
  /** One of them, as a row is tagged: the word the Inspector heads it with. */
  label: string;
  /** Several of them, as a sentence names them; the filter capitalises it. */
  plural: string;
  /** The words it is found by, lower case. A word typed in part finds it too. */
  words: readonly string[];
  /** A dynamic model: what a static-only case has none of. */
  dynamic: boolean;
}

export const SEARCH_CATEGORIES: Record<SearchCategory, SearchCategoryInfo> = {
  bus: {
    label: 'Bus',
    plural: 'buses',
    words: ['bus', 'buses', 'busbar', 'busbars'],
    dynamic: false,
  },
  // The diagram draws a line or a transformer as an edge, which the search
  // does not list: the words are there so that a look for one can be told so.
  line: {
    label: 'Line',
    plural: 'lines',
    words: ['line', 'lines', 'branch', 'branches', 'transformer', 'transformers'],
    dynamic: false,
  },
  generator: {
    label: 'Generator',
    plural: 'generators',
    words: ['generator', 'generators'],
    dynamic: false,
  },
  load: { label: 'Load', plural: 'loads', words: ['load', 'loads'], dynamic: false },
  shunt: { label: 'Shunt', plural: 'shunts', words: ['shunt', 'shunts'], dynamic: false },
  machine: {
    label: 'Machine',
    plural: 'machines',
    // A machine is the generator of a time-domain run, and `SG` on its symbol.
    words: ['machine', 'machines', 'generator', 'generators', 'synchronous', 'sg'],
    dynamic: true,
  },
  exciter: {
    label: 'Exciter',
    plural: 'exciters',
    words: ['exciter', 'exciters', 'avr', 'controller', 'controllers'],
    dynamic: true,
  },
  governor: {
    label: 'Governor',
    plural: 'governors',
    words: ['governor', 'governors', 'turbine', 'controller', 'controllers'],
    dynamic: true,
  },
  pss: {
    label: 'PSS',
    plural: 'PSS',
    words: [
      'pss',
      'stabiliser',
      'stabilisers',
      'stabilizer',
      'stabilizers',
      'controller',
      'controllers',
    ],
    dynamic: true,
  },
  renewable: {
    label: 'Renewable',
    plural: 'renewables',
    words: ['renewable', 'renewables', 'converter', 'inverter', 'controller', 'controllers'],
    dynamic: true,
  },
  measurement: {
    label: 'Measurement',
    plural: 'measurements',
    words: ['measurement', 'measurements'],
    dynamic: true,
  },
  profile: { label: 'Profile', plural: 'profiles', words: ['profile', 'profiles'], dynamic: true },
  controller: {
    label: 'Controller',
    plural: 'other controllers',
    words: ['controller', 'controllers'],
    dynamic: true,
  },
};

/**
 * The order the categories are listed in, in the filter and in the rows:
 * the order of the tables of the bottom drawer, then the controllers those
 * have no table for.
 */
export const SEARCH_CATEGORY_ORDER: readonly SearchCategory[] = [
  'bus',
  'line',
  'generator',
  'load',
  'shunt',
  'machine',
  'exciter',
  'governor',
  'pss',
  'renewable',
  'measurement',
  'profile',
  'controller',
];

const CATEGORY_OF_SUBKIND: Record<ControllerSubKind, SearchCategory> = {
  exciter: 'exciter',
  governor: 'governor',
  pss: 'pss',
  renewable: 'renewable',
  measurement: 'measurement',
  profile: 'profile',
  other: 'controller',
};

/** What a model of a generating unit is, by what it is to the unit. */
export function categoryOfRole(role: UnitRole): SearchCategory {
  if (role === 'generator' || role === 'machine') return role;
  return CATEGORY_OF_SUBKIND[role];
}

/**
 * What a node of the diagram is: by its node type, and for a generator or a
 * controller by its ANDES model class (`kind`) too. A generator node whose
 * own model is a machine (a unit with no static generator) is a machine.
 */
export function categoryOfNode(type: string | undefined, kind: string | undefined): SearchCategory {
  switch (type) {
    case 'generator':
      return kind !== undefined && DYNAMIC_GENERATOR_KINDS.has(kind) ? 'machine' : 'generator';
    case 'controller':
      return CATEGORY_OF_SUBKIND[subKindForControllerClass(kind ?? '')];
    case 'line':
    case 'load':
    case 'shunt':
      return type;
    default:
      return 'bus';
  }
}

/** The words of a query, lower case. A row has to be found by every one. */
export function searchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether `token` is one of the words of `category`, or the start of one. */
export function categoryHasWord(category: SearchCategory, token: string): boolean {
  return SEARCH_CATEGORIES[category].words.some((word) => word.startsWith(token));
}

/**
 * The categories a query asks for by word: what "exciter" or "avr" means
 * when no row is found by it, so the search can say that the case has none.
 */
export function categoriesAsked(tokens: readonly string[]): SearchCategory[] {
  return SEARCH_CATEGORY_ORDER.filter((category) =>
    tokens.some((token) => categoryHasWord(category, token)),
  );
}

/** The name of the filter of `category`: its plural, capitalised. */
export function categoryFilterLabel(category: SearchCategory): string {
  const { plural } = SEARCH_CATEGORIES[category];
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

/**
 * A count of a category as a sentence has it: `4 governors`, `1 machine`. An
 * abbreviation keeps its capitals.
 */
export function categoryCount(category: SearchCategory, count: number): string {
  const { label, plural } = SEARCH_CATEGORIES[category];
  if (count !== 1) return `${count} ${plural}`;
  return `1 ${label === label.toUpperCase() ? label : label.toLowerCase()}`;
}

/** `a, b or c`, or with `and`. */
export function joinWords(items: readonly string[], last: 'or' | 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}
