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
import type { EngineList } from '@/api/types';

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
