/**
 * The licences of the packages the build bundles: which packages a bundle
 * holds, the text of each one's licence and NOTICE, and a build of a small app
 * with a web worker that writes them beside its `index.html`.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, resolveConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LICENSES_FILE,
  collectPackages,
  completeLicenses,
  packageDirOf,
  readPackage,
  renderLicenses,
  repositoryUrl,
  thirdPartyLicenses,
  type BundledPackage,
} from '../../../vite-plugins/thirdPartyLicenses';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tensa-licenses-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes `files` (paths relative to `root`) and returns `root`. */
function write(files: Record<string, string | object>): string {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const pkg = (over: Partial<BundledPackage> & { name: string }): BundledPackage => ({
  version: '1.0.0',
  license: 'MIT',
  ...over,
});

describe('repositoryUrl', () => {
  it('writes every form of one repository the same way', () => {
    for (const form of [
      'git+https://github.com/a/b.git',
      'https://github.com/a/b',
      'http://github.com/a/b/',
      'git://github.com/a/b.git',
      'git+ssh://git@github.com/a/b.git',
      'git@github.com:a/b.git',
      'github:a/b',
      'a/b',
      { type: 'git', url: 'git+https://github.com/a/b.git', directory: 'packages/c' },
    ]) {
      expect(repositoryUrl(form), JSON.stringify(form)).toBe('https://github.com/a/b');
    }
    expect(repositoryUrl('gitlab:a/b')).toBe('https://gitlab.com/a/b');
    expect(repositoryUrl(undefined)).toBeUndefined();
    expect(repositoryUrl({ type: 'git' })).toBeUndefined();
  });
});

describe('packageDirOf', () => {
  it('finds the package a module is a file of, past a package.json that names none', () => {
    write({
      'node_modules/a/package.json': { name: 'a', version: '2.0.0' },
      'node_modules/a/dist/esm/package.json': { type: 'module' },
      'node_modules/a/dist/esm/index.js': '',
    });
    const found = packageDirOf(path.join(root, 'node_modules/a/dist/esm/index.js?worker'));
    expect(found?.dir).toBe(path.join(root, 'node_modules/a'));
    expect(found?.data.version).toBe('2.0.0');
  });

  it('has none for the app, for a module a plugin made up, or above node_modules', () => {
    write({
      'package.json': { name: 'app', version: '0.1.0' },
      'src/main.js': '',
      'node_modules/stray.js': '',
    });
    expect(packageDirOf(path.join(root, 'src/main.js'))).toBeNull();
    expect(packageDirOf('\0vite/preload-helper.js')).toBeNull();
    // A file right in node_modules belongs to no package, and the app's
    // package.json above it is not taken for one.
    expect(packageDirOf(path.join(root, 'node_modules/stray.js'))).toBeNull();
  });
});

describe('collectPackages', () => {
  it('keeps one entry per name and version, and two versions apart', () => {
    write({
      'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
      'node_modules/a/x.js': '',
      'node_modules/a/y.js': '',
      'node_modules/b/node_modules/a/package.json': { name: 'a', version: '0.9.0', license: 'MIT' },
      'node_modules/b/node_modules/a/x.js': '',
    });
    const into = new Map<string, BundledPackage>();
    collectPackages(
      ['a/x.js', 'a/y.js', 'b/node_modules/a/x.js'].map((id) =>
        path.join(root, 'node_modules', id),
      ),
      into,
    );
    expect([...into.keys()].sort()).toEqual(['a@0.9.0', 'a@1.0.0']);
  });
});

describe('readPackage', () => {
  it('reads its licence, its source, its author and every licence and NOTICE file', () => {
    const dir = path.join(write({}), 'p');
    write({
      'p/LICENSE-APACHE': 'Apache text\r\n',
      'p/LICENSE-MIT': 'MIT text',
      'p/NOTICE.txt': 'Notice text\n\n',
      'p/licenses.json': '{}',
    });
    fs.mkdirSync(path.join(dir, 'license'));
    const read = readPackage(dir, {
      name: 'p',
      version: '3.1.0',
      license: '(MIT OR Apache-2.0)',
      repository: 'git+https://github.com/o/p.git',
      author: { name: 'Jo Doe', email: 'jo@example.com' },
    });
    expect(read).toMatchObject({
      name: 'p',
      version: '3.1.0',
      license: '(MIT OR Apache-2.0)',
      source: 'https://github.com/o/p',
      author: 'Jo Doe',
      licenseText: 'Apache text\n\nMIT text',
      noticeText: 'Notice text',
    });
  });

  it('reads a licence from the older list, and the home page for a source', () => {
    const dir = write({});
    const read = readPackage(dir, {
      name: 'q',
      licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
      homepage: 'https://example.com/q',
      author: 'Jo Doe <jo@example.com> (https://example.com)',
    });
    expect(read).toMatchObject({
      version: '0.0.0',
      license: 'MIT OR Apache-2.0',
      source: 'https://example.com/q',
      author: 'Jo Doe',
    });
    expect(read.licenseText).toBeUndefined();
    expect(read.noticeText).toBeUndefined();
  });
});

describe('completeLicenses', () => {
  const repo = 'https://github.com/o/mono';

  it('gives a package without a licence file the text of another version of it first', () => {
    const { packages, problems } = completeLicenses([
      pkg({ name: 'z', version: '1.0.0', repository: repo }),
      pkg({ name: 'a', repository: repo, licenseText: 'text of a' }),
      pkg({ name: 'z', version: '2.0.0', repository: repo, licenseText: 'text of z 2' }),
    ]);
    expect(problems).toEqual([]);
    const z1 = packages.find((p) => p.name === 'z' && p.version === '1.0.0')!;
    expect(z1.licenseText).toBe('text of z 2');
    expect(z1.textFrom).toContain('z 2.0.0');
  });

  it('then the text of another package of its repository under the same licence', () => {
    const { packages, problems } = completeLicenses([
      pkg({ name: 'b', repository: repo }),
      pkg({ name: 'a', repository: 'https://GitHub.com/o/mono', licenseText: 'text of a' }),
      pkg({ name: 'c', repository: repo, license: 'ISC', licenseText: 'ISC text of c' }),
    ]);
    expect(problems).toEqual([]);
    const b = packages.find((p) => p.name === 'b')!;
    expect(b.licenseText).toBe('text of a');
    expect(b.textFrom).toContain('a 1.0.0');
  });

  it('then, for MIT, the MIT License with the author as the holder of the copyright', () => {
    const { packages, problems } = completeLicenses([
      pkg({ name: 'm', author: 'Jo Doe', repository: 'https://github.com/jo/m' }),
      pkg({ name: 'n', repository: 'https://github.com/jo/n', licenseText: 'text of n' }),
    ]);
    expect(problems).toEqual([]);
    const m = packages.find((p) => p.name === 'm')!;
    expect(m.licenseText).toMatch(/^MIT License\n\nCopyright \(c\) Jo Doe\n\nPermission is hereby/);
    expect(m.licenseText).toContain('The above copyright notice and this permission notice');
    expect(m.textFrom).toContain('MIT License');
  });

  it('stops at a package whose licence or its text is not known, naming each', () => {
    const { packages, problems } = completeLicenses([
      pkg({ name: 'none', license: '' }),
      pkg({ name: 'apache', license: 'Apache-2.0', author: 'Jo Doe' }),
      pkg({ name: 'anonymous' }),
      pkg({ name: 'fine', licenseText: 'text' }),
    ]);
    expect(packages.map((p) => p.name)).toEqual(['fine']);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^anonymous 1\.0\.0 \(MIT\) is published without a licence file/);
    expect(problems[1]).toMatch(/^apache 1\.0\.0 \(Apache-2\.0\)/);
    expect(problems[2]).toBe('none 1.0.0 names no licence in its package.json.');
  });

  it('orders the packages by name, and the versions of one as numbers', () => {
    const { packages } = completeLicenses([
      pkg({ name: 'b', licenseText: 't' }),
      pkg({ name: 'a', version: '1.10.0', licenseText: 't' }),
      pkg({ name: 'a', version: '1.9.0', licenseText: 't' }),
      pkg({ name: '@s/c', licenseText: 't' }),
    ]);
    expect(packages.map((p) => `${p.name} ${p.version}`)).toEqual([
      '@s/c 1.0.0',
      'a 1.9.0',
      'a 1.10.0',
      'b 1.0.0',
    ]);
  });
});

describe('renderLicenses', () => {
  it('lists the packages, then gives each its licence, source, text and NOTICE', () => {
    const text = renderLicenses([
      { ...pkg({ name: 'a', source: 'https://github.com/o/a' }), licenseText: 'MIT text of a' },
      {
        ...pkg({ name: 'b', version: '2.0.0', license: 'Apache-2.0' }),
        licenseText: 'Apache text of b',
        noticeText: 'Notice of b',
        textFrom: 'the licence file of b 3.0.0, published from the same repository',
      },
    ]);
    expect(text).toContain('2 packages:\n  a 1.0.0 (MIT)\n  b 2.0.0 (Apache-2.0)\n');
    expect(text).toContain(
      'a 1.0.0\nLicence: MIT\nSource: https://github.com/o/a\n\nMIT text of a\n',
    );
    expect(text).toContain(
      'b 2.0.0\nLicence: Apache-2.0\nLicence text: the licence file of b 3.0.0, published from ' +
        'the same repository (this package has none)\n\nApache text of b\n\nNOTICE of b:\n\nNotice of b\n',
    );
    expect(text.endsWith('Notice of b\n')).toBe(true);
  });
});

/**
 * A small app: its own module, two packages, and a worker that imports a
 * third. Each package exports a function, which Rolldown cannot inline as it
 * would a constant (a module whose code is all inlined is in no chunk).
 */
function app(): string {
  return write({
    'package.json': { name: 'app', version: '0.1.0', private: true, type: 'module' },
    'index.html': '<!doctype html><script type="module" src="/main.js"></script>',
    'main.js': [
      "import { a } from 'pkg-a';",
      "import { c } from '@scope/c';",
      "const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
      'worker.postMessage(a() + c());',
    ].join('\n'),
    'worker.js': "import { b } from 'pkg-b';\nself.postMessage(b());",
    'node_modules/pkg-a/package.json': {
      name: 'pkg-a',
      version: '1.2.3',
      license: 'MIT',
      repository: 'o/pkg-a',
      main: 'index.js',
      type: 'module',
    },
    'node_modules/pkg-a/index.js': 'export const a = () => globalThis.location.href;',
    'node_modules/pkg-a/LICENSE': 'MIT License\n\nCopyright (c) A',
    'node_modules/pkg-b/package.json': {
      name: 'pkg-b',
      version: '4.5.6',
      license: 'Apache-2.0',
      main: 'index.js',
      type: 'module',
    },
    'node_modules/pkg-b/index.js': 'export const b = () => globalThis.navigator.language;',
    'node_modules/pkg-b/LICENSE.txt': 'Apache License, Version 2.0',
    'node_modules/pkg-b/NOTICE': 'pkg-b\nCopyright B',
    'node_modules/@scope/c/package.json': {
      name: '@scope/c',
      version: '0.0.1',
      license: 'MIT',
      author: 'Cee Author <cee@example.com>',
      exports: './dist/esm/index.js',
      type: 'module',
    },
    'node_modules/@scope/c/dist/esm/package.json': { type: 'module' },
    'node_modules/@scope/c/dist/esm/index.js': 'export const c = () => globalThis.name;',
    'node_modules/styles/package.json': { name: 'styles', version: '7.0.0', license: 'MIT' },
    'node_modules/styles/LICENSE': 'MIT License\n\nCopyright (c) Styles',
  });
}

async function buildApp(alsoBundled: string[] = []): Promise<string> {
  const licenses = thirdPartyLicenses({ alsoBundled });
  const outDir = path.join(root, 'dist');
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [licenses.plugin],
    worker: { format: 'es', plugins: () => [licenses.worker()] },
    build: { outDir, minify: false },
  });
  return fs.readFileSync(path.join(outDir, LICENSES_FILE), 'utf8');
}

describe('thirdPartyLicenses', () => {
  it('writes the licence of every package of the app and of its worker beside index.html', async () => {
    app();
    const text = await buildApp(['styles']);
    expect(text).toContain(
      '4 packages:\n  @scope/c 0.0.1 (MIT)\n  pkg-a 1.2.3 (MIT)\n  pkg-b 4.5.6 (Apache-2.0)\n' +
        '  styles 7.0.0 (MIT)\n',
    );
    expect(text).toContain(
      'Source: https://github.com/o/pkg-a\n\nMIT License\n\nCopyright (c) A\n',
    );
    // Only the worker imports pkg-b, and its NOTICE goes with it.
    expect(text).toContain(
      'Apache License, Version 2.0\n\nNOTICE of pkg-b:\n\npkg-b\nCopyright B\n',
    );
    expect(text).toContain('Copyright (c) Cee Author\n');
    expect(text).toContain('Copyright (c) Styles');
    expect(text).not.toMatch(/^app /m);
  });

  it('stops the build at a package whose licence text it cannot find', async () => {
    app();
    write({
      'node_modules/pkg-a/package.json': {
        name: 'pkg-a',
        version: '1.2.3',
        license: 'BSD-2-Clause',
        main: 'index.js',
        type: 'module',
      },
    });
    fs.rmSync(path.join(root, 'node_modules/pkg-a/LICENSE'));
    await expect(buildApp()).rejects.toThrow(/pkg-a 1\.2\.3 \(BSD-2-Clause\) is published without/);
  });

  it('stops the build at a package it is told is bundled and cannot find', async () => {
    app();
    await expect(buildApp(['missing'])).rejects.toThrow(/missing, which the build bundles/);
  });
});

describe('vite.config.ts', () => {
  const configFile = path.resolve(process.cwd(), 'vite.config.ts');

  it('writes the licences in a build, of the app and of its workers', async () => {
    const config = await resolveConfig({ configFile }, 'build');
    expect(config.plugins.map((plugin) => plugin.name)).toContain('tensa-third-party-licenses');
    const workers = await config.worker.plugins([]);
    expect(workers.plugins.map((plugin) => plugin.name)).toContain(
      'tensa-third-party-licenses-worker',
    );
  });
});
