/**
 * The bus admittance matrix as a MATLAB ``.m`` script, which MATLAB and Octave
 * both run: the bus order in a comment, the triplets as a numeric matrix of
 * four columns (row, column, G, B), and one ``sparse`` call that builds the
 * complex matrix ``Ybus`` from them.
 *
 * MATLAB indices are 1-based, so every row and column is written one higher
 * than the server sends it. Each number is written as ``String(n)`` (``-0``
 * for negative zero), the shortest text that reads back as the same double,
 * so the file holds the matrix exactly. The real and imaginary parts are columns of their own and
 * are joined by ``complex``, which leaves no sign of an imaginary part for the
 * parser to misread and keeps a purely real entry complex.
 */
import type { components } from '@/api/generated';

/** The bus admittance matrix of the loaded case, as sparse triplets. */
type YbusResponse = components['schemas']['YbusResponse'];

/** The longest name MATLAB gives a variable, a function or a script. */
const MATLAB_NAME_MAX = 63;

/** A number as the shortest text that reads back as the same double, -0 included. */
function num(x: number): string {
  return Object.is(x, -0) ? '-0' : String(x);
}

/** A bus idx made safe for a comment line: no line break can end the comment. */
function commentText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

export function ybusToMatlab(data: YbusResponse): Blob {
  const n = data.n_bus;
  const lines: string[] = [];
  lines.push(`% Bus admittance matrix (Ybus), ${n} x ${n}, ${data.entries.length} nonzeros`);
  lines.push(
    data.base_mva === null
      ? '% Per unit; the case carries no usable system base'
      : `% Per unit on the system base: ${data.base_mva} MVA`,
  );
  lines.push('% Bus order: row and column i of Ybus is the bus with this idx.');
  data.bus_idx.forEach((idx, i) => {
    lines.push(`%   ${i + 1}: ${commentText(idx)}`);
  });
  lines.push('% Each row of ybus_triplets: row, column, conductance G, susceptance B.');
  if (data.entries.length === 0) {
    lines.push('ybus_triplets = zeros(0, 4);');
  } else {
    lines.push('ybus_triplets = [');
    for (const e of data.entries) {
      lines.push(`${e.row + 1} ${e.col + 1} ${num(e.re)} ${num(e.im)}`);
    }
    lines.push('];');
  }
  lines.push(
    'Ybus = sparse(ybus_triplets(:, 1), ybus_triplets(:, 2), ' +
      `complex(ybus_triplets(:, 3), ybus_triplets(:, 4)), ${n}, ${n});`,
  );
  return new Blob([`${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
}

/**
 * The file name of the MATLAB download. MATLAB runs a script by its name, so
 * the name is a valid identifier: letters, digits and underscores, starting
 * with a letter, at most 63 characters (the case name is shortened, the
 * timestamp kept). ``ieee14`` at 10:03:55 on 21 November 2026 gives
 * ``ieee14_ybus_2026_11_21T10_03_55.m``.
 */
export function ybusMatlabFilename(caseName: string, timestamp: string): string {
  const word = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const tail = `_ybus_${word(timestamp)}`;
  let head = word(caseName);
  if (!/^[A-Za-z]/.test(head)) head = head === '' ? 'case' : `case_${head}`;
  head = head.slice(0, MATLAB_NAME_MAX - tail.length).replace(/_+$/, '');
  return `${head}${tail}.m`;
}
