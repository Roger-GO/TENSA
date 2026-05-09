/**
 * Tests for the long-form CSV serialiser.
 *
 * Covers:
 *  - Time-series happy path (3 vars × 60 rows → 180 data rows + header)
 *  - Table happy path (rows × columns long-form expansion)
 *  - Header comments + lagged-run warning header
 *  - RFC 4180-style cell quoting
 *  - Numeric formatting (NaN, Infinity, finite)
 */
import { describe, expect, it } from 'vitest';
import { tableToCsv, timeSeriesToCsv } from '@/components/export/exportToCsv';

async function readBlob(b: Blob): Promise<string> {
  // jsdom's Blob exposes neither `.text()` nor `.arrayBuffer()` directly,
  // and Response-wrapping returns the literal "[object Blob]" string.
  // FileReader is the only path that reliably works under jsdom.
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsText(b, 'utf-8');
  });
}

describe('timeSeriesToCsv', () => {
  it('emits 1 header + N*V data rows for the long-form shape', async () => {
    const N = 60;
    const t = new Float64Array(N);
    for (let i = 0; i < N; i++) t[i] = i * 0.1;
    const a = new Float64Array(N);
    const b = new Float64Array(N);
    const c = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      a[i] = i;
      b[i] = i * 2;
      c[i] = i * 3;
    }
    const blob = timeSeriesToCsv({
      t,
      columns: { Bus_1_v: a, Bus_2_v: b, Gen_1_omega: c },
    });
    expect(blob.type).toMatch(/^text\/csv/);
    const text = await readBlob(blob);
    const lines = text.split('\n').filter((l) => l.length > 0);
    // 1 header + 180 data rows.
    expect(lines.length).toBe(1 + 180);
    expect(lines[0]).toBe('time,variable,value');
    // First data row is t=0 with the first variable.
    expect(lines[1]).toBe('0,Bus_1_v,0');
    // 180-th data row (last): t=5.9 with the third variable.
    expect(lines[180]).toMatch(/^5\.9.*,Gen_1_omega,177$/);
  });

  it('emits a warning header when droppedRowCount > 0', async () => {
    const t = new Float64Array([0, 1, 2]);
    const v = new Float64Array([1, 2, 3]);
    const blob = timeSeriesToCsv({
      t,
      columns: { x: v },
      droppedRowCount: 42,
    });
    const text = await readBlob(blob);
    expect(text).toMatch(/^# WARNING: this run dropped 42 early rows due to memory pressure\n/);
    // Header still present after the warning comment.
    expect(text).toContain('time,variable,value');
  });

  it('omits the warning header when droppedRowCount is 0 or undefined', async () => {
    const t = new Float64Array([0, 1]);
    const v = new Float64Array([1, 2]);
    const noWarn = await readBlob(timeSeriesToCsv({ t, columns: { x: v } }));
    const zeroWarn = await readBlob(timeSeriesToCsv({ t, columns: { x: v }, droppedRowCount: 0 }));
    expect(noWarn).not.toMatch(/WARNING/);
    expect(zeroWarn).not.toMatch(/WARNING/);
  });

  it('quotes cells containing commas, quotes, or newlines', async () => {
    const t = new Float64Array([0]);
    const v = new Float64Array([1]);
    const blob = timeSeriesToCsv({
      t,
      columns: { 'BUS,WITH"QUOTES': v },
    });
    const text = await readBlob(blob);
    // The variable cell must be quoted with the embedded `"` doubled.
    expect(text).toContain('0,"BUS,WITH""QUOTES",1');
  });

  it('renders NaN / Infinity as readable tokens', async () => {
    const t = new Float64Array([0, 1, 2]);
    const v = new Float64Array([NaN, Infinity, -Infinity]);
    const blob = timeSeriesToCsv({ t, columns: { v } });
    const text = await readBlob(blob);
    expect(text).toContain('0,v,NaN');
    expect(text).toContain('1,v,Infinity');
    expect(text).toContain('2,v,-Infinity');
  });

  it('surfaces user-supplied comments in the order given', async () => {
    const t = new Float64Array([0]);
    const v = new Float64Array([1]);
    const blob = timeSeriesToCsv({
      t,
      columns: { v },
      comments: ['filter=foo', 'tab=buses'],
    });
    const text = await readBlob(blob);
    const lines = text.split('\n');
    expect(lines[0]).toBe('# filter=foo');
    expect(lines[1]).toBe('# tab=buses');
    expect(lines[2]).toBe('time,variable,value');
  });
});

describe('tableToCsv', () => {
  it('expands rows × columns into long-form rows', async () => {
    const blob = tableToCsv({
      columns: ['idx', 'name', 'V (pu)'],
      rows: [
        { label: '1', cells: ['1', 'Bus1', '1.0600'] },
        { label: '2', cells: ['2', 'Bus2', '1.0450'] },
      ],
    });
    expect(blob.type).toMatch(/^text\/csv/);
    const text = await readBlob(blob);
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('row_label,column,value');
    expect(lines[1]).toBe('1,idx,1');
    expect(lines[2]).toBe('1,name,Bus1');
    expect(lines[3]).toBe('1,V (pu),1.0600');
    expect(lines[4]).toBe('2,idx,2');
    expect(lines.length).toBe(1 + 6); // 2 rows * 3 cols + header
  });

  it('emits empty cells for missing values in a jagged row', async () => {
    const blob = tableToCsv({
      columns: ['a', 'b', 'c'],
      rows: [{ label: 'r1', cells: ['x'] }],
    });
    const text = await readBlob(blob);
    expect(text).toContain('r1,a,x');
    expect(text).toContain('r1,b,');
    expect(text).toContain('r1,c,');
  });

  it('lets the caller embed a filter-state comment header', async () => {
    const blob = tableToCsv({
      columns: ['idx'],
      rows: [{ label: '1', cells: ['1'] }],
      comments: ['filter=Bus1', 'tab=buses'],
    });
    const text = await readBlob(blob);
    const lines = text.split('\n');
    expect(lines[0]).toBe('# filter=Bus1');
    expect(lines[1]).toBe('# tab=buses');
  });
});
