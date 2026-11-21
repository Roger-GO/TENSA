/**
 * The CSV of the Ybus dialog: a header of column names, then one row per
 * entry in the order the caller passes (the order the table shows), with the
 * bus idx of each row and column and the numbers at full precision.
 */
import { describe, expect, it } from 'vitest';
import { ybusToCsv } from '@/components/ybus/ybusToCsv';
import type { components } from '@/api/generated';

type YbusResponse = components['schemas']['YbusResponse'];

// Bus idx values that are not their positions, so a row that wrote the
// position in place of the idx is caught.
const DATA: YbusResponse = {
  n_bus: 3,
  base_mva: 100,
  bus_idx: ['101', '7', 'BUS 30'],
  bus_key: [null, null, null],
  entries: [
    { row: 0, col: 2, re: 0.1 + 0.2, im: -2.5 },
    { row: 1, col: 1, re: 4, im: 19.447070205514382 },
    { row: 2, col: 0, re: -1.2345678901234566e-7, im: 0.25 },
  ],
};

describe('ybusToCsv', () => {
  it('writes the header and one row per entry, with bus idx values and full precision', async () => {
    const text = await ybusToCsv(DATA, DATA.entries).text();
    expect(text).toBe(
      'row_idx,col_idx,g_pu,b_pu\n' +
        '101,BUS 30,0.30000000000000004,-2.5\n' +
        '7,7,4,19.447070205514382\n' +
        'BUS 30,101,-1.2345678901234566e-7,0.25\n',
    );
  });

  it('reads back as the same entries, double for double', async () => {
    const text = await ybusToCsv(DATA, DATA.entries).text();
    const rows = text.trimEnd().split('\n').slice(1);
    expect(rows).toHaveLength(DATA.entries.length);
    rows.forEach((line, k) => {
      const [r, c, g, b] = line.split(',');
      const e = DATA.entries[k]!;
      expect(r).toBe(DATA.bus_idx[e.row]);
      expect(c).toBe(DATA.bus_idx[e.col]);
      expect(Number(g)).toBe(e.re);
      expect(Number(b)).toBe(e.im);
    });
  });

  it('keeps the sign of a negative zero', async () => {
    const text = await ybusToCsv(DATA, [{ row: 1, col: 1, re: -0, im: 0 }]).text();
    expect(text).toBe('row_idx,col_idx,g_pu,b_pu\n7,7,-0,0\n');
    expect(Object.is(Number('-0'), -0)).toBe(true);
  });

  it('exports in the order the caller passes, so a sorted or filtered table exports as it reads', async () => {
    const text = await ybusToCsv(DATA, [DATA.entries[2]!, DATA.entries[1]!]).text();
    expect(text).toBe(
      'row_idx,col_idx,g_pu,b_pu\nBUS 30,101,-1.2345678901234566e-7,0.25\n7,7,4,19.447070205514382\n',
    );
  });
});
