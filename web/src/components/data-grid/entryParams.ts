/**
 * Reading a topology entry's params into a table's cells: as the text of a
 * reference or a name, or as a number. A param that is absent, or not a finite
 * number where one is asked for, is `null`, which a cell shows as a dash.
 */
import type { TopologyEntry } from '@/api/types';
import { finiteOrNull } from '@/lib/finite';

export function paramString(entry: TopologyEntry, key: string): string | null {
  const v = entry.params?.[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

export function paramNumber(entry: TopologyEntry, key: string): number | null {
  return finiteOrNull(entry.params?.[key]);
}
