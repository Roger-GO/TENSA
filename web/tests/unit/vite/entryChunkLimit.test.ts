/**
 * The build's limit on the first load: a first load over it is a build error,
 * so it cannot grow past it without someone deciding that it should. And the
 * chunks the build splits off, which decide what the first load is.
 *
 * Runs in Node, not in jsdom: nothing here is drawn on a page, and the tests
 * of `vite.config.ts` resolve it as a build does, in Node.
 *
 * @vitest-environment node
 */
import path from 'node:path';
import { resolveConfig, type Plugin, type ResolvedConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_CHUNK_LIMIT_KB,
  entryChunkLimit,
  entryChunkProblems,
  firstLoad,
  type BundlePart,
} from '../../../vite-plugins/entryChunkLimit';

const chunk = (
  fileName: string,
  bytes: number,
  isEntry: boolean,
  more: Partial<BundlePart> = {},
): BundlePart => ({
  type: 'chunk',
  fileName,
  isEntry,
  code: 'x'.repeat(bytes),
  ...more,
});

describe('entryChunkProblems', () => {
  it('holds the limit at the size Vite itself warns from', () => {
    expect(ENTRY_CHUNK_LIMIT_KB).toBe(500);
  });

  it('accepts a first load at the limit', () => {
    expect(entryChunkProblems({ a: chunk('assets/index-abc.js', 500_000, true) })).toEqual([]);
  });

  it('refuses a first load over the limit, naming its entry, its size and the way out', () => {
    const problems = entryChunkProblems({ a: chunk('assets/index-abc.js', 500_001, true) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('The first load of assets/index-abc.js is 500.00 kB');
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

  it('counts the chunks the entry imports statically, at any depth', () => {
    const bundle: Record<string, BundlePart> = {
      entry: chunk('assets/index-abc.js', 200_000, true, { imports: ['assets/shared-abc.js'] }),
      shared: chunk('assets/shared-abc.js', 200_000, false, { imports: ['assets/deep-abc.js'] }),
      deep: chunk('assets/deep-abc.js', 100_001, false),
    };
    const problems = entryChunkProblems(bundle);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('The first load of assets/index-abc.js is 500.00 kB');
    // The largest chunks are named, so the one that grew is plain to see.
    expect(problems[0]).toContain(
      'the largest of its 3 chunks: assets/index-abc.js 200.00 kB, assets/shared-abc.js 200.00 kB, ' +
        'assets/deep-abc.js 100.00 kB',
    );
    expect(
      entryChunkProblems({ ...bundle, deep: chunk('assets/deep-abc.js', 100_000, false) }),
    ).toEqual([]);
  });

  it('counts a chunk imported twice, or in a cycle, once', () => {
    const bundle: Record<string, BundlePart> = {
      entry: chunk('assets/index-abc.js', 100_000, true, {
        imports: ['assets/a-abc.js', 'assets/b-abc.js'],
      }),
      a: chunk('assets/a-abc.js', 100_000, false, { imports: ['assets/c-abc.js'] }),
      b: chunk('assets/b-abc.js', 100_000, false, { imports: ['assets/c-abc.js'] }),
      c: chunk('assets/c-abc.js', 200_000, false, { imports: ['assets/a-abc.js'] }),
    };
    expect(
      firstLoad(bundle, bundle.entry!)
        .map((part) => part.fileName)
        .sort(),
    ).toEqual(['assets/a-abc.js', 'assets/b-abc.js', 'assets/c-abc.js', 'assets/index-abc.js']);
    expect(entryChunkProblems(bundle)).toEqual([]);
  });

  it('leaves out the chunks it is told are apart, and no others', () => {
    const bundle: Record<string, BundlePart> = {
      entry: chunk('assets/index-abc.js', 300_000, true, {
        imports: ['assets/vendor-react-abc.js', 'assets/shared-abc.js'],
      }),
      react: chunk('assets/vendor-react-abc.js', 400_000, false, { name: 'vendor-react' }),
      shared: chunk('assets/shared-abc.js', 200_000, false, { name: 'shared' }),
    };
    expect(entryChunkProblems(bundle, 500, ['vendor-react'])).toEqual([]);
    expect(entryChunkProblems(bundle, 500)).toHaveLength(1);
    expect(entryChunkProblems(bundle, 500, ['vendor-flow'])).toHaveLength(1);
    // What is apart is apart from the count, not from the walk: what it imports counts.
    const behindReact = {
      ...bundle,
      react: { ...bundle.react!, imports: ['assets/inner-abc.js'] },
      inner: chunk('assets/inner-abc.js', 1, false),
    };
    expect(entryChunkProblems(behindReact, 500, ['vendor-react'])).toHaveLength(1);
  });

  it('takes another limit', () => {
    const bundle = { a: chunk('assets/index-abc.js', 2_500, true) };
    expect(entryChunkProblems(bundle, 3)).toEqual([]);
    expect(entryChunkProblems(bundle, 2)).toHaveLength(1);
  });
});

/** Hands `bundle` to the plugin as Rolldown does once the files are written. */
function writeBundle(plugin: Plugin, bundle: Record<string, BundlePart>, errors: string[] = []) {
  const hook = plugin.writeBundle as unknown as (
    this: { error: (message: string) => never },
    options: unknown,
    bundle: Record<string, BundlePart>,
  ) => void;
  const context = {
    error: (message: string): never => {
      errors.push(message);
      throw new Error(message);
    },
  };
  hook.call(context, {}, bundle);
}

describe('entryChunkLimit', () => {
  it('stops the build with the problems it found, and lets a build within the limit through', () => {
    const plugin = entryChunkLimit(1, ['vendor-react']);
    const errors: string[] = [];
    expect(() =>
      writeBundle(plugin, { a: chunk('assets/index-abc.js', 1_001, true) }, errors),
    ).toThrow(/over the limit of 1 kB/);
    expect(errors).toHaveLength(1);
    expect(() =>
      writeBundle(plugin, { a: chunk('assets/index-abc.js', 999, true) }, errors),
    ).not.toThrow();
    expect(() =>
      writeBundle(plugin, {
        a: chunk('assets/index-abc.js', 999, true, { imports: ['assets/vendor-react-abc.js'] }),
        b: chunk('assets/vendor-react-abc.js', 5_000, false, { name: 'vendor-react' }),
      }),
    ).not.toThrow();
    expect(plugin.apply).toBe('build');
  });
});

interface Group {
  name: string;
  test?: RegExp | string | ((id: string) => boolean);
  priority?: number;
}

/** The code-splitting groups of the build. */
function groupsOf(config: ResolvedConfig): Group[] {
  const output = config.build.rolldownOptions.output;
  const options = Array.isArray(output) ? output[0] : output;
  const splitting = options?.codeSplitting;
  if (typeof splitting !== 'object') return [];
  return (splitting.groups ?? []) as Group[];
}

/** The group that takes a module matched by its test: of those that match, the first of the highest priority. */
function groupFor(groups: Group[], id: string): string | undefined {
  const matches = (group: Group) =>
    group.test === undefined
      ? false
      : typeof group.test === 'function'
        ? group.test(id)
        : typeof group.test === 'string'
          ? id.includes(group.test)
          : group.test.test(id);
  let best: Group | undefined;
  for (const group of groups) {
    if (!matches(group)) continue;
    if (best === undefined || (group.priority ?? 0) > (best.priority ?? 0)) best = group;
  }
  return best?.name;
}

/** A module of `pkg` where pnpm installs it, with the path separators of POSIX or of Windows. */
const moduleIn = (pkg: string, file: string, windows = false) => {
  const id = `/repo/web/node_modules/.pnpm/${pkg.replace('/', '+')}@1.0.0/node_modules/${pkg}/${file}`;
  return windows ? `C:${id.replaceAll('/', '\\')}` : id;
};

describe('vite.config.ts', () => {
  const configFile = path.resolve(process.cwd(), 'vite.config.ts');
  const resolved = () => resolveConfig({ configFile }, 'build');

  // Everything above, and a build of today's bundle, passes with the plugin
  // left out of the configuration, so this reads the plugins a build runs.
  it('holds the first load of a build to the limit, React apart', async () => {
    const config = await resolved();
    const wired = config.plugins.filter((plugin) => plugin.name === entryChunkLimit().name);
    expect(wired).toHaveLength(1);
    const plugin = wired[0]!;
    // The name of React's chunk is the name of the group that takes React.
    const react = groupFor(groupsOf(config), moduleIn('react', 'index.js'));
    expect(react).toBeDefined();
    const bundle = (sharedBytes: number): Record<string, BundlePart> => ({
      entry: chunk('assets/index-abc.js', 300_000, true, {
        imports: ['assets/react-abc.js', 'assets/shared-abc.js'],
      }),
      react: chunk('assets/react-abc.js', 200_000, false, { name: react! }),
      shared: chunk('assets/shared-abc.js', sharedBytes, false, { name: 'shared' }),
    });
    expect(() => writeBundle(plugin, bundle(200_001))).toThrow(/over the limit of 500 kB/);
    expect(() => writeBundle(plugin, bundle(200_000))).not.toThrow();
  });

  // Every group also takes the dependencies of the modules it matches. React
  // is a dependency of React Flow, so React's group must come first, or React
  // goes into React Flow's chunk and the first load fetches all of React Flow.
  it('splits React, React Flow and html-to-image each into a chunk of its own, React first', async () => {
    const groups = groupsOf(await resolved());
    for (const windows of [false, true]) {
      for (const [pkg, file] of [
        ['react', 'index.js'],
        ['react', 'cjs/react-jsx-runtime.production.js'],
        ['react-dom', 'client.js'],
        ['scheduler', 'index.js'],
      ] as const) {
        expect(groupFor(groups, moduleIn(pkg, file, windows)), `${pkg}/${file}`).toBe(
          'vendor-react',
        );
      }
      for (const [pkg, file] of [
        ['@xyflow/react', 'dist/esm/index.js'],
        ['@xyflow/system', 'dist/esm/index.js'],
        ['d3-zoom', 'src/zoom.js'],
        ['classcat', 'index.js'],
      ] as const) {
        expect(groupFor(groups, moduleIn(pkg, file, windows)), `${pkg}/${file}`).toBe(
          'vendor-flow',
        );
      }
      expect(groupFor(groups, moduleIn('html-to-image', 'es/index.js', windows))).toBe(
        'html-to-image',
      );
      // React Flow's stylesheet stays with the diagram's.
      expect(
        groupFor(groups, moduleIn('@xyflow/react', 'dist/style.css', windows)),
      ).toBeUndefined();
      // Nothing else is named: the rest is split by where it is used.
      expect(groupFor(groups, moduleIn('uplot', 'dist/uPlot.esm.js', windows))).toBeUndefined();
      expect(groupFor(groups, moduleIn('apache-arrow', 'Arrow.mjs', windows))).toBeUndefined();
    }
    const react = groups.find((group) => group.name === 'vendor-react')!;
    for (const other of groups.filter((group) => group !== react)) {
      expect(react.priority ?? 0, other.name).toBeGreaterThan(other.priority ?? 0);
    }
  });
});
