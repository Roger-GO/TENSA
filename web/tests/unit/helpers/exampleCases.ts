/**
 * The example cases the server seeds a workspace with (all but NPCC 140, whose
 * drawing the browser tests hold), as the diagram reads them: the buses, the branches between them, and the devices on them.
 * Each is the topology the server gives for the file of that name, cut down to
 * what places and routes a diagram (no electrical parameters).
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';

type Idx = number | string;

const entry = (
  idx: Idx,
  kind: string,
  params: TopologyEntry['params'],
  name = String(idx),
): TopologyEntry => ({ idx, name, kind, params });

const branches = (pairs: readonly [Idx, Idx][], firstNumber: number): TopologyEntry[] =>
  pairs.map(([bus1, bus2], i) => entry(`Line_${firstNumber + i}`, 'Line', { bus1, bus2 }));

const loads = (buses: readonly Idx[], firstNumber: number): TopologyEntry[] =>
  buses.map((bus, i) => entry(`PQ_${firstNumber + i}`, 'PQ', { bus }));

/** `ieee14_full.xlsx` of ANDES. */
export const IEEE14: TopologySummary = {
  state: 'pre-setup',
  buses: Array.from({ length: 14 }, (_, i) => entry(i + 1, 'Bus', {}, `BUS${i + 1}`)),
  lines: branches(
    [
      [1, 2],
      [1, 5],
      [2, 3],
      [2, 4],
      [2, 5],
      [3, 4],
      [4, 5],
      [6, 11],
      [6, 12],
      [6, 13],
      [7, 9],
      [9, 10],
      [9, 14],
      [10, 11],
      [12, 13],
      [13, 14],
    ],
    1,
  ),
  transformers: branches(
    [
      [4, 7],
      [4, 9],
      [6, 5],
      [8, 7],
    ],
    17,
  ),
  generators: [
    entry(2, 'PV', { bus: 2 }),
    entry(3, 'PV', { bus: 3 }),
    entry(4, 'PV', { bus: 6 }),
    entry(5, 'PV', { bus: 8 }),
    entry(1, 'Slack', { bus: 1 }),
    ...[1, 2, 3, 6, 8].map((bus, i) => entry(`GENROU_${i + 1}`, 'GENROU', { bus, gen: i + 1 })),
  ],
  loads: loads([2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14], 1),
  shunts: [entry('Shunt_1', 'Shunt', { bus: 9 }), entry('Shunt_2', 'Shunt', { bus: 14 })],
  controllers: [
    ...[1, 2, 3, 4, 5].map((n) => entry(`TGOV1_${n}`, 'TGOV1', { syn: `GENROU_${n}` })),
    entry('EXST1_1', 'EXST1', { syn: 'GENROU_2' }),
  ],
};

/**
 * `wscc9.xlsx` of TENSA (the file `scripts/build_wscc9.py` writes): the network of the book
 * and a classical machine on each of its three generators. The three step-up transformers
 * are at their nominal ratio, and the server lists them as transformers because the file
 * flags them and rates their two ends at different voltages. The branches and the loads are
 * numbered as ANDES numbers those of its own `wscc9.xlsx` (the six lines, then the three
 * transformers, and the loads at buses 5, 6 and 8), and the buses at the ends of a line are
 * the order the book gives them in.
 */
export const WSCC9: TopologySummary = {
  state: 'pre-setup',
  buses: Array.from({ length: 9 }, (_, i) => entry(i + 1, 'Bus', {}, `Bus ${i + 1}`)),
  lines: branches(
    [
      [4, 5],
      [4, 6],
      [5, 7],
      [6, 9],
      [7, 8],
      [8, 9],
    ],
    0,
  ),
  transformers: branches(
    [
      [1, 4],
      [2, 7],
      [3, 9],
    ],
    6,
  ),
  generators: [
    entry(2, 'PV', { bus: 2 }),
    entry(3, 'PV', { bus: 3 }),
    entry(1, 'Slack', { bus: 1 }),
    ...[1, 2, 3].map((n) => entry(n, 'GENCLS', { bus: n, gen: n })),
  ],
  loads: loads([5, 6, 8], 0),
  shunts: [],
  controllers: [],
};

/**
 * The network of ANDES's own `wscc9.xlsx`, which has no machines: the case an earlier TENSA
 * seeded under the name `wscc9.xlsx`, and that a workspace made then still holds. The tests
 * of a drag, a draft or a bend that were found on its drawing keep it, since where a line
 * goes round something depends on where the symbols stand, and the generators of
 * `WSCC9` stand in other places.
 */
export const WSCC9_NETWORK: TopologySummary = {
  state: 'pre-setup',
  buses: Array.from({ length: 9 }, (_, i) => entry(i + 1, 'Bus', {}, `Bus ${i + 1}`)),
  lines: branches(
    [
      [5, 4],
      [6, 4],
      [7, 5],
      [9, 6],
      [7, 8],
      [8, 9],
    ],
    0,
  ),
  transformers: branches(
    [
      [4, 1],
      [2, 7],
      [9, 3],
    ],
    6,
  ),
  generators: [
    entry(2, 'PV', { bus: 2 }),
    entry(3, 'PV', { bus: 3 }),
    entry(1, 'Slack', { bus: 1 }),
  ],
  loads: loads([5, 6, 8], 0),
  shunts: [],
  controllers: [],
};

/**
 * `kundur_full.xlsx` of ANDES: two areas of two machines each, joined by a
 * double line. Its buses are numbered 1 to 10 and named after the textbook. Each machine
 * has a step-up transformer at its nominal ratio (20 and 230 kV), which the server lists
 * as a transformer for its two rated voltages.
 */
export const KUNDUR: TopologySummary = {
  state: 'pre-setup',
  buses: ['1', '2', '12', '11', '101', '102', '3', '13', '112', '111'].map((name, i) =>
    entry(i + 1, 'Bus', {}, name),
  ),
  lines: branches(
    [
      [5, 6],
      [5, 6],
      [6, 7],
      [6, 7],
      [7, 8],
      [7, 8],
      [7, 8],
      [8, 9],
      [8, 9],
      [9, 10],
      [9, 10],
    ],
    0,
  ),
  transformers: branches(
    [
      [1, 5],
      [2, 6],
      [3, 9],
      [4, 10],
    ],
    11,
  ),
  generators: [
    entry(2, 'PV', { bus: 2 }),
    entry(3, 'PV', { bus: 3 }),
    entry(4, 'PV', { bus: 4 }),
    entry(1, 'Slack', { bus: 1 }),
    ...[1, 2, 3, 4].map((n) => entry(n, 'GENROU', { bus: n, gen: n })),
  ],
  loads: loads([7, 8], 0),
  shunts: [],
  controllers: [1, 2, 3, 4].map((n) => entry(n, 'TGOV1', { syn: n })),
};

/**
 * `ieee39_full.xlsx` of ANDES: the New England system, 39 buses and 46 branches, 12 of them
 * transformers (the ten generator step-up units and two more, which the server lists for
 * their tap or their two rated voltages). Each of the ten generators has a round-rotor
 * machine, an IEEEX1 exciter and an IEEEST stabiliser; the governors are not listed by the
 * server. It has 19 loads and two capacitors.
 */
export const IEEE39: TopologySummary = {
  state: 'pre-setup',
  buses: [
    ...['BUS1', 'BUS2', 'LOAD3', 'LOAD4', 'BUS5', 'BUS6', 'LOAD7', 'LOAD8', 'BUS9', 'BUS10'],
    ...['BUS11', 'LOAD12', 'BUS13', 'BUS14', 'LOAD15', 'LOAD16', 'BUS17', 'LOAD18', 'BUS19'],
    ...['LOAD20', 'LOAD21', 'BUS22', 'LOAD23', 'LOAD24', 'LOAD25', 'LOAD26', 'LOAD27', 'LOAD28'],
    ...['LOAD29', 'GEN30', 'GEN31', 'GEN32', 'GEN33', 'GEN34', 'GEN35', 'GEN36', 'GEN37'],
    ...['GEN38', 'GEN39'],
  ].map((name, i) => entry(i + 1, 'Bus', {}, name)),
  lines: branches(
    [
      [1, 2],
      [1, 39],
      [2, 3],
      [2, 25],
      [3, 4],
      [3, 18],
      [4, 5],
      [4, 14],
      [5, 6],
      [5, 8],
      [6, 7],
      [6, 11],
      [7, 8],
      [8, 9],
      [9, 39],
      [10, 11],
      [10, 13],
      [13, 14],
      [14, 15],
      [15, 16],
      [16, 17],
      [16, 19],
      [16, 21],
      [16, 24],
      [17, 18],
      [17, 27],
      [21, 22],
      [22, 23],
      [23, 24],
      [25, 26],
      [26, 27],
      [26, 28],
      [26, 29],
      [28, 29],
    ],
    1,
  ),
  transformers: branches(
    [
      [2, 30],
      [31, 6],
      [10, 32],
      [12, 11],
      [12, 13],
      [19, 20],
      [19, 33],
      [20, 34],
      [22, 35],
      [23, 36],
      [25, 37],
      [29, 38],
    ],
    35,
  ),
  generators: [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => entry(n, 'PV', { bus: 29 + n })),
    entry(10, 'Slack', { bus: 39 }),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
      entry(`GENROU_${n}`, 'GENROU', { bus: 29 + n, gen: n }),
    ),
  ],
  loads: loads([3, 4, 7, 8, 12, 15, 16, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29, 31, 39], 1),
  shunts: [entry('Shunt_1', 'Shunt', { bus: 4 }), entry('Shunt_2', 'Shunt', { bus: 5 })],
  controllers: [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
      entry(`IEEEX1_${n}`, 'IEEEX1', { syn: `GENROU_${n}` }),
    ),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
      entry(`IEEEST_${n}`, 'IEEEST', { avr: `IEEEX1_${n}` }),
    ),
  ],
};
