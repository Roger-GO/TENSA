/**
 * The name an exported file is saved under, shared by every export so they all
 * read alike: `{caseName}_{runIdPrefix}_{panel}_{timestamp}.{ext}`.
 *
 * Kept in its own module (apart from `ExportMenu.tsx`) so the component file
 * exports only the component, and so an export that is not a panel's menu (the
 * HTML report) names its file the same way.
 */

/**
 * Sanitise a string into a filesystem-safe slug. Keeps `[A-Za-z0-9_-]`
 * verbatim, replaces everything else with `-`, collapses runs of `-`,
 * and trims leading/trailing `-`. An empty result falls back to `fallback`.
 */
export function slugify(s: string, fallback: string): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/** ISO-ish timestamp suitable for filenames: `2026-05-09T13-45-22`. */
export function makeTimestamp(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

/**
 * Compose `{caseName}_{runIdPrefix}_{panel}_{timestamp}.{ext}`. `runIdPrefix`
 * is omitted (and the surrounding `_` collapsed) when the caller didn't supply
 * a run id. `ext` is the extension without its dot.
 */
export function buildFilename(args: {
  caseName: string;
  runId: string | undefined;
  panel: string;
  ext: string;
  timestamp: string;
}): string {
  const caseSlug = slugify(args.caseName, 'case');
  const panelSlug = slugify(args.panel, 'panel');
  const runPart = args.runId ? `_${slugify(args.runId.slice(0, 8), 'run')}` : '';
  return `${caseSlug}${runPart}_${panelSlug}_${args.timestamp}.${args.ext}`;
}
