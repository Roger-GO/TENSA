/**
 * The build's entry chunk limit: an entry chunk over it is a build error, so
 * the first load cannot grow past it without someone deciding that it should.
 */
import { describe, expect, it } from 'vitest';
import {
  ENTRY_CHUNK_LIMIT_KB,
  entryChunkLimit,
  entryChunkProblems,
  type BundlePart,
} from '../../../vite-plugins/entryChunkLimit';

const chunk = (fileName: string, bytes: number, isEntry: boolean): BundlePart => ({
  type: 'chunk',
  fileName,
  isEntry,
  code: 'x'.repeat(bytes),
});

describe('entryChunkProblems', () => {
  it('holds the limit at the size Vite itself warns from', () => {
    expect(ENTRY_CHUNK_LIMIT_KB).toBe(500);
  });

  it('accepts an entry chunk at the limit', () => {
    expect(entryChunkProblems({ a: chunk('assets/index-abc.js', 500_000, true) })).toEqual([]);
  });

  it('refuses an entry chunk over the limit, naming it, its size and the way out', () => {
    const problems = entryChunkProblems({ a: chunk('assets/index-abc.js', 500_001, true) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('assets/index-abc.js is 500.00 kB');
    expect(problems[0]).toContain('over the limit of 500 kB');
    expect(problems[0]).toContain('lazyNamed');
  });

  it('measures bytes, not characters', () => {
    const part: BundlePart = {
      type: 'chunk',
      fileName: 'assets/index-abc.js',
      isEntry: true,
      code: 'é'.repeat(600),
    };
    expect(entryChunkProblems({ a: part }, 1)).toHaveLength(1);
    expect(entryChunkProblems({ a: { ...part, code: 'e'.repeat(600) } }, 1)).toEqual([]);
  });

  it('leaves the lazily loaded chunks and the assets alone, whatever their size', () => {
    const bundle: Record<string, BundlePart> = {
      lazy: chunk('assets/SldCanvas-abc.js', 900_000, false),
      worker: { type: 'asset', fileName: 'assets/elk-worker.min-abc.js' },
      entry: chunk('assets/index-abc.js', 100_000, true),
    };
    expect(entryChunkProblems(bundle)).toEqual([]);
  });

  it('takes another limit', () => {
    const bundle = { a: chunk('assets/index-abc.js', 2_500, true) };
    expect(entryChunkProblems(bundle, 3)).toEqual([]);
    expect(entryChunkProblems(bundle, 2)).toHaveLength(1);
  });
});

describe('entryChunkLimit', () => {
  it('stops the build with the problems it found, and lets a build within the limit through', () => {
    const plugin = entryChunkLimit(1);
    const writeBundle = plugin.writeBundle as unknown as (
      this: { error: (message: string) => never },
      options: unknown,
      bundle: Record<string, BundlePart>,
    ) => void;
    const errors: string[] = [];
    const context = {
      error: (message: string): never => {
        errors.push(message);
        throw new Error(message);
      },
    };
    expect(() =>
      writeBundle.call(context, {}, { a: chunk('assets/index-abc.js', 1_001, true) }),
    ).toThrow(/over the limit of 1 kB/);
    expect(errors).toHaveLength(1);
    expect(() =>
      writeBundle.call(context, {}, { a: chunk('assets/index-abc.js', 999, true) }),
    ).not.toThrow();
    expect(plugin.apply).toBe('build');
  });
});
