/**
 * `wecc/wecc_full.xlsx` of ANDES (the WECC 179-bus, 29-machine system of the CURENT group) as the
 * diagram reads it: the buses, the branches between them, and the devices on them. It is the
 * topology TENSA gives for that file, cut down to what places and routes a diagram (no
 * electrical parameters). The gallery case that is the largest of the dynamic ones: the
 * layout, the router and the overlap checker are held to it as to the 118-bus case.
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';

/** The name of each bus, in the order of their numbers (1 to 179). Several buses share a name. */
// prettier-ignore
const BUS_NAMES = [
  'CORONADO', 'CHOLLA', 'CORONADO', 'CRAIG', 'CRAIG', 'FOURCORN', 'FOURCORN', 'FCNGN4CC',
  'FOURCORN', 'HAYDEN', 'NAVAJO', 'NAVAJO 2', 'MOENKOPI', 'PALOVRD2', 'PALOVRDE', 'SAN JUAN',
  'SJUAN G4', 'WESTWING', 'NAVAJO1', 'NAVAJO2', 'NAVAJO3', 'NAVAJO4', 'MOENKOP1', 'MOENKOP2',
  'MOENKOP3', 'MOENKOP4', 'FOURCOR1', 'FOURCOR2', 'CANAD G1', 'CANADA', 'CANALB', 'CA230TO',
  'CA230', 'CMAIN GM', 'BRIDGER2', 'ADELANTO', 'ADELAN&1', 'CASTAIC', 'CASTAI4G', 'GLENDAL',
  'HAYNES', 'HAYNES3G', 'INTERMT', 'INTERM1G', 'OLIVE', 'OWENS G', 'RINALDI', 'RINALDI', 'RIVER',
  'STA B', 'STA B1', 'STA B2', 'STA BLD', 'STA E', 'STA E', 'STA F', 'STA G', 'STA J',
  'SYLMARLA', 'SYLMAR S', 'VALLEY', 'VICTORVL', 'VICTORVL', 'MONTA G1', 'MONTANA', 'BIG EDDY',
  'BIG EDDY', 'BIG EDDY', 'DALLES21', 'CELILO', 'CELILOCA', 'COLSTRP', 'COULEE', 'GARRISON',
  'JOHN DAY', 'JOHN DAY', 'HANFORD', 'NORTH G3', 'NORTH', 'BURNS', 'GRIZZLY', 'MALIN',
  'MIDPOINT', 'MIDPOINT', 'SUMMER L', 'GRIZZLY1', 'GRIZZLY2', 'MALIN1', 'MALIN2', 'GRIZZLY3',
  'GRIZZLY4', 'GRIZZLY5', 'GRIZZLY6', 'GRIZZLY7', 'GRIZZLY8', 'GRIZZLY9', 'GRIZZLYA', 'BURNS1',
  'CORTINA', 'COTWDPGE', 'DIABLO', 'DIABLO1', 'GATES', 'GLENN', 'LOGAN CR', 'LOSBANOS', 'MIDWAY',
  'MIDWAY', 'MOSSLAND', 'OLINDA', 'ROUND MT', 'ROUND MT', 'ROUND MT', 'TABLE MT', 'TEVATR',
  'TEVATR', 'TEVATR2', 'TEVATR', 'OLINDA1', 'OLINDA2', 'OLINDA3', 'OLINDA4', 'ROUND1', 'ROUND2',
  'ROUND3', 'ROUND4', 'TABLE1', 'TABLE2', 'TABLE3', 'TABLE4', 'TEVATR1', 'TEVATR2', 'TEVATR3',
  'GATES1', 'DEVERS', 'EAGLROCK', 'ELDORADO', 'ELDORADO', 'LITEHIPE', 'LITEHIPE', 'LUGO',
  'MESA CAL', 'MIRALOMA', 'MIRALOMA', 'MIRALOMA', 'MOHAVE', 'MOHAV1CC', 'PARDEE', 'PARDEE',
  'SERRANO', 'VALLEY', 'VINCENT', 'VINCENT', 'CAMP WIL', 'BENLOMND', 'BENLOMND', 'EMERY',
  'EMERY', 'MONA', 'NAUGHTON', 'NAUGHT', 'PINTO PS', 'PINTO', 'SPAN FRK', 'SIGURD', 'TERMINAL',
  'MALIN3', 'MALIN4', 'MALIN5', 'MALIN6', 'MALIN7', 'MALIN8', 'MIDWAY1', 'MIDWAY2', 'MIDWAY3',
  'MIDWAY4', 'MIDWAY5', 'MIDWAY6', 'BURNS2',
];

/**
 * The two buses of each branch, one pair after the other: branch `n` (from 1) is the `n`th
 * pair. The first 203 are lines and the last 60 are transformers.
 */
// prettier-ignore
const BRANCH_BUSES = [
  2, 7, 4, 16, 4, 159, 6, 27, 7, 16, 7, 162, 11, 19, 11, 21, 11, 138, 13, 20, 13, 23, 13, 25, 13,
  28, 15, 18, 15, 18, 15, 135, 15, 135, 18, 22, 18, 24, 19, 20, 21, 22, 23, 24, 25, 26, 26, 138,
  27, 28, 30, 31, 30, 79, 32, 33, 36, 37, 36, 55, 36, 63, 36, 63, 38, 45, 38, 47, 38, 58, 38, 59,
  40, 54, 40, 57, 41, 49, 41, 49, 41, 56, 41, 57, 43, 159, 43, 159, 45, 47, 47, 54, 47, 54, 47,
  58, 47, 58, 47, 58, 47, 58, 47, 59, 47, 59, 47, 59, 47, 61, 47, 61, 48, 63, 49, 56, 49, 57, 51,
  62, 52, 62, 53, 56, 53, 56, 54, 57, 54, 57, 54, 61, 56, 57, 60, 136, 60, 149, 60, 149, 63, 138,
  63, 138, 63, 141, 65, 77, 67, 70, 67, 70, 68, 71, 68, 71, 68, 75, 68, 75, 72, 74, 73, 77, 74,
  75, 74, 77, 75, 77, 75, 77, 75, 81, 75, 81, 75, 81, 77, 79, 77, 79, 80, 98, 80, 179, 81, 86,
  81, 90, 81, 94, 82, 88, 82, 93, 82, 97, 82, 167, 82, 169, 82, 171, 83, 98, 84, 155, 85, 87, 85,
  89, 85, 179, 86, 87, 88, 89, 90, 91, 91, 92, 92, 93, 94, 95, 95, 96, 96, 97, 99, 100, 99, 116,
  100, 104, 100, 105, 100, 112, 100, 112, 100, 112, 100, 116, 101, 103, 101, 107, 101, 107, 103,
  106, 103, 133, 103, 134, 104, 116, 105, 116, 106, 107, 106, 109, 107, 132, 107, 134, 107, 173,
  107, 175, 107, 177, 110, 119, 110, 172, 113, 123, 113, 125, 113, 168, 113, 170, 114, 124, 114,
  126, 114, 127, 114, 129, 118, 122, 118, 128, 118, 130, 118, 131, 118, 133, 119, 120, 120, 121,
  121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 135, 151, 136, 142, 136, 149, 138,
  141, 138, 146, 140, 142, 141, 144, 141, 144, 141, 146, 141, 150, 141, 152, 141, 152, 142, 145,
  142, 153, 144, 150, 149, 153, 149, 153, 150, 151, 152, 174, 152, 176, 152, 178, 154, 155, 154,
  157, 154, 157, 154, 159, 154, 159, 154, 164, 154, 166, 155, 166, 156, 160, 157, 163, 157, 164,
  157, 165, 157, 165, 159, 165, 159, 165, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177,
  178, 1, 2, 1, 3, 4, 5, 4, 10, 6, 7, 6, 7, 7, 8, 7, 9, 7, 9, 11, 12, 15, 14, 16, 17, 30, 29, 31,
  32, 33, 34, 84, 35, 37, 47, 38, 39, 41, 42, 43, 44, 47, 46, 48, 47, 51, 50, 52, 50, 53, 50, 53,
  50, 55, 54, 55, 54, 59, 60, 63, 62, 65, 64, 67, 66, 68, 67, 68, 67, 67, 69, 71, 70, 75, 76, 79,
  78, 83, 84, 101, 102, 108, 107, 108, 107, 111, 112, 112, 113, 115, 116, 116, 118, 117, 118,
  137, 138, 139, 140, 143, 144, 144, 145, 146, 147, 148, 149, 152, 153, 152, 153, 152, 153, 155,
  156, 157, 158, 160, 161, 163, 162,
];

/** The number of the first transformer among the branches. */
const FIRST_TRANSFORMER = 204;

/**
 * The static generators, as `[idx, bus]`, in the order the server lists them (the slack last), and
 * the one of them that is the slack. Each has a round-rotor machine named `GENROU_<idx>` on its
 * bus, and the machines are listed by their numbers.
 */
// prettier-ignore
const GENERATORS: [number, number][] = [
  [1, 3], [2, 5], [3, 8], [4, 10], [5, 12], [6, 14], [7, 17], [8, 29], [9, 34], [10, 35],
  [11, 39], [12, 42], [13, 44], [14, 46], [15, 64], [16, 69], [18, 78], [19, 102], [20, 111],
  [21, 115], [22, 117], [23, 137], [24, 139], [25, 143], [26, 147], [27, 148], [28, 158],
  [29, 161], [17, 76],
];
const SLACK = 17;

/** The bus of each load (`PQ_1` to `PQ_104`) and of each shunt (`Shunt_1` to `Shunt_40`). */
// prettier-ignore
const LOAD_BUSES = [
  1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 29, 30, 33, 34, 35, 36, 39, 40, 42, 43,
  44, 45, 46, 47, 49, 50, 53, 54, 56, 57, 58, 59, 60, 61, 62, 64, 65, 66, 67, 68, 69, 70, 72, 74,
  75, 76, 77, 78, 79, 81, 82, 84, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
  112, 114, 115, 116, 117, 118, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 147, 148, 149,
  150, 151, 153, 154, 155, 156, 157, 158, 159, 160, 161, 163, 164, 165, 166,
];
// prettier-ignore
const SHUNT_BUSES = [
  6, 7, 11, 13, 15, 16, 18, 36, 43, 48, 59, 62, 67, 70, 71, 75, 77, 79, 80, 81, 82, 83, 84, 103,
  107, 108, 112, 113, 114, 116, 118, 138, 144, 146, 153, 154, 157, 163, 165, 179,
];

/**
 * The controllers, as `[model, idx, reference, what it names]`: an exciter or a governor names
 * its machine (`syn`), a stabiliser the exciter it works through (`avr`).
 */
// prettier-ignore
const CONTROLLERS: [string, string, 'syn' | 'avr', string][] = [
  ['ESDC2A', 'ESDC2A_1', 'syn', 'GENROU_4'], ['ESDC2A', 'ESDC2A_2', 'syn', 'GENROU_7'],
  ['ESDC2A', 'ESDC2A_3', 'syn', 'GENROU_12'], ['ESDC2A', 'ESDC2A_4', 'syn', 'GENROU_17'],
  ['ESDC2A', 'ESDC2A_5', 'syn', 'GENROU_18'], ['ESDC2A', 'ESDC2A_6', 'syn', 'GENROU_20'],
  ['ESDC2A', 'ESDC2A_7', 'syn', 'GENROU_22'], ['ESDC2A', 'ESDC2A_8', 'syn', 'GENROU_24'],
  ['IEEEG1', 'IEEEG1_1', 'syn', 'GENROU_1'], ['IEEEG1', 'IEEEG1_2', 'syn', 'GENROU_2'],
  ['IEEEG1', 'IEEEG1_3', 'syn', 'GENROU_3'], ['IEEEG1', 'IEEEG1_4', 'syn', 'GENROU_4'],
  ['IEEEG1', 'IEEEG1_5', 'syn', 'GENROU_5'], ['IEEEG1', 'IEEEG1_6', 'syn', 'GENROU_6'],
  ['IEEEG1', 'IEEEG1_7', 'syn', 'GENROU_7'], ['IEEEG1', 'IEEEG1_8', 'syn', 'GENROU_8'],
  ['IEEEG1', 'IEEEG1_9', 'syn', 'GENROU_9'], ['IEEEG1', 'IEEEG1_10', 'syn', 'GENROU_10'],
  ['IEEEG1', 'IEEEG1_11', 'syn', 'GENROU_11'], ['IEEEG1', 'IEEEG1_12', 'syn', 'GENROU_12'],
  ['IEEEG1', 'IEEEG1_13', 'syn', 'GENROU_13'], ['IEEEG1', 'IEEEG1_14', 'syn', 'GENROU_14'],
  ['IEEEG1', 'IEEEG1_15', 'syn', 'GENROU_15'], ['IEEEG1', 'IEEEG1_16', 'syn', 'GENROU_16'],
  ['IEEEG1', 'IEEEG1_17', 'syn', 'GENROU_17'], ['IEEEG1', 'IEEEG1_18', 'syn', 'GENROU_18'],
  ['IEEEG1', 'IEEEG1_19', 'syn', 'GENROU_19'], ['IEEEG1', 'IEEEG1_20', 'syn', 'GENROU_20'],
  ['IEEEG1', 'IEEEG1_21', 'syn', 'GENROU_21'], ['IEEEG1', 'IEEEG1_22', 'syn', 'GENROU_22'],
  ['IEEEG1', 'IEEEG1_23', 'syn', 'GENROU_23'], ['IEEEG1', 'IEEEG1_24', 'syn', 'GENROU_24'],
  ['IEEEG1', 'IEEEG1_25', 'syn', 'GENROU_25'], ['IEEEG1', 'IEEEG1_26', 'syn', 'GENROU_26'],
  ['IEEEG1', 'IEEEG1_27', 'syn', 'GENROU_27'], ['IEEEG1', 'IEEEG1_28', 'syn', 'GENROU_28'],
  ['IEEEG1', 'IEEEG1_29', 'syn', 'GENROU_29'], ['IEEEST', 'IEEEST_1', 'avr', 'ESST3A_26'],
  ['IEEEST', 'IEEEST_2', 'avr', 'ESDC2A_6'], ['IEEEST', 'IEEEST_3', 'avr', 'EXST1_19'],
  ['IEEEST', 'IEEEST_4', 'avr', 'ESDC2A_7'], ['EXST1', 'EXST1_9', 'syn', 'GENROU_3'],
  ['EXST1', 'EXST1_10', 'syn', 'GENROU_5'], ['EXST1', 'EXST1_11', 'syn', 'GENROU_8'],
  ['EXST1', 'EXST1_12', 'syn', 'GENROU_9'], ['EXST1', 'EXST1_13', 'syn', 'GENROU_10'],
  ['EXST1', 'EXST1_14', 'syn', 'GENROU_11'], ['EXST1', 'EXST1_15', 'syn', 'GENROU_14'],
  ['EXST1', 'EXST1_16', 'syn', 'GENROU_15'], ['EXST1', 'EXST1_17', 'syn', 'GENROU_16'],
  ['EXST1', 'EXST1_18', 'syn', 'GENROU_19'], ['EXST1', 'EXST1_19', 'syn', 'GENROU_21'],
  ['EXST1', 'EXST1_20', 'syn', 'GENROU_23'], ['EXST1', 'EXST1_21', 'syn', 'GENROU_25'],
  ['EXST1', 'EXST1_22', 'syn', 'GENROU_26'], ['EXST1', 'EXST1_23', 'syn', 'GENROU_27'],
  ['EXST1', 'EXST1_24', 'syn', 'GENROU_28'], ['EXST1', 'EXST1_25', 'syn', 'GENROU_29'],
  ['ESST3A', 'ESST3A_26', 'syn', 'GENROU_1'], ['ESST3A', 'ESST3A_27', 'syn', 'GENROU_2'],
  ['ESST3A', 'ESST3A_28', 'syn', 'GENROU_6'], ['ESST3A', 'ESST3A_29', 'syn', 'GENROU_13'],
  ['ST2CUT', 'ST2CUT_5', 'avr', 'ESST3A_27'], ['ST2CUT', 'ST2CUT_6', 'avr', 'EXST1_9'],
  ['ST2CUT', 'ST2CUT_7', 'avr', 'ESDC2A_1'], ['ST2CUT', 'ST2CUT_8', 'avr', 'EXST1_10'],
  ['ST2CUT', 'ST2CUT_9', 'avr', 'ESST3A_28'], ['ST2CUT', 'ST2CUT_10', 'avr', 'ESDC2A_2'],
  ['ST2CUT', 'ST2CUT_11', 'avr', 'EXST1_11'], ['ST2CUT', 'ST2CUT_12', 'avr', 'EXST1_12'],
  ['ST2CUT', 'ST2CUT_13', 'avr', 'EXST1_13'], ['ST2CUT', 'ST2CUT_14', 'avr', 'EXST1_14'],
  ['ST2CUT', 'ST2CUT_15', 'avr', 'ESDC2A_3'], ['ST2CUT', 'ST2CUT_16', 'avr', 'ESST3A_29'],
  ['ST2CUT', 'ST2CUT_17', 'avr', 'EXST1_15'], ['ST2CUT', 'ST2CUT_18', 'avr', 'EXST1_16'],
  ['ST2CUT', 'ST2CUT_19', 'avr', 'EXST1_17'], ['ST2CUT', 'ST2CUT_20', 'avr', 'ESDC2A_4'],
  ['ST2CUT', 'ST2CUT_21', 'avr', 'ESDC2A_5'], ['ST2CUT', 'ST2CUT_22', 'avr', 'EXST1_18'],
  ['ST2CUT', 'ST2CUT_23', 'avr', 'EXST1_20'], ['ST2CUT', 'ST2CUT_24', 'avr', 'ESDC2A_8'],
  ['ST2CUT', 'ST2CUT_25', 'avr', 'EXST1_21'], ['ST2CUT', 'ST2CUT_26', 'avr', 'EXST1_22'],
  ['ST2CUT', 'ST2CUT_27', 'avr', 'EXST1_23'], ['ST2CUT', 'ST2CUT_28', 'avr', 'EXST1_24'],
  ['ST2CUT', 'ST2CUT_29', 'avr', 'EXST1_25'],
];

const entry = (
  idx: number | string,
  kind: string,
  params: TopologyEntry['params'],
  name = String(idx),
): TopologyEntry => ({ idx, name, kind, params });

const branchEntries = (from: number, to: number): TopologyEntry[] => {
  const out: TopologyEntry[] = [];
  for (let n = from; n <= to; n += 1) {
    const [bus1, bus2] = [BRANCH_BUSES[2 * (n - 1)]!, BRANCH_BUSES[2 * (n - 1) + 1]!];
    out.push(entry(`Line_${n}`, 'Line', { bus1, bus2 }));
  }
  return out;
};

export const WECC179: TopologySummary = {
  state: 'pre-setup',
  buses: BUS_NAMES.map((name, i) => entry(i + 1, 'Bus', {}, name)),
  lines: branchEntries(1, FIRST_TRANSFORMER - 1),
  transformers: branchEntries(FIRST_TRANSFORMER, BRANCH_BUSES.length / 2),
  generators: [
    ...GENERATORS.map(([idx, bus]) => entry(idx, idx === SLACK ? 'Slack' : 'PV', { bus })),
    ...[...GENERATORS]
      .sort(([a], [b]) => a - b)
      .map(([idx, bus]) => entry(`GENROU_${idx}`, 'GENROU', { bus, gen: idx })),
  ],
  loads: LOAD_BUSES.map((bus, i) => entry(`PQ_${i + 1}`, 'PQ', { bus })),
  shunts: SHUNT_BUSES.map((bus, i) => entry(`Shunt_${i + 1}`, 'Shunt', { bus })),
  controllers: CONTROLLERS.map(([kind, idx, reference, target]) =>
    entry(idx, kind, { [reference]: target }),
  ),
};
