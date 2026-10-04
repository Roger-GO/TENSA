/**
 * The pieces of a workspace path the UI shows or compares: the file name, the
 * name without its extension, and the extension. Workspace paths are
 * `/`-separated, but a path that came from somewhere else may carry `\`, so both
 * separate directories. A leading dot belongs to the name, as it does for the
 * server and for ANDES: `.gitignore` has no extension and `.hidden.raw` has `.raw`.
 */

/** The file name of a path, without its directory. */
export function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash === -1 ? path : path.slice(slash + 1);
}

/** The extension of a path's file name with its dot, as written (`''` when it has none). */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/** The file name without its directory or its extension: `cases/ieee14.raw` gives `ieee14`. */
export function stemOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
