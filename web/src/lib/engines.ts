/**
 * Engine names and what an engine can run.
 *
 * The server lists its engines at `GET /engines` (`useEngines`), each with
 * the routines it has. The session store keeps the engine of the live
 * session; these helpers are how the rest of the client reads the two
 * together. Today only `andes` is available, so nothing the user sees
 * changes; the gate in `useRunReadiness` is what a second engine is held
 * to.
 */
import type { DisturbanceSpec, EngineList } from '@/api/types';

/** The engine a session is created for when the user has not chosen one. */
export const DEFAULT_ENGINE = 'andes';

/**
 * The name shown for an engine: 'ANDES' for 'andes', 'Sienna' for 'sienna',
 * the name itself otherwise.
 */
export function engineLabel(name: string): string {
  switch (name) {
    case 'andes':
      return 'ANDES';
    case 'sienna':
      return 'Sienna';
    default:
      return name;
  }
}

/**
 * The routines of the engine `name` in `engines`, or null when the list is
 * not loaded or does not name it.
 */
export function engineRoutines(
  engines: EngineList | undefined,
  name: string | null,
): readonly string[] | null {
  if (engines === undefined || name === null) return null;
  const entry = engines.engines.find((e) => e.name === name);
  return entry === undefined ? null : entry.routines;
}

/** The load models a dynamic run can apply, in the order the server lists them. */
export type TdsLoadModel = 'impedance' | 'power' | 'as-case';

/**
 * Per-routine options of one engine, as `routine_options` carries them. The
 * generated entry type carries the block as an open record; this is the shape
 * the readers below read of it.
 */
export interface RoutineOptions {
  streaming?: boolean;
  abort?: boolean;
  disturbances?: readonly string[];
  options?: { load_model?: readonly TdsLoadModel[] };
}

/** The `routine_options` block of one engine entry, or null when it has none. */
function routineOptionsOf(
  engines: EngineList | null | undefined,
  name: string | null,
): Record<string, RoutineOptions> | null {
  if (engines === null || engines === undefined || name === null) return null;
  const entry = engines.engines.find((e) => e.name === name);
  if (entry === undefined) return null;
  const block = (entry as { routine_options?: Record<string, RoutineOptions> }).routine_options;
  return block === undefined || block === null ? null : block;
}

/**
 * The options of routine `routine` of the engine `name`, or null when the
 * engines list is not loaded, does not name the engine, or the engine lists
 * no `routine_options` for the routine. ANDES has no `tds` block: null means
 * the ANDES behaviour, and every consumer shows what it shows today.
 */
export function engineRoutineOptions(
  engines: EngineList | null | undefined,
  name: string | null,
  routine: 'tds' | 'eig',
): RoutineOptions | null {
  return routineOptionsOf(engines, name)?.[routine] ?? null;
}

/**
 * The disturbance kinds the engine accepts for `tds`, or null when unknown.
 * ANDES answers null, which means the client offers Fault, Toggle and Alter
 * as today.
 */
export function engineDisturbanceKinds(
  engines: EngineList | null | undefined,
  name: string | null,
): readonly string[] | null {
  return routineOptionsOf(engines, name)?.tds?.disturbances ?? null;
}

/**
 * The load models the engine takes for a dynamic run, or null when it takes
 * none (ANDES) or the list is not loaded. Null means: show no load model
 * control and send no load_model field.
 */
export function engineLoadModels(
  engines: EngineList | null | undefined,
  name: string | null,
): readonly TdsLoadModel[] | null {
  return routineOptionsOf(engines, name)?.tds?.options?.load_model ?? null;
}

/**
 * The spec kinds an engine's accepted disturbance list allows. Null (ANDES,
 * or a list not loaded) allows all three, as the disturbance form has always
 * offered. No engine capability names an alter, so a restricted list never
 * adds it.
 */
export function allowedSpecKinds(
  kinds: readonly string[] | null,
): ReadonlySet<DisturbanceSpec['kind']> {
  if (kinds === null) return new Set(['fault', 'toggle', 'alter']);
  const out = new Set<DisturbanceSpec['kind']>();
  if (kinds.includes('bus_fault')) out.add('fault');
  if (kinds.includes('branch_trip') || kinds.includes('gen_trip')) out.add('toggle');
  return out;
}

/**
 * The toggle target device kinds an engine's accepted disturbance list
 * allows: branches (a line trip) and generators (a generator trip). Null
 * (ANDES, or a list not loaded) answers null, which offers every model, as
 * the toggle form has always done.
 */
export function allowedToggleTargets(
  kinds: readonly string[] | null,
): ReadonlySet<'branch' | 'generator'> | null {
  if (kinds === null) return null;
  const out = new Set<'branch' | 'generator'>();
  if (kinds.includes('branch_trip')) out.add('branch');
  if (kinds.includes('gen_trip')) out.add('generator');
  return out;
}

/**
 * The versions of the engine's packages as one compact line
 * (`PowerSystems 5.12.5, PowerFlows 0.16.4`), or null when the engine
 * reports none (absent or empty map): nothing is shown for such an engine.
 * `julia` comes first, then the packages alphabetically; for ANDES the map
 * is just `andes`. The generated type carries `versions` as a required map;
 * the parameter also takes `undefined` so a reader of an older server
 * without the field reads it as none.
 */
export function engineVersionsLine(versions: Record<string, string> | undefined): string | null {
  if (versions === undefined) return null;
  const names = Object.keys(versions);
  if (names.length === 0) return null;
  names.sort((a, b) => {
    if (a === 'julia') return b === 'julia' ? 0 : -1;
    if (b === 'julia') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return names.map((pkg) => `${pkg} ${versions[pkg] ?? ''}`).join(', ');
}

/** A format `POST /sessions/{id}/save` can write a case file in. */
export type SaveFormat = 'xlsx' | 'json' | 'raw' | 'm';

/**
 * The order the Save system dialog lists the formats in: the native format
 * first, then the two exchange formats, then json.
 */
export const SAVE_FORMATS: readonly SaveFormat[] = ['xlsx', 'raw', 'm', 'json'];

/**
 * The formats every server has always written, answered whenever what the
 * engine can write is not known: the dialog must not come up empty because
 * a list has not arrived, and must not offer `m` to a server that may not
 * have it.
 */
const SAVE_FORMATS_ALWAYS: readonly SaveFormat[] = ['xlsx', 'raw', 'json'];

/** The save format a capability of `formats.write` names, where it names one. */
const SAVE_FORMAT_BY_CAPABILITY: Record<string, SaveFormat> = {
  xlsx: 'xlsx',
  json: 'json',
  'psse-raw': 'raw',
  matpower: 'm',
};

/**
 * The formats of `SAVE_FORMATS`, in that order, that the engine `name` lists
 * under `formats.write`. A capability name with no mapping is ignored. When
 * the list is not known yet, has no entry for the engine (which defaults to
 * `DEFAULT_ENGINE`), or the entry has no `formats.write` array, the answer
 * is the three formats every server has had. An engine that is listed and
 * writes nothing gives `[]`.
 */
export function engineSaveFormats(
  engines: EngineList | null | undefined,
  engine: string | null | undefined,
): readonly SaveFormat[] {
  if (engines === null || engines === undefined) return SAVE_FORMATS_ALWAYS;
  const name = engine ?? DEFAULT_ENGINE;
  const entry = engines.engines.find((e) => e.name === name);
  const write = entry?.formats?.write;
  if (entry === undefined || !Array.isArray(write)) return SAVE_FORMATS_ALWAYS;
  return SAVE_FORMATS.filter((format) =>
    write.some((capability) => SAVE_FORMAT_BY_CAPABILITY[capability] === format),
  );
}
