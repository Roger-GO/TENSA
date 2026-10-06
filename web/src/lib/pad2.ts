/** A part of a date or a time as two digits: `7` as `07`. */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
