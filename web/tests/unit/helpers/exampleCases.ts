/**
 * The three example cases the server seeds a workspace with, as the diagram
 * reads them: the buses, the branches between them, and the devices on them.
 * Each is the topology ANDES gives for the file of that name, cut down to
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

/** `wscc9.xlsx` of ANDES. */
export const WSCC9: TopologySummary = {
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
      [4, 1],
      [2, 7],
      [9, 3],
    ],
    0,
  ),
  transformers: [],
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
 * double line. Its buses are numbered 1 to 10 and named after the textbook.
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
      [1, 5],
      [2, 6],
      [3, 9],
      [4, 10],
    ],
    0,
  ),
  transformers: [],
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
