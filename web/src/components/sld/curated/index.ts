/**
 * Curated SLD layouts (Unit 8).
 *
 * Hand-authored layout sidecars for the wedge-demo cases (IEEE 14 + 39
 * for v0.1; 57 / 118 / 300 land later as content). On case load, the
 * canvas checks `curatedLayoutFor(basename)` first; a hit takes
 * precedence over auto-layout. User drags still override and persist
 * to the per-workspace sidecar via `PUT /workspace/layout`.
 *
 * Each curated JSON conforms to the `SidecarLayout` schema in
 * `web/src/api/types.ts` plus a `source_case` informational field that
 * the substrate ignores. The `last_modified` timestamps are pinned to
 * the original authoring date — do NOT regenerate them, or `git diff`
 * gets noisy on every build.
 */
import ieee14 from './ieee14.layout.json';
import ieee39 from './ieee39.layout.json';
import type { SidecarLayout } from '@/api/types';

/**
 * `source_case` is an optional informational field on curated layouts;
 * the substrate's `SidecarLayout` schema doesn't define it but JSON
 * additionalProperties are tolerated. Strip it before returning to the
 * runtime so the type stays canonical.
 */
function toSidecarLayout(raw: unknown): SidecarLayout {
  const r = raw as Record<string, unknown>;
  return {
    schema_version: String(r.schema_version),
    andes_version: String(r.andes_version),
    last_modified: String(r.last_modified),
    coordinates: r.coordinates as SidecarLayout['coordinates'],
  };
}

const CURATED: Readonly<Record<string, SidecarLayout>> = Object.freeze({
  ieee14: toSidecarLayout(ieee14),
  ieee39: toSidecarLayout(ieee39),
});

/** Strip the directory + extension off a workspace path. */
export function basenameWithoutExt(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? path;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/**
 * Look up a curated layout by case basename. Returns `null` when no
 * curated layout exists — caller falls through to sidecar then ELK.
 *
 * Matching is case-insensitive on the basename so `IEEE14.raw`,
 * `ieee14.raw`, and `Ieee14.RAW` all resolve to the same curated
 * layout. Empty string is treated as a miss.
 */
export function curatedLayoutFor(caseName: string): SidecarLayout | null {
  if (!caseName) return null;
  const key = basenameWithoutExt(caseName).toLowerCase();
  return CURATED[key] ?? null;
}

/** Internal: list the keys we ship curated layouts for (for tests). */
export function listCuratedKeys(): string[] {
  return Object.keys(CURATED);
}
