import { describe, expect, it } from 'vitest';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { decodeArrowBatch } from '@/streaming/arrow';

/**
 * Helper: build a one-batch IPC stream from named ``Float64Array`` columns.
 * Mirrors what the Phase A substrate sends per WS binary message: schema
 * preamble + one RecordBatch carrying ``t`` + variable columns.
 */
function buildIpcBatch(columns: Record<string, Float64Array>): ArrayBuffer {
  const table = tableFromArrays(columns);
  const bytes = tableToIPC(table, 'stream');
  // Copy into a fresh ``ArrayBuffer`` so the slice is owned + concrete
  // (``Uint8Array#buffer`` widens to ``ArrayBufferLike`` since it can be
  // backed by a ``SharedArrayBuffer``).
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

describe('decodeArrowBatch', () => {
  it('decodes a happy-path batch with t + bus voltage columns', () => {
    const buffer = buildIpcBatch({
      t: new Float64Array([0.0, 0.01, 0.02]),
      Bus_1_v: new Float64Array([1.0, 0.999, 0.998]),
      Bus_2_v: new Float64Array([1.01, 1.005, 1.003]),
    });
    const decoded = decodeArrowBatch(buffer);
    expect(decoded.numRows).toBe(3);
    expect(Array.from(decoded.t)).toEqual([0.0, 0.01, 0.02]);
    expect(decoded.columnNames).toEqual(['Bus_1_v', 'Bus_2_v']);
    expect(Array.from(decoded.columns.Bus_1_v!)).toEqual([1.0, 0.999, 0.998]);
    expect(Array.from(decoded.columns.Bus_2_v!)).toEqual([1.01, 1.005, 1.003]);
  });

  it('preserves NaN values (uPlot draws gaps)', () => {
    const buffer = buildIpcBatch({
      t: new Float64Array([0.0, 0.01]),
      Bus_1_v: new Float64Array([1.0, Number.NaN]),
    });
    const decoded = decodeArrowBatch(buffer);
    expect(Number.isNaN(decoded.columns.Bus_1_v![1])).toBe(true);
    expect(decoded.columns.Bus_1_v![0]).toBe(1.0);
  });

  it('preserves unknown future columns (forward-compat)', () => {
    // Simulate a future schema addition the decoder has never seen.
    const buffer = buildIpcBatch({
      t: new Float64Array([0.0]),
      Bus_1_v: new Float64Array([1.0]),
      Future_metric_42: new Float64Array([3.14]),
    });
    const decoded = decodeArrowBatch(buffer);
    expect(decoded.columnNames).toEqual(['Bus_1_v', 'Future_metric_42']);
    expect(decoded.columns.Future_metric_42![0]).toBeCloseTo(3.14);
  });

  it('returns empty frame on a zero-row batch', () => {
    const buffer = buildIpcBatch({
      t: new Float64Array([]),
      Bus_1_v: new Float64Array([]),
    });
    const decoded = decodeArrowBatch(buffer);
    expect(decoded.numRows).toBe(0);
    expect(decoded.t.length).toBe(0);
    expect(decoded.columns).toEqual({});
  });

  it('preserves the schema column order in columnNames', () => {
    const buffer = buildIpcBatch({
      t: new Float64Array([0.0]),
      Line_4_5_p: new Float64Array([100.0]),
      Bus_1_v: new Float64Array([1.0]),
      Gen_2_omega: new Float64Array([1.0001]),
    });
    const decoded = decodeArrowBatch(buffer);
    // ``columnNames`` walks ``schema.fields`` in order; ``t`` is split out.
    expect(decoded.columnNames).toEqual(['Line_4_5_p', 'Bus_1_v', 'Gen_2_omega']);
  });

  it("throws on a batch missing the required 't' column", () => {
    const buffer = buildIpcBatch({
      Bus_1_v: new Float64Array([1.0]),
    });
    expect(() => decodeArrowBatch(buffer)).toThrow(/missing required 't'/);
  });

  it('returns a Float64Array (typed) for t and every variable column', () => {
    const buffer = buildIpcBatch({
      t: new Float64Array([0.0, 0.01]),
      Bus_1_v: new Float64Array([1.0, 0.999]),
    });
    const decoded = decodeArrowBatch(buffer);
    expect(decoded.t).toBeInstanceOf(Float64Array);
    expect(decoded.columns.Bus_1_v).toBeInstanceOf(Float64Array);
  });
});
