/**
 * Fails the build when the first load outgrows its limit.
 *
 * The first load is what every visit downloads and parses before the first
 * screen is drawn: the entry chunk and the chunks it imports statically. It
 * stays small by keeping what the first screen does not show out of it: the
 * diagram, the tables, the Inspector, the dialogs and the analysis panels are
 * separate chunks, loaded when they are first shown (`lazyNamed`). One static
 * import of such a part from a module on the first screen puts it back, and
 * nothing but a line in the build output says so. Vite's own warning for a
 * chunk over 500 kB does not stop a build, and the entry chunk went over it
 * twice unnoticed.
 *
 * The entry chunk alone is not the first load. Rolldown, which builds the app,
 * puts what the first screen shares with a lazily loaded part in a chunk of
 * its own, and that chunk is as much a part of the first load as the entry.
 * A chunk the configuration splits apart to keep it cached across releases
 * (React's) is left out of the count: the limit is on the app and the
 * libraries that come and go with it.
 *
 * So the limit is a build error. When it trips, move the part that grew behind
 * a dynamic import (see `src/lib/lazyNamed.ts` and its uses in `src/App.tsx`);
 * raising the limit is for when the first screen itself has grown.
 */
import type { Plugin } from 'vite';

/** The most the first load may weigh, minified and before compression, in kB (1000 bytes). */
export const ENTRY_CHUNK_LIMIT_KB = 500;

/** The part of a Rolldown output bundle the check reads. */
export interface BundlePart {
  type: 'chunk' | 'asset';
  fileName: string;
  /** The chunk's name before hashing (a code-splitting group's name, say). */
  name?: string;
  isEntry?: boolean;
  code?: string;
  /** The file names of the chunks it imports statically. */
  imports?: string[];
}

const kbOf = (part: BundlePart): number => new TextEncoder().encode(part.code ?? '').length / 1000;

/**
 * `entry` and every chunk it imports statically, at any depth: what a visit
 * loads before the entry runs. A dynamic import is not followed.
 */
export function firstLoad(bundle: Record<string, BundlePart>, entry: BundlePart): BundlePart[] {
  const byFile = new Map(Object.values(bundle).map((part) => [part.fileName, part]));
  const seen = new Set<string>();
  const loaded: BundlePart[] = [];
  const pending = [entry];
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    if (part.type !== 'chunk' || seen.has(part.fileName)) continue;
    seen.add(part.fileName);
    loaded.push(part);
    for (const file of part.imports ?? []) {
      const imported = byFile.get(file);
      if (imported !== undefined) pending.push(imported);
    }
  }
  return loaded;
}

/**
 * One message per entry chunk whose first load is over `limitKb`; none when
 * every one is within it. The chunks named in `apart` are not counted.
 */
export function entryChunkProblems(
  bundle: Record<string, BundlePart>,
  limitKb: number = ENTRY_CHUNK_LIMIT_KB,
  apart: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  for (const part of Object.values(bundle)) {
    if (part.type !== 'chunk' || part.isEntry !== true) continue;
    const counted = firstLoad(bundle, part).filter(
      (chunk) => chunk === part || chunk.name === undefined || !apart.includes(chunk.name),
    );
    const kb = counted.reduce((sum, chunk) => sum + kbOf(chunk), 0);
    if (kb > limitKb) {
      const largest = counted
        .map((chunk) => ({ fileName: chunk.fileName, kb: kbOf(chunk) }))
        .sort((a, b) => b.kb - a.kb)
        .slice(0, 3)
        .map((chunk) => `${chunk.fileName} ${chunk.kb.toFixed(2)} kB`)
        .join(', ');
      problems.push(
        `The first load of ${part.fileName} is ${kb.toFixed(2)} kB, over the limit of ${limitKb} kB ` +
          `(the largest of its ${counted.length} chunks: ${largest}). ` +
          'Something the first screen does not show is imported statically from a module that is on it: ' +
          'load it with lazyNamed (see src/App.tsx) so it becomes a chunk of its own.',
      );
    }
  }
  return problems;
}

export function entryChunkLimit(
  limitKb: number = ENTRY_CHUNK_LIMIT_KB,
  apart: readonly string[] = [],
): Plugin {
  return {
    name: 'tensa-entry-chunk-limit',
    apply: 'build',
    // Once the files are written, the code is what Vite's own size report
    // measures: its last steps (the preload lists) run after any earlier hook.
    writeBundle(_options, bundle) {
      const problems = entryChunkProblems(bundle, limitKb, apart);
      if (problems.length > 0) this.error(problems.join('\n'));
    },
  };
}
