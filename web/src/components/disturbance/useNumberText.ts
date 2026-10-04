import { useEffect, useState } from 'react';

/** The number a field's text stands for: an empty field is ``NaN`` ("not entered"). */
function numberOf(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? Number.NaN : Number(trimmed);
}

/** The text for a number set from outside: "not entered" is an empty field, not "NaN". */
function textOf(value: number): string {
  return Number.isNaN(value) ? '' : String(value);
}

/** Equal as numbers, ``NaN`` included: two fields that stand for "not a number" agree. */
function sameNumber(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/**
 * The text of a number field, kept apart from the number so the user can type.
 *
 * A form keeps its numbers in the spec and the text being typed in local state:
 * a half-typed value ("-", "1.", an emptied field) is not a number, and the spec
 * holds ``NaN`` for it. The text follows the spec when the spec is set from
 * outside (a dialog opening on another disturbance), but only when the number it
 * holds is not the one the text already stands for. Following it on every change
 * wrote "NaN" into a field the moment it was emptied, and made a negative number
 * impossible to type.
 */
export function useNumberText(value: number): [string, (text: string) => void] {
  const [text, setText] = useState(textOf(value));
  useEffect(() => {
    setText((current) => (sameNumber(numberOf(current), value) ? current : textOf(value)));
  }, [value]);
  return [text, setText];
}
