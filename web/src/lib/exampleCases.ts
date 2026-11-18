/**
 * What the Example cases dialog reads off a catalog entry, as pure functions: the file a
 * case opens as, how to describe its size and analyses, what the dialog says of the
 * workspace, what its citations copy as, and whether it matches the words typed in the filter.
 */
import type { ExampleListEntry } from '@/api/types';
import { baseName } from '@/lib/paths';

type Analysis = NonNullable<ExampleListEntry['analyses']>[number];

/** What each analysis a case supports is called in the UI (the Run menu's words). */
export const ANALYSIS_LABELS: Record<Analysis, string> = {
  pf: 'Power flow',
  tds: 'Time domain',
  eig: 'Eigenvalues',
};

/** The two groups of the dialog, in the order they are shown. */
export const CASE_CATEGORIES: readonly {
  value: ExampleListEntry['category'];
  heading: string;
  blurb: string;
}[] = [
  {
    value: 'dynamic',
    heading: 'Dynamic cases',
    blurb: 'With machine models: power flow, time-domain simulation and eigenvalues.',
  },
  {
    value: 'steady-state',
    heading: 'Steady-state cases',
    blurb: 'A network and its loading only: power flow.',
  },
];

/** True for an entry that is only links to data TENSA does not hold. */
export function isLinkOnly(example: ExampleListEntry): boolean {
  return example.provenance.kind === 'external';
}

/**
 * The group of the entries that are only links, shown after the two of the cases: they have
 * a category (a dynamic dataset, a steady-state library) but nothing to add or open, so under
 * "Dynamic cases" they would promise machine models TENSA does not give.
 */
export const LINK_ONLY_GROUP = {
  value: 'links',
  heading: 'Data to get elsewhere',
  blurb:
    'TENSA holds no file of these. Each card links to the data, gives its terms, and says what happened when TENSA was tried on it.',
} as const;

/** The cases of a category that have a file: what its group holds. */
export function casesOfCategory(
  examples: readonly ExampleListEntry[],
  category: ExampleListEntry['category'],
): ExampleListEntry[] {
  return examples.filter((example) => example.category === category && !isLinkOnly(example));
}

/**
 * What the count beside the filter says: how many of the entries match what is typed, or,
 * with nothing typed, how many cases there are and how many entries are only links.
 */
export function countText(
  examples: readonly ExampleListEntry[],
  shown: number,
  filtering: boolean,
): string {
  if (filtering) return `${shown} of ${examples.length}`;
  const links = examples.filter(isLinkOnly).length;
  const cases = examples.length - links;
  const text = `${cases} ${cases === 1 ? 'case' : 'cases'}`;
  return links === 0 ? text : `${text}, ${links} ${links === 1 ? 'link' : 'links'}`;
}

/** The file name the case takes in the workspace, which is the file that is opened. */
export function primaryFileName(example: ExampleListEntry): string | null {
  const path = example.provenance.path;
  return path === null || path === undefined ? null : baseName(path);
}

/** The files a case is opened together with (a `.dyr` beside a `.raw`), by name. */
export function companionFileNames(example: ExampleListEntry): string[] {
  return (example.extra_files ?? []).map((file) => baseName(file.path));
}

/** "14 buses, 5 generators", or `null` for an entry with no size (a link). */
export function sizeText(example: ExampleListEntry): string | null {
  const size = example.size;
  if (size === null || size === undefined) return null;
  const buses = `${size.buses} ${size.buses === 1 ? 'bus' : 'buses'}`;
  const generators = `${size.generators} ${size.generators === 1 ? 'generator' : 'generators'}`;
  return `${buses}, ${generators}`;
}

/**
 * True for a case whose file is in the workspace but is not the one this TENSA ships under
 * that name: an earlier release put another there, or it was edited. Only a bundled case
 * can be (the server says so), and its card offers to replace the file.
 */
export function differsFromShipped(example: ExampleListEntry): boolean {
  return example.in_workspace && example.differs;
}

/** What a card says under its buttons when its file in the workspace is not the shipped one. */
export function differsNote(example: ExampleListEntry): string {
  const file = primaryFileName(example) ?? 'The file';
  return `The ${file} in your workspace is not the file this version of TENSA ships for this case: an earlier TENSA put another file under that name, or the file was edited. Open loads your file as it is. Replace with this version overwrites it with the one described here.`;
}

/**
 * What the dialog says about the workspace under the filter, from how many of the cases that
 * have a file are in it already, or `null` when none has a file. A new workspace starts with
 * the default set, so a first-time user finds cards that say Added before anything was added:
 * this says why, what to press, and (when every case is there) how a case offers Add again.
 * A case whose file there is not the shipped one does not say Added: its card says so and
 * offers to replace the file, and this says how many.
 */
export function workspaceNote(examples: readonly ExampleListEntry[]): string | null {
  const withFile = examples.filter((example) => !isLinkOnly(example));
  if (withFile.length === 0) return null;
  const total = withFile.length;
  const differing = withFile.filter(differsFromShipped).length;
  const added = withFile.filter((example) => example.in_workspace).length - differing;
  const single = total === 1;
  const starts = '(a new workspace starts with the default set)';
  if (added === 0 && differing === 0) {
    return single
      ? 'This case is not in your workspace yet. Add to workspace copies its file there, and Open then loads it.'
      : 'None of these cases is in your workspace yet. Add to workspace copies the file of a case there, and Open then loads it.';
  }
  const differ =
    differing === 0
      ? ''
      : `${single ? 'This case holds' : differing === 1 ? 'One case holds' : `${differing} cases hold`} a file that is not the one this version of TENSA ships (an earlier TENSA put another under that name, or it was edited). ${differing === 1 ? 'Its card says' : 'Their cards say'} so and offer${differing === 1 ? 's' : ''} Replace with this version; Open loads the file as it is.`;
  if (added === 0) return differ;
  if (added < total) {
    const one = added === 1;
    const rest = `${added} of ${total} cases ${one ? 'is' : 'are'} already in your workspace and ${one ? 'says' : 'say'} Added ${starts}. Add to workspace copies the file of another one there; Open loads a case.`;
    return differ === '' ? rest : `${rest} ${differ}`;
  }
  return single
    ? `This case is already in your workspace and says Added ${starts}, so there is nothing to add: choose Open to load it. If its file is deleted from the workspace folder, the card offers Add to workspace again.`
    : `All ${total} cases are already in your workspace and say Added ${starts}, so there is nothing to add: choose Open to load one. A case whose file is deleted from the workspace folder offers Add to workspace again.`;
}

/** The citations of a case as text to copy: plain, or BibTeX, one block after the other. */
export function citationsText(example: ExampleListEntry, format: 'text' | 'bibtex'): string {
  return (example.citations ?? [])
    .map((c) => (format === 'bibtex' ? c.bibtex : c.text).trim())
    .join('\n\n');
}

/**
 * True for an address a link may go to: `http` or `https`. The catalog allows nothing
 * else, and a card draws a link only for what passes, so an address that came otherwise
 * (`javascript:`, `data:`) is shown as text.
 */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The host of a URL (`github.com`), or the text itself when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** True when every word of `query` is found in the case's name, id, summary, tags or analyses. */
export function matchesFilter(example: ExampleListEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    example.title,
    example.id,
    example.summary,
    ...(example.tags ?? []),
    ...(example.analyses ?? []).map((a) => ANALYSIS_LABELS[a]),
    sizeText(example) ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
