import { describe, expect, it } from 'vitest';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { decodeArrowBatch } from '@/streaming/arrow';
import { arrowBatches, arrowFrame } from '../helpers/frames';

describe('decodeArrowBatch', () => {
  it('decodes a happy-path frame by position against the announced names', () => {
    const buffer = arrowFrame([0.0, 0.01, 0.02], {
      Bus_1_v: [1.0, 0.999, 0.998],
      Bus_2_v: [1.01, 1.005, 1.003],
    });
    const decoded = decodeArrowBatch(buffer, ['Bus_1_v', 'Bus_2_v']);
    expect(decoded.numRows).toBe(3);
    expect(Array.from(decoded.t)).toEqual([0.0, 0.01, 0.02]);
    expect(decoded.columnNames).toEqual(['Bus_1_v', 'Bus_2_v']);
    expect(Array.from(decoded.columns.Bus_1_v!)).toEqual([1.0, 0.999, 0.998]);
    expect(Array.from(decoded.columns.Bus_2_v!)).toEqual([1.01, 1.005, 1.003]);
  });

  it('names the columns from the caller, not from the frame', () => {
    // The frame carries values only; the same bytes under other names decode
    // to the same numbers under those names.
    const buffer = arrowFrame([0.5], { a: [1.5], b: [2.5] });
    const decoded = decodeArrowBatch(buffer, ['Gen_1_delta', 'Gen_1_omega']);
    expect(decoded.columns.Gen_1_delta![0]).toBe(1.5);
    expect(decoded.columns.Gen_1_omega![0]).toBe(2.5);
    expect(decoded.columns.a).toBeUndefined();
  });

  it('preserves NaN values (uPlot draws gaps)', () => {
    const buffer = arrowFrame([0.0, 0.01], { Bus_1_v: [1.0, Number.NaN] });
    const decoded = decodeArrowBatch(buffer, ['Bus_1_v']);
    expect(Number.isNaN(decoded.columns.Bus_1_v![1])).toBe(true);
    expect(decoded.columns.Bus_1_v![0]).toBe(1.0);
  });

  it('keeps the announced order in columnNames', () => {
    const buffer = arrowFrame([0.0], {
      Line_4_5_p: [100.0],
      Bus_1_v: [1.0],
      Gen_2_omega: [1.0001],
    });
    const names = ['Line_4_5_p', 'Bus_1_v', 'Gen_2_omega'];
    const decoded = decodeArrowBatch(buffer, names);
    expect(decoded.columnNames).toEqual(names);
    expect(decoded.columns.Gen_2_omega![0]).toBe(1.0001);
  });

  it('returns an empty frame on a zero-row batch', () => {
    const buffer = arrowFrame([], { Bus_1_v: [] });
    const decoded = decodeArrowBatch(buffer, ['Bus_1_v']);
    expect(decoded.numRows).toBe(0);
    expect(decoded.t.length).toBe(0);
    expect(decoded.columns).toEqual({});
  });

  it('returns a Float64Array (typed) for t and every variable column', () => {
    const buffer = arrowFrame([0.0, 0.01], { Bus_1_v: [1.0, 0.999] });
    const decoded = decodeArrowBatch(buffer, ['Bus_1_v']);
    expect(decoded.t).toBeInstanceOf(Float64Array);
    expect(decoded.columns.Bus_1_v).toBeInstanceOf(Float64Array);
  });

  it('gathers each column of a multi-row frame from its strided values', () => {
    const buffer = arrowFrame([0.0, 0.1, 0.2, 0.3], {
      A: [1, 2, 3, 4],
      B: [10, 20, 30, 40],
      C: [100, 200, 300, 400],
    });
    const decoded = decodeArrowBatch(buffer, ['A', 'B', 'C']);
    expect(decoded.numRows).toBe(4);
    expect(Array.from(decoded.columns.A!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(decoded.columns.B!)).toEqual([10, 20, 30, 40]);
    expect(Array.from(decoded.columns.C!)).toEqual([100, 200, 300, 400]);
  });

  it('decodes a frame with no columns to t alone', () => {
    // The substrate sends this when the selected variables have no members on
    // the loaded case (``gen_state`` on a case without dynamic models).
    const buffer = arrowFrame([0.0, 0.1], {});
    const decoded = decodeArrowBatch(buffer, []);
    expect(decoded.numRows).toBe(2);
    expect(Array.from(decoded.t)).toEqual([0.0, 0.1]);
    expect(decoded.columns).toEqual({});
  });

  it('concatenates the rows of a message that holds several batches', () => {
    const buffer = arrowBatches([
      { t: [0.0, 0.1], cols: { A: [1, 2], B: [10, 20] } },
      { t: [0.2], cols: { A: [3], B: [30] } },
    ]);
    const decoded = decodeArrowBatch(buffer, ['A', 'B']);
    expect(decoded.numRows).toBe(3);
    expect(Array.from(decoded.t)).toEqual([0.0, 0.1, 0.2]);
    expect(Array.from(decoded.columns.A!)).toEqual([1, 2, 3]);
    expect(Array.from(decoded.columns.B!)).toEqual([10, 20, 30]);
  });

  describe('a frame that does not match stream_start', () => {
    it('throws when the frame is wider than the announced columns', () => {
      const buffer = arrowFrame([0.0], { A: [1], B: [2] });
      expect(() => decodeArrowBatch(buffer, ['A'])).toThrow(
        /2 values per row but stream_start named 1 columns/,
      );
    });

    it('throws when the frame is narrower than the announced columns', () => {
      const buffer = arrowFrame([0.0], { A: [1] });
      expect(() => decodeArrowBatch(buffer, ['A', 'B', 'C'])).toThrow(
        /1 values per row but stream_start named 3 columns/,
      );
    });

    it('throws when stream_start named no columns but the frame has values', () => {
      const buffer = arrowFrame([0.0], { A: [1] });
      expect(() => decodeArrowBatch(buffer, [])).toThrow(/stream_start named 0 columns/);
    });

    it('throws when a frame without values is read against named columns', () => {
      const buffer = arrowFrame([0.0], {});
      expect(() => decodeArrowBatch(buffer, ['A'])).toThrow(/0 values per row/);
    });
  });

  it("throws on a frame missing the required 't' column", () => {
    const bytes = tableToIPC(tableFromArrays({ Bus_1_v: new Float64Array([1.0]) }), 'stream');
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    // No ``v`` column either, so the width check passes against no names.
    expect(() => decodeArrowBatch(buffer, [])).toThrow(/missing required 't'/);
  });

  describe('a frame as wide as the WECC case (1208 columns)', () => {
    const names = Array.from({ length: 1208 }, (_, j) => `Col_${j}`);

    it('puts every value under the name at its position', () => {
      const cols: Record<string, number[]> = {};
      names.forEach((name, j) => {
        cols[name] = [j + 0.5];
      });
      const decoded = decodeArrowBatch(arrowFrame([0.25], cols), names);
      expect(decoded.numRows).toBe(1);
      expect(Object.keys(decoded.columns)).toHaveLength(1208);
      for (const j of [0, 1, 600, 1206, 1207]) {
        expect(decoded.columns[`Col_${j}`]![0]).toBe(j + 0.5);
      }
    });

    it('hands out the columns of a one-row frame as views over one buffer', () => {
      // No per-column copy: the cost of a frame is the cost of its values.
      const cols: Record<string, number[]> = {};
      for (const name of names) cols[name] = [1];
      const decoded = decodeArrowBatch(arrowFrame([0.0], cols), names);
      const first = decoded.columns.Col_0!;
      const last = decoded.columns.Col_1207!;
      expect(first.buffer).toBe(last.buffer);
      expect(first.length).toBe(1);
      expect(last.byteOffset - first.byteOffset).toBe(1207 * 8);
    });
  });
});
