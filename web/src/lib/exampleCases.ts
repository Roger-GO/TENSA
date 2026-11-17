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
 * What the dialog says about the workspace under the filter, from how many of the cases that
 * have a file are in it already, or `null` when none has a file. A new workspace starts with
 * the default set, so a first-time user finds cards that say Added before anything was added:
 * this says why, what to press, and (when every case is there) how a case offers Add again.
 */
export function workspaceNote(examples: readonly ExampleListEntry[]): string | null {
  const withFile = examples.filter((example) => !isLinkOnly(example));
  if (withFile.length === 0) return null;
  const inWorkspace = withFile.filter((example) => example.in_workspace).length;
  const single = withFile.length === 1;
  const starts = '(a new workspace starts with the default set)';
  if (inWorkspace === 0) {
    return single
      ? 'This case is not in your workspace yet. Add to workspace copies its file there, and Open then loads it.'
      : 'None of these cases is in your workspace yet. Add to workspace copies the file of a case there, and Open then loads it.';
  }
  if (inWorkspace < withFile.length) {
    const one = inWorkspace === 1;
    return `${inWorkspace} of ${withFile.length} cases ${one ? 'is' : 'are'} already in your workspace and ${one ? 'says' : 'say'} Added ${starts}. Add to workspace copies the file of another one there; Open loads a case.`;
  }
  return single
    ? `This case is already in your workspace and says Added ${starts}, so there is nothing to add: choose Open to load it. If its file is deleted from the workspace folder, the card offers Add to workspace again.`
    : `All ${withFile.length} cases are already in your workspace and say Added ${starts}, so there is nothing to add: choose Open to load one. A case whose file is deleted from the workspace folder offers Add to workspace again.`;
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
