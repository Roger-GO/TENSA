/**
 * Adding case files to the workspace: which files the workspace takes, the limits
 * the server enforces (checked here first, so a file that is bound to be refused
 * is not sent), and what to open once a group of files has been stored.
 *
 * Mirrors `_ALLOWED_EXTENSIONS`, the refusal of layout sidecars and
 * `MAX_UPLOAD_BYTES` in `server/src/tensa/api/routes/workspace.py`. The server still has the final say,
 * and its message is what the user reads when a name slips past (a reserved
 * Windows device name, say).
 */

/** The extensions the workspace holds, lower case with the dot. */
export const CASE_FILE_EXTENSIONS = ['.raw', '.dyr', '.m', '.xlsx', '.json'] as const;

/** The same list as an `<input type="file" accept>` value. */
export const CASE_FILE_ACCEPT = CASE_FILE_EXTENSIONS.join(',');

/** The largest file the server takes: 32 MiB. */
export const MAX_CASE_UPLOAD_BYTES = 32 * 1024 * 1024;

/** The lower-case extension of a file name with its dot, or `''` when it has none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot alone (`.raw`) is a hidden file's name, not an extension.
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Why a file cannot be added, in a sentence that names it, or `null` when it can
 * be tried. Checks what the server would refuse without needing the file's
 * content: its type (a `<case>.layout.json` sidecar included), that it is not
 * empty, and its size.
 */
export function uploadProblem(file: { name: string; size: number }): string | null {
  const ext = fileExtension(file.name);
  if (!(CASE_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    return `${file.name} is not a case file. The workspace holds ${CASE_FILE_EXTENSIONS.join(', ')} files.`;
  }
  // The layout the diagram saves beside a case: the server writes it itself, from
  // its own route, and refuses it as an upload.
  if (file.name.toLowerCase().endsWith('.layout.json')) {
    return `${file.name} is a diagram layout, which the app saves beside its case. It is not a case file.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_CASE_UPLOAD_BYTES) {
    return `${file.name} is larger than ${MAX_CASE_UPLOAD_BYTES / (1024 * 1024)} MiB.`;
  }
  return null;
}

export interface OpenPlan {
  /** The case to load. */
  primary: string;
  /** The dynamic files that go with it, in the order they were given. */
  addfiles: string[];
}

/**
 * What to open after `names` were stored together: the one case among them, with
 * the `.dyr` files that came with it when it is a `.raw` (the only format a `.dyr`
 * pairs with). `null` when there is no case, or more than one so that nothing
 * says which to open. A layout sidecar (`<case>.layout.json`) is not a case.
 */
export function planOpen(names: readonly string[]): OpenPlan | null {
  const cases = names.filter((name) => {
    const ext = fileExtension(name);
    return (
      (ext === '.raw' || ext === '.xlsx' || ext === '.m' || ext === '.json') &&
      !name.endsWith('.layout.json')
    );
  });
  const primary = cases[0];
  if (cases.length !== 1 || primary === undefined) return null;
  const addfiles =
    fileExtension(primary) === '.raw' ? names.filter((name) => fileExtension(name) === '.dyr') : [];
  return { primary, addfiles };
}
