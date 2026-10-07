/**
 * `case118.m` of ANDES (the IEEE 118-bus test case, from MATPOWER) as the
 * diagram reads it: the buses, the branches between them, and the devices on
 * them. It is the topology ANDES gives for that file, cut down to what places
 * and routes a diagram (no electrical parameters). A case of this size is
 * what the layout, the router and the overlap checker are held to, and timed
 * on, for a large system.
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';

/** The name of each bus, in the order of their numbers (1 to 118). */
// prettier-ignore
const BUS_NAMES = [
  'Riversde  V2', 'Pokagon   V2', 'HickryCk  V2', 'NwCarlsl  V2', 'Olive     V2', 'Kankakee  V2',
  'JacksnRd  V2', 'Olive     V1', 'Bequine   V1', 'Breed     V1', 'SouthBnd  V2', 'TwinBrch  V2',
  'Concord   V2', 'GoshenJt  V2', 'FtWayne   V2', 'N. E.     V2', 'Sorenson  V2', 'McKinley  V2',
  'Lincoln   V2', 'Adams     V2', 'Jay       V2', 'Randolph  V2', 'CollCrnr  V2', 'Trenton   V2',
  'TannrsCk  V2', 'TannrsCk  V1', 'Madison   V2', 'Mullin    V2', 'Grant     V2', 'Sorenson  V1',
  'DeerCrk   V2', 'Delaware  V2', 'Haviland  V2', 'Rockhill  V2', 'WestLima  V2', 'Sterling  V2',
  'EastLima  V2', 'EastLima  V1', 'NwLibrty  V2', 'West End  V2', 'S.Tiffin  V2', 'Howard    V2',
  'S.Kenton  V2', 'WMVernon  V2', 'N.Newark  V2', 'W.Lancst  V2', 'Crooksvl  V2', 'Zanesvll  V2',
  'Philo     V2', 'WCambrdg  V2', 'Newcmrst  V2', 'SCoshoct  V2', 'Wooster   V2', 'Torrey    V2',
  'Wagenhls  V2', 'Sunnysde  V2', 'WNwPhil1  V2', 'WNwPhil2  V2', 'Tidd      V2', 'SWKammer  V2',
  'W.Kammer  V2', 'Natrium   V2', 'Tidd      V1', 'Kammer    V1', 'Muskngum  V1', 'Muskngum  V2',
  'Summerfl  V2', 'Sporn     V1', 'Sporn     V2', 'Portsmth  V2', 'NPortsmt  V2', 'Hillsbro  V2',
  'Sargents  V2', 'Bellefnt  V2', 'SthPoint  V2', 'Darrah    V2', 'Turner    V2', 'Chemical  V2',
  'CapitlHl  V2', 'CabinCrk  V2', 'Kanawha   V1', 'Logan     V2', 'Sprigg    V2', 'BetsyLne  V2',
  'BeaverCk  V2', 'Hazard    V2', 'Pinevlle  V3', 'Fremont   V2', 'ClinchRv  V2', 'Holston   V2',
  'HolstonT  V2', 'Saltvlle  V2', 'Tazewell  V2', 'Switchbk  V2', 'Caldwell  V2', 'Baileysv  V2',
  'Sundial   V2', 'Bradley   V2', 'Hinton    V2', 'Glen Lyn  V2', 'Wythe     V2', 'Smythe    V2',
  'Claytor   V2', 'Hancock   V2', 'Roanoke   V2', 'Cloverdl  V2', 'Reusens   V2', 'Blaine    V2',
  'Franklin  V2', 'Fieldale  V2', 'DanRiver  V2', 'Danville  V2', 'Deer Crk  V2', 'WMedford  V2',
  'Medford   V2', 'KygerCrk  V2', 'Corey     V2', 'WHuntngd  V2',
];

/** The two buses of each branch, one pair after the other: branch `n` (from 1) is the `n`th pair. */
// prettier-ignore
const BRANCH_BUSES = [
  1, 2, 1, 3, 4, 5, 3, 5, 5, 6, 6, 7, 8, 9, 8, 5, 9, 10, 4, 11, 5, 11, 11, 12, 2, 12, 3, 12, 7,
  12, 11, 13, 12, 14, 13, 15, 14, 15, 12, 16, 15, 17, 16, 17, 17, 18, 18, 19, 19, 20, 15, 19,
  20, 21, 21, 22, 22, 23, 23, 24, 23, 25, 26, 25, 25, 27, 27, 28, 28, 29, 30, 17, 8, 30, 26, 30,
  17, 31, 29, 31, 23, 32, 31, 32, 27, 32, 15, 33, 19, 34, 35, 36, 35, 37, 33, 37, 34, 36, 34,
  37, 38, 37, 37, 39, 37, 40, 30, 38, 39, 40, 40, 41, 40, 42, 41, 42, 43, 44, 34, 43, 44, 45,
  45, 46, 46, 47, 46, 48, 47, 49, 42, 49, 42, 49, 45, 49, 48, 49, 49, 50, 49, 51, 51, 52, 52,
  53, 53, 54, 49, 54, 49, 54, 54, 55, 54, 56, 55, 56, 56, 57, 50, 57, 56, 58, 51, 58, 54, 59,
  56, 59, 56, 59, 55, 59, 59, 60, 59, 61, 60, 61, 60, 62, 61, 62, 63, 59, 63, 64, 64, 61, 38,
  65, 64, 65, 49, 66, 49, 66, 62, 66, 62, 67, 65, 66, 66, 67, 65, 68, 47, 69, 49, 69, 68, 69,
  69, 70, 24, 70, 70, 71, 24, 72, 71, 72, 71, 73, 70, 74, 70, 75, 69, 75, 74, 75, 76, 77, 69,
  77, 75, 77, 77, 78, 78, 79, 77, 80, 77, 80, 79, 80, 68, 81, 81, 80, 77, 82, 82, 83, 83, 84,
  83, 85, 84, 85, 85, 86, 86, 87, 85, 88, 85, 89, 88, 89, 89, 90, 89, 90, 90, 91, 89, 92, 89,
  92, 91, 92, 92, 93, 92, 94, 93, 94, 94, 95, 80, 96, 82, 96, 94, 96, 80, 97, 80, 98, 80, 99,
  92, 100, 94, 100, 95, 96, 96, 97, 98, 100, 99, 100, 100, 101, 92, 102, 101, 102, 100, 103,
  100, 104, 103, 104, 103, 105, 100, 106, 104, 105, 105, 106, 105, 107, 105, 108, 106, 107, 108,
  109, 103, 110, 109, 110, 110, 111, 110, 112, 17, 113, 32, 113, 32, 114, 27, 115, 114, 115, 68,
  116, 12, 117, 75, 118, 76, 118,
];

/** The numbers of the branches that are transformers. */
const TRANSFORMERS = new Set([8, 32, 36, 51, 93, 95, 102, 107, 127]);

/** The bus of each generator, in the order of their numbers; number 30 is the slack. */
// prettier-ignore
const GENERATOR_BUSES = [
  1, 4, 6, 8, 10, 12, 15, 18, 19, 24, 25, 26, 27, 31, 32, 34, 36, 40, 42, 46, 49, 54, 55, 56,
  59, 61, 62, 65, 66, 69, 70, 72, 73, 74, 76, 77, 80, 85, 87, 89, 90, 91, 92, 99, 100, 103, 104,
  105, 107, 110, 111, 112, 113, 116,
];
const SLACK = 30;

/** The bus of each load, in the order of their numbers. */
// prettier-ignore
const LOAD_BUSES = [
  1, 2, 3, 4, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 27, 28, 29, 31,
  32, 33, 34, 35, 36, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
  57, 58, 59, 60, 62, 66, 67, 70, 72, 73, 74, 75, 76, 77, 78, 79, 80, 82, 83, 84, 85, 86, 88,
  90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
  112, 113, 114, 115, 116, 117, 118,
];

/** The bus of each shunt. */
const SHUNT_BUSES = [5, 34, 37, 44, 45, 46, 48, 74, 79, 82, 83, 105, 107, 110];

const entry = (
  idx: number | string,
  kind: string,
  params: TopologyEntry['params'],
  name: string,
): TopologyEntry => ({ idx, name, kind, params });

function branches(transformers: boolean): TopologyEntry[] {
  const out: TopologyEntry[] = [];
  for (let n = 1; 2 * n <= BRANCH_BUSES.length; n += 1) {
    if (TRANSFORMERS.has(n) !== transformers) continue;
    const [bus1, bus2] = [BRANCH_BUSES[2 * n - 2]!, BRANCH_BUSES[2 * n - 1]!];
    out.push(entry(`Line_${n}`, 'Line', { bus1, bus2 }, `Line ${bus1}-${bus2}`));
  }
  return out;
}

const generators = GENERATOR_BUSES.map((bus, i) =>
  i + 1 === SLACK
    ? entry(i + 1, 'Slack', { bus }, `Slack ${bus}`)
    : entry(i + 1, 'PV', { bus }, `PV ${bus}`),
);

export const CASE118: TopologySummary = {
  state: 'pre-setup',
  buses: BUS_NAMES.map((name, i) => entry(i + 1, 'Bus', {}, name)),
  lines: branches(false),
  transformers: branches(true),
  // As ANDES lists them: the PV generators, then the slack.
  generators: [
    ...generators.filter((g) => g.kind === 'PV'),
    ...generators.filter((g) => g.kind === 'Slack'),
  ],
  loads: LOAD_BUSES.map((bus, i) => entry(`PQ_${i + 1}`, 'PQ', { bus }, `PQ ${bus}`)),
  shunts: SHUNT_BUSES.map((bus, i) => entry(`Shunt_${i + 1}`, 'Shunt', { bus }, `Shunt ${bus}`)),
  controllers: [],
};
