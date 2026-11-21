/**
 * The MATLAB file of the Ybus dialog. No MATLAB or Octave runs here, so the
 * test reads the file back with a strict reader of the part of the language
 * the file uses (comments, a numeric matrix literal, ``zeros``, and the one
 * ``sparse(..., complex(...), m, n)`` call), rebuilds the matrix as MATLAB
 * would (1-based indices, duplicates summed) and holds it to the input double
 * for double. The reader refuses anything else, so a file that would not parse
 * fails here.
 */
import { describe, expect, it } from 'vitest';
import { ybusMatlabFilename, ybusToMatlab } from '@/components/ybus/ybusToMatlab';
import type { components } from '@/api/generated';

type YbusResponse = components['schemas']['YbusResponse'];

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
// A real literal as MATLAB reads one: digits, an optional fraction and exponent.
const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const KEYWORDS = new Set(['end', 'function', 'if', 'for', 'while', 'return', 'break']);

interface ReadBack {
  n: number;
  m: number;
  busOrder: string[];
  /** Key ``row,col`` (1-based, as MATLAB holds them) to the complex value. */
  values: Map<string, { re: number; im: number }>;
}

function readMatlab(text: string): ReadBack {
  const lines = text.split('\n');
  const arrays = new Map<string, number[][]>();
  const busOrder: string[] = [];
  let result: ReadBack | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    if (line.startsWith('%')) {
      const bus = /^%\s+(\d+): (.*)$/.exec(line);
      if (bus) {
        expect(Number(bus[1])).toBe(busOrder.length + 1);
        busOrder.push(bus[2]!);
      }
      continue;
    }
    expect(result, 'nothing may follow the sparse call').toBeNull();
    const zeros = /^(\w+) = zeros\(0, 4\);$/.exec(line);
    const open = /^(\w+) = \[$/.exec(line);
    const sparse =
      /^(\w+) = sparse\((\w+)\(:, 1\), \2\(:, 2\), complex\(\2\(:, 3\), \2\(:, 4\)\), (\d+), (\d+)\);$/.exec(
        line,
      );
    if (zeros) {
      arrays.set(zeros[1]!, []);
    } else if (open) {
      const rows: number[][] = [];
      for (i += 1; lines[i] !== '];'; i++) {
        if (i >= lines.length) throw new Error('the matrix literal is never closed');
        const tokens = lines[i]!.trim().split(/\s+/);
        expect(tokens.length, `row "${lines[i]}" has four values`).toBe(4);
        for (const t of tokens) expect(t, 'a number MATLAB reads').toMatch(NUMBER);
        rows.push(tokens.map(Number));
      }
      arrays.set(open[1]!, rows);
    } else if (sparse) {
      const [, name, source, m, n] = sparse;
      for (const id of [name!, source!]) {
        expect(id).toMatch(IDENTIFIER);
        expect(KEYWORDS.has(id)).toBe(false);
      }
      const rows = arrays.get(source!);
      if (rows === undefined) throw new Error(`${source} is used before it is set`);
      const values = new Map<string, { re: number; im: number }>();
      for (const [r, c, re, im] of rows) {
        expect(Number.isInteger(r) && r! >= 1 && r! <= Number(m)).toBe(true);
        expect(Number.isInteger(c) && c! >= 1 && c! <= Number(n)).toBe(true);
        const key = `${r},${c}`;
        const had = values.get(key);
        values.set(
          key,
          had === undefined ? { re: re!, im: im! } : { re: had.re + re!, im: had.im + im! },
        );
      }
      result = { m: Number(m), n: Number(n), busOrder, values };
    } else {
      throw new Error(`a line MATLAB would not read as the file means it: "${line}"`);
    }
  }
  if (result === null) throw new Error('no sparse call');
  return result;
}

/** Hold the read-back matrix to the input, bit for bit. */
function expectSameMatrix(back: ReadBack, data: YbusResponse): void {
  expect(back.m).toBe(data.n_bus);
  expect(back.n).toBe(data.n_bus);
  expect(back.busOrder).toEqual(data.bus_idx);
  expect(back.values.size).toBe(data.entries.length);
  for (const e of data.entries) {
    const v = back.values.get(`${e.row + 1},${e.col + 1}`);
    expect(v, `entry ${e.row},${e.col}`).toBeDefined();
    expect(Object.is(v!.re, e.re), `re of ${e.row},${e.col}: ${v!.re} vs ${e.re}`).toBe(true);
    expect(Object.is(v!.im, e.im), `im of ${e.row},${e.col}: ${v!.im} vs ${e.im}`).toBe(true);
  }
}

/** Doubles from random bits: every exponent and every mantissa digit. */
function randomDouble(seed: { s: number }): number {
  const view = new DataView(new ArrayBuffer(8));
  for (;;) {
    for (let b = 0; b < 8; b++) {
      seed.s = (Math.imul(seed.s, 1103515245) + 12345) >>> 0;
      view.setUint8(b, seed.s >>> 24);
    }
    const x = view.getFloat64(0);
    if (Number.isFinite(x)) return x;
  }
}

// Bus idx values that are not their positions, so a file that wrote the
// position where the idx belongs (or the other way round) is caught.
const DATA: YbusResponse = {
  n_bus: 3,
  base_mva: 100,
  bus_idx: ['101', '7', 'BUS 30'],
  bus_key: [null, 'b2', null],
  entries: [
    { row: 0, col: 2, re: 0.1 + 0.2, im: -2.5 },
    { row: 1, col: 1, re: 4, im: 0.25 },
    { row: 2, col: 0, re: -1.2345678901234566e-7, im: 19.447070205514382 },
    { row: 2, col: 2, re: 0, im: -0 },
  ],
};

async function textOf(data: YbusResponse): Promise<string> {
  return await ybusToMatlab(data).text();
}

describe('ybusToMatlab', () => {
  it('reads back as the same matrix, double for double, with 1-based indices', async () => {
    const text = await textOf(DATA);
    expectSameMatrix(readMatlab(text), DATA);
    // The entry {row: 0, col: 2} is row 1, column 3 in MATLAB.
    expect(text).toContain('\n1 3 0.30000000000000004 -2.5\n');
  });

  it('reads back a large random matrix exactly, every double at full precision', async () => {
    const seed = { s: 7 };
    const n = 400;
    const entries: YbusResponse['entries'] = [];
    for (let k = 0; k < 3000; k++) {
      entries.push({
        row: k % n,
        col: (k * 37) % n,
        re: randomDouble(seed),
        im: randomDouble(seed),
      });
    }
    // One entry per position, as the server sends them.
    const unique = [...new Map(entries.map((e) => [`${e.row},${e.col}`, e])).values()];
    const data: YbusResponse = {
      n_bus: n,
      base_mva: 100,
      bus_idx: Array.from({ length: n }, (_, i) => `B${n - i}`),
      bus_key: Array.from({ length: n }, () => null),
      entries: unique,
    };
    expectSameMatrix(readMatlab(await textOf(data)), data);
  });

  it('writes an empty matrix that still reads as n by n', async () => {
    const empty: YbusResponse = { ...DATA, entries: [] };
    const text = await textOf(empty);
    expect(text).toContain('ybus_triplets = zeros(0, 4);');
    expectSameMatrix(readMatlab(text), empty);
  });

  it('heads the file with the size, the base and the bus order', async () => {
    const text = await textOf(DATA);
    expect(text.startsWith('% Bus admittance matrix (Ybus), 3 x 3, 4 nonzeros\n')).toBe(true);
    expect(text).toContain('% Per unit on the system base: 100 MVA\n');
    expect(text).toContain('%   1: 101\n%   2: 7\n%   3: BUS 30\n');
  });

  it('says the case carries no usable system base when base_mva is null', async () => {
    const text = await textOf({ ...DATA, base_mva: null });
    expect(text).toContain('% Per unit; the case carries no usable system base\n');
    expect(text).not.toContain('MVA');
  });

  it('keeps a bus idx with a line break inside its comment', async () => {
    const odd: YbusResponse = { ...DATA, bus_idx: ['101', 'a\nYbus = 0;', 'BUS 30'] };
    const back = readMatlab(await textOf(odd));
    expect(back.busOrder[1]).toBe('a Ybus = 0;');
  });
});

describe('ybusMatlabFilename', () => {
  it('names the file as a MATLAB identifier, with the case name and the timestamp', () => {
    expect(ybusMatlabFilename('ieee14', '2026-11-21T10-03-55')).toBe(
      'ieee14_ybus_2026_11_21T10_03_55.m',
    );
  });

  it('starts with a letter and stays within 63 characters whatever the case is called', () => {
    for (const name of ['14-bus case', '', '___', 'Ünïcode ñame', 'x'.repeat(200)]) {
      const file = ybusMatlabFilename(name, '2026-11-21T10-03-55');
      expect(file.endsWith('_ybus_2026_11_21T10_03_55.m')).toBe(true);
      expect(file.slice(0, -2), name).toMatch(IDENTIFIER);
    }
    expect(ybusMatlabFilename('14-bus case', '2026-11-21T10-03-55')).toBe(
      'case_14_bus_case_ybus_2026_11_21T10_03_55.m',
    );
  });
});
