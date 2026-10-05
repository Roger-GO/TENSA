/**
 * Guards the code splitting of the production bundle.
 *
 * The entry chunk is whatever `src/main.tsx` reaches through static imports;
 * a module reached only through `import()` becomes a chunk of its own, fetched
 * when it is first used. One stray static import of a lazily loaded module
 * (or of a heavy package such as `apache-arrow` from code that loads eagerly)
 * pulls the whole thing back into the first load and nothing fails, so this
 * test walks the import graph the way the bundler does and pins the split.
 *
 * What is lazy, and why it is safe to load late, is documented where each
 * `lazyNamed(...)` call sits (and in `RunStream.ts` for the Arrow decoder).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from ``web/``, where ``src/`` is.
const SRC = path.resolve(process.cwd(), 'src');
const ENTRY = path.join(SRC, 'main.tsx');

/** `import x from 'm'`, `import 'm'`, `export * from 'm'`; not `import type`. */
const STATIC_IMPORT =
  /(?:^|\n)[ \t]*(?:import|export)[ \t]+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveSource(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

interface Reach {
  files: Set<string>;
  packages: Set<string>;
}

/** Every source file and npm package reachable from the entry. */
function reachableFromEntry(includeDynamic: boolean): Reach {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(STATIC_IMPORT)].map((m) => m[1]!);
    if (includeDynamic) specifiers.push(...[...text.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]!));
    for (const specifier of specifiers) {
      const resolved = resolveSource(file, specifier);
      if (resolved !== null) queue.push(resolved);
      else if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
        packages.add(packageName(specifier.split('?')[0]!));
      }
    }
  }
  return { files, packages };
}

/** Modules that must stay out of the entry chunk. */
const LAZY_MODULES = [
  'components/data-grid/AnalysisTab.tsx',
  'components/data-grid/DataGrid.tsx',
  'components/data-grid/BusesGrid.tsx',
  'components/data-grid/LinesGrid.tsx',
  'components/data-grid/GeneratorsGrid.tsx',
  'components/data-grid/LoadsGrid.tsx',
  'components/data-grid/ShuntsGrid.tsx',
  'components/analyze/AnalyzePanel.tsx',
  'components/pflow/PflowPanel.tsx',
  'components/pflow/PflowComparePanel.tsx',
  'lib/pflowCompare.ts',
  'lib/resultsArchive.ts',
  'components/plots/TimeSeriesPlot.tsx',
  'components/plots/ResponseMetricsPanel.tsx',
  'components/sld/SldCanvas.tsx',
  'components/snapshot/SaveSnapshotDialog.tsx',
  'components/snapshot/LoadSnapshotDialog.tsx',
  'components/bundle/BundleExportDialog.tsx',
  'components/bundle/BundleImportDialogBody.tsx',
  'components/reports/ReportDialog.tsx',
  'components/history/HistoryDrawer.tsx',
  'components/sweep/SweepDialog.tsx',
  'components/pmu/PmuPlacementDialog.tsx',
  'components/profiles/ProfileImportDialog.tsx',
  'components/shell/CommandPalette.tsx',
  'components/shell/ShortcutCheatsheet.tsx',
  'streaming/arrow.ts',
];

/** Heavy packages whose only importers are lazy modules. */
const LAZY_PACKAGES = [
  'apache-arrow',
  'uplot',
  'html-to-image',
  'cmdk',
  '@xyflow/react',
  'elkjs',
  'react-window',
];

describe('code splitting', () => {
  const eager = reachableFromEntry(false);
  const all = reachableFromEntry(true);
  const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
  const eagerFiles = new Set([...eager.files].map(rel));
  const allFiles = new Set([...all.files].map(rel));

  it('walks a real graph (the entry reaches the app shell and the lazy modules)', () => {
    expect(eagerFiles.has('App.tsx')).toBe(true);
    expect(eagerFiles.has('components/shell/AppShell.tsx')).toBe(true);
    expect(eager.packages.has('react')).toBe(true);
    for (const module of LAZY_MODULES) {
      expect(allFiles.has(module), `${module} is no longer imported anywhere`).toBe(true);
    }
    for (const pkg of LAZY_PACKAGES) {
      expect(all.packages.has(pkg), `${pkg} is no longer imported anywhere`).toBe(true);
    }
  });

  it.each(LAZY_MODULES)('keeps %s out of the entry chunk', (module) => {
    expect(
      eagerFiles.has(module),
      `${module} is statically imported from the entry; load it with lazyNamed(() => import(...))`,
    ).toBe(false);
  });

  it.each(LAZY_PACKAGES)('keeps the %s package out of the entry chunk', (pkg) => {
    expect(
      eager.packages.has(pkg),
      `${pkg} is statically imported from code that loads eagerly`,
    ).toBe(false);
  });
});
