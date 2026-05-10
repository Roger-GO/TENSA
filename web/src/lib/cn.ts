/**
 * Class-name merger. Joins truthy class strings with spaces.
 *
 * Inlined here to avoid pulling clsx/twMerge as dependencies. Last-wins
 * conflict resolution is NOT applied; callers that need it should structure
 * variant classes so they do not collide (e.g., one variant per axis).
 *
 * Accepts strings, falsy values, arrays, and plain objects whose keys are
 * class names and whose truthy values include them. Mirrors the subset of
 * clsx that the component library actually uses.
 */
export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[]
  | { [key: string]: unknown };

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === 'string') {
      out.push(input);
    } else if (typeof input === 'number') {
      out.push(String(input));
    } else if (Array.isArray(input)) {
      const nested = cn(...input);
      if (nested) out.push(nested);
    } else if (typeof input === 'object') {
      for (const key in input) {
        if (input[key]) out.push(key);
      }
    }
  }
  return out.join(' ');
}
