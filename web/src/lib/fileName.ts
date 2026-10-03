/**
 * Name rule for anything the user names that the server stores as a file:
 * snapshots and save-as cases. Mirrors `user_name_problem` in
 * `server/src/tensa/security/names.py`, so a name this accepts is one the
 * server accepts. The server still has the final say and its message surfaces
 * inline when a name slips past.
 *
 * The rule: 1-64 chars of `[A-Za-z0-9._-]` starting with an alphanumeric, not
 * ending in a dot (Windows strips it), and not a Windows device name (`CON`,
 * `NUL`, `COM1`, ...), which Windows opens as a device whatever the extension.
 */
const SHAPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The device name is the part before the first dot, compared without case.
const DEVICE_STEM_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Why `name` is not an acceptable name, or `null` when it is. An empty name
 * is reported as a shape problem; callers that treat empty as "not typed yet"
 * check for it first. */
export function userNameProblem(name: string): string | null {
  if (!SHAPE_RE.test(name)) {
    return 'Use 1-64 chars of letters, digits, dot, underscore, or dash (start with a letter or digit).';
  }
  if (name.endsWith('.')) return 'The name cannot end with a dot.';
  const stem = name.split('.', 1)[0] ?? '';
  if (DEVICE_STEM_RE.test(stem)) {
    return `"${stem}" is a reserved Windows device name; choose another name.`;
  }
  return null;
}
