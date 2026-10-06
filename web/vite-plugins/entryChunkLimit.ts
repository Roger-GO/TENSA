/**
 * Fails the build when the entry chunk outgrows its limit.
 *
 * The entry chunk is what every visit downloads and parses before the first
 * screen is drawn. It stays small by keeping what the first screen does not
 * show out of it: the diagram, the tables, the Inspector, the dialogs and the
 * analysis panels are separate chunks, loaded when they are first shown
 * (`lazyNamed`). One static import of such a part from a module on the first
 * screen puts it back, and nothing but a line in the build output says so.
 * Vite's own warning for a chunk over 500 kB does not stop a build, and the
 * entry chunk went over it twice unnoticed.
 *
 * So the limit is a build error. When it trips, move the part that grew behind
 * a dynamic import (see `src/lib/lazyNamed.ts` and its uses in `src/App.tsx`);
 * raising the limit is for when the first screen itself has grown.
 */
import type { Plugin } from 'vite';

/** The most the entry chunk may weigh, minified and before compression, in kB (1000 bytes). */
export const ENTRY_CHUNK_LIMIT_KB = 500;

/** The part of a Rollup output bundle the check reads. */
export interface BundlePart {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry?: boolean;
  code?: string;
}

/** One message per entry chunk over `limitKb`; none when every one is within it. */
export function entryChunkProblems(
  bundle: Record<string, BundlePart>,
  limitKb: number = ENTRY_CHUNK_LIMIT_KB,
): string[] {
  const problems: string[] = [];
  for (const part of Object.values(bundle)) {
    if (part.type !== 'chunk' || part.isEntry !== true) continue;
    const kb = new TextEncoder().encode(part.code ?? '').length / 1000;
    if (kb > limitKb) {
      problems.push(
        `The entry chunk ${part.fileName} is ${kb.toFixed(2)} kB, over the limit of ${limitKb} kB. ` +
          'Something the first screen does not show is imported statically from a module that is on it: ' +
          'load it with lazyNamed (see src/App.tsx) so it becomes a chunk of its own.',
      );
    }
  }
  return problems;
}

export function entryChunkLimit(limitKb: number = ENTRY_CHUNK_LIMIT_KB): Plugin {
  return {
    name: 'tensa-entry-chunk-limit',
    apply: 'build',
    // Once the files are written, the code is what Vite's own size report
    // measures: its last steps (the preload lists) run after any earlier hook.
    writeBundle(_options, bundle) {
      const problems = entryChunkProblems(bundle, limitKb);
      if (problems.length > 0) this.error(problems.join('\n'));
    },
  };
}
