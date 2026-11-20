/**
 * Writes the licences of the packages the build bundles into the UI.
 *
 * The UI ships minified, and the copyright and licence comments of the
 * libraries it is built from (React, Radix, React Flow, uPlot, d3, Apache
 * Arrow, elkjs and the rest) do not survive in its scripts. Each of those
 * licences asks for its notice to go with every copy, so the build writes them
 * into one file beside `index.html`, `THIRD-PARTY-LICENSES.txt`: for each
 * package whose code is in a script of the build, its name, version, licence
 * and source, the text of the licence file it is published with, and the text
 * of its NOTICE file, which the Apache License asks to be passed on as well.
 * The Python package carries the file with the UI (`scripts/check_dist.py`
 * refuses a distribution without it), and the server serves it with the UI.
 *
 * Vite's own `build.license` is not used: it leaves out the NOTICE files,
 * lists a package that is published without a licence file with no text at
 * all (several of the Radix packages bundled here are), and does not look at
 * the bundles of the web workers, where elkjs runs.
 *
 * A package published without a licence file takes the text of a package
 * bundled from the same repository under the same licence (another version of
 * it, or another package of its monorepo). Failing that, an MIT package gets
 * the standard text of the MIT License, with the author its `package.json`
 * names as the holder of the copyright. A package that names no licence, or
 * whose text cannot be found that way, stops the build: what to write for it
 * is for a person to decide.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** The file the build writes, at the top of its output directory. */
export const LICENSES_FILE = 'THIRD-PARTY-LICENSES.txt';

const PLUGIN_NAME = 'tensa-third-party-licenses';

// The names of the files a package publishes its licence and its notice in:
// `LICENSE`, `LICENSE.md`, `license.txt`, `LICENSE-MIT`, `LICENCE`, `COPYING`.
const LICENSE_FILE = /^(licen[cs]e|copying)([.-]|$)/i;
const NOTICE_FILE = /^notice([.-]|$)/i;

/** A package whose code is in the bundle, as it was published. */
export interface BundledPackage {
  name: string;
  version: string;
  /** The SPDX expression of its `package.json`; empty when it names none. */
  license: string;
  /** Where its source is: the repository, else the home page, of its `package.json`. */
  source?: string;
  /** The repository, written one way whatever way the `package.json` wrote it. */
  repository?: string;
  /** The author its `package.json` names, without an email address or a URL. */
  author?: string;
  /** The text of each licence file it is published with, one after the other. */
  licenseText?: string;
  noticeText?: string;
}

/** A package with the text of its licence, and where that text came from when not from it. */
export interface LicensedPackage extends BundledPackage {
  licenseText: string;
  /** Said when the package is published without a licence file. */
  textFrom?: string;
}

/** The part of a Rolldown output bundle the plugin reads. */
export interface BundlePart {
  type: 'chunk' | 'asset';
  moduleIds?: readonly string[];
}

const readText = (file: string): string =>
  fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();

/** The files of `dir` whose names `pattern` matches, in the order of their names. */
function filesMatching(dir: string, pattern: RegExp): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * `git+https://github.com/a/b.git`, `git://github.com/a/b`, `github:a/b` and
 * `a/b` are one repository, `https://github.com/a/b`.
 */
export function repositoryUrl(repository: unknown): string | undefined {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && 'url' in repository
        ? repository.url
        : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let url = raw.trim();
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (shorthand !== null) {
    const host = shorthand[1] === 'bitbucket' ? 'bitbucket.org' : `${shorthand[1] ?? 'github'}.com`;
    url = `https://${host}/${shorthand[2]}`;
  }
  return url
    .replace(/^git\+/, '')
    .replace(/^(?:git|ssh):\/\/(?:git@)?/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^http:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** The name of a `package.json` author, given as `Name <email> (url)` or as `{ name }`. */
function authorName(author: unknown): string | undefined {
  const raw =
    typeof author === 'string'
      ? author
      : typeof author === 'object' && author !== null && 'name' in author
        ? author.name
        : undefined;
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/<[^>]*>|\([^)]*\)/g, '').trim();
  return name === '' ? undefined : name;
}

/** The licence a `package.json` names, in its `license` or in the older `licenses` list. */
function licenseOf(data: Record<string, unknown>): string {
  const typeOf = (value: unknown): string | undefined =>
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && 'type' in value
        ? String(value.type)
        : undefined;
  const named = typeOf(data.license);
  if (named !== undefined) return named.trim();
  if (Array.isArray(data.licenses)) {
    return data.licenses
      .map(typeOf)
      .filter((type): type is string => type !== undefined)
      .join(' OR ');
  }
  return '';
}

/** The package published in `dir`, as its `package.json` and its files say. */
export function readPackage(dir: string, data: Record<string, unknown>): BundledPackage {
  const repository = repositoryUrl(data.repository);
  const homepage = typeof data.homepage === 'string' ? data.homepage : undefined;
  const licenses = filesMatching(dir, LICENSE_FILE).map(readText);
  const notices = filesMatching(dir, NOTICE_FILE).map(readText);
  return {
    name: String(data.name),
    version: typeof data.version === 'string' ? data.version : '0.0.0',
    license: licenseOf(data),
    source: repository ?? homepage,
    repository,
    author: authorName(data.author),
    licenseText: licenses.length > 0 ? licenses.join('\n\n') : undefined,
    noticeText: notices.length > 0 ? notices.join('\n\n') : undefined,
  };
}

/** The `package.json` data of the package a directory belongs to, by directory. */
export type PackageCache = Map<string, { dir: string; data: Record<string, unknown> } | null>;

/**
 * The package `moduleId` is a file of: the nearest `package.json` above it
 * that names a package. A `package.json` that names none (`{"type":
 * "module"}` in a folder of a package's build) is passed over. A module
 * outside `node_modules`, or one a plugin made up (`\0...`), has none.
 */
export function packageDirOf(
  moduleId: string,
  cache: PackageCache = new Map(),
): { dir: string; data: Record<string, unknown> } | null {
  const file = moduleId.replace(/[?#].*$/s, '');
  if (file.startsWith('\0') || !/[\\/]node_modules[\\/]/.test(file)) return null;
  const visited: string[] = [];
  let found: { dir: string; data: Record<string, unknown> } | null = null;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const known = cache.get(dir);
    if (known !== undefined) {
      found = known;
      break;
    }
    visited.push(dir);
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      if (typeof data.name === 'string' && data.name !== '') {
        found = { dir, data };
        break;
      }
    }
    if (path.basename(dir) === 'node_modules' || path.dirname(dir) === dir) break;
  }
  for (const dir of visited) cache.set(dir, found);
  return found;
}

/** Adds the package of every module of `ids` to `into`, once per name and version. */
export function collectPackages(
  ids: Iterable<string>,
  into: Map<string, BundledPackage>,
  cache: PackageCache = new Map(),
): void {
  for (const id of ids) {
    const found = packageDirOf(id, cache);
    if (found === null) continue;
    const key = `${String(found.data.name)}@${String(found.data.version)}`;
    if (!into.has(key)) into.set(key, readPackage(found.dir, found.data));
  }
}

const MIT_TEXT = `\
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const byNameAndVersion = (a: BundledPackage, b: BundledPackage): number =>
  a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en', { numeric: true });

/**
 * Every package with the text of its licence, in the order of their names and
 * versions, and one problem for each package the text of whose licence is not
 * known (none when every one has it).
 */
export function completeLicenses(packages: Iterable<BundledPackage>): {
  packages: LicensedPackage[];
  problems: string[];
} {
  const sorted = [...packages].sort(byNameAndVersion);
  const licensed: LicensedPackage[] = [];
  const problems: string[] = [];
  for (const pkg of sorted) {
    const id = `${pkg.name} ${pkg.version}`;
    if (pkg.license === '') {
      problems.push(`${id} names no licence in its package.json.`);
      continue;
    }
    if (pkg.licenseText !== undefined) {
      licensed.push({ ...pkg, licenseText: pkg.licenseText });
      continue;
    }
    // Another version of the package first, then any package of the repository.
    const siblings = sorted.filter(
      (other) =>
        other.licenseText !== undefined &&
        other.license === pkg.license &&
        other.repository !== undefined &&
        other.repository.toLowerCase() === pkg.repository?.toLowerCase(),
    );
    const sibling = siblings.find((other) => other.name === pkg.name) ?? siblings[0];
    if (sibling?.licenseText !== undefined) {
      licensed.push({
        ...pkg,
        licenseText: sibling.licenseText,
        textFrom: `the licence file of ${sibling.name} ${sibling.version}, published from the same repository`,
      });
    } else if (pkg.license === 'MIT' && pkg.author !== undefined) {
      licensed.push({
        ...pkg,
        licenseText: `MIT License\n\nCopyright (c) ${pkg.author}\n\n${MIT_TEXT}`,
        textFrom: 'the text of the MIT License, with the author its package.json names',
      });
    } else {
      problems.push(
        `${id} (${pkg.license}) is published without a licence file, and no package bundled ` +
          'from its repository has one. Find the text of its licence and write it into ' +
          'vite-plugins/thirdPartyLicenses.ts.',
      );
    }
  }
  return { packages: licensed, problems };
}

const RULE = '='.repeat(80);

/** The text of `THIRD-PARTY-LICENSES.txt`. */
export function renderLicenses(packages: readonly LicensedPackage[]): string {
  const lines = [
    'Third-party software in the TENSA web UI',
    '',
    'The scripts and stylesheets of the TENSA web UI hold the code of the packages',
    'below, each under its own licence. For each package this file gives its',
    'version, its licence and where its source is, then the text of the licence it',
    'is published with and, when it has one, its NOTICE file. TENSA itself is under',
    'GPL-3.0-or-later; its LICENSE file is in the TENSA package.',
    '',
    `${packages.length} packages:`,
    ...packages.map((pkg) => `  ${pkg.name} ${pkg.version} (${pkg.license})`),
  ];
  for (const pkg of packages) {
    lines.push('', RULE, `${pkg.name} ${pkg.version}`, `Licence: ${pkg.license}`);
    if (pkg.source !== undefined) lines.push(`Source: ${pkg.source}`);
    if (pkg.textFrom !== undefined) {
      lines.push(`Licence text: ${pkg.textFrom} (this package has none)`);
    }
    lines.push('', pkg.licenseText);
    if (pkg.noticeText !== undefined) lines.push('', `NOTICE of ${pkg.name}:`, '', pkg.noticeText);
  }
  return `${lines.join('\n')}\n`;
}

/** The packages of the modules of every chunk of `bundle`. */
function collectBundle(
  bundle: Record<string, BundlePart>,
  into: Map<string, BundledPackage>,
  cache: PackageCache,
): void {
  for (const part of Object.values(bundle)) {
    if (part.type === 'chunk') collectPackages(part.moduleIds ?? [], into, cache);
  }
}

/**
 * The plugin of the build, and one for the bundle of each web worker (Vite
 * builds a worker apart, with the plugins of `worker.plugins`). The workers
 * are bundled while the app's modules are transformed, so what they hold is
 * known when the app's bundle is written.
 *
 * `alsoBundled` names packages whose files go into the output other than as
 * modules of a chunk: Tailwind's base styles are written into the app's
 * stylesheet by its own plugin. They are found in `node_modules` of the root.
 */
export function thirdPartyLicenses(options: { alsoBundled?: readonly string[] } = {}): {
  plugin: Plugin;
  worker: () => Plugin;
} {
  const cache: PackageCache = new Map();
  // What the workers hold. It is not emptied when a build starts: Vite keeps
  // a worker's bundle across the rebuilds of `vite build --watch` and does not
  // bundle it again, and a package listed once too often does no harm.
  const inWorkers = new Map<string, BundledPackage>();
  let root = process.cwd();

  const plugin: Plugin = {
    name: PLUGIN_NAME,
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const packages = new Map(inWorkers);
      collectBundle(bundle, packages, cache);
      for (const name of options.alsoBundled ?? []) {
        const dir = path.join(root, 'node_modules', name);
        const manifest = path.join(dir, 'package.json');
        if (!fs.existsSync(manifest)) {
          this.error(`${name}, which the build bundles, is not installed in ${root}/node_modules.`);
        }
        const data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
        const pkg = readPackage(fs.realpathSync(dir), data);
        packages.set(`${pkg.name}@${pkg.version}`, pkg);
      }
      const done = completeLicenses(packages.values());
      if (done.problems.length > 0) this.error(done.problems.join('\n'));
      this.emitFile({
        type: 'asset',
        fileName: LICENSES_FILE,
        source: renderLicenses(done.packages),
      });
    },
  };

  const worker = (): Plugin => ({
    name: `${PLUGIN_NAME}-worker`,
    apply: 'build',
    generateBundle(_options, bundle) {
      collectBundle(bundle, inWorkers, cache);
    },
  });

  return { plugin, worker };
}
