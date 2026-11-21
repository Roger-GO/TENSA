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
