/**
 * The results document of a compare side: built from a kept run through the
 * server's conversion route, parsed from a file, and the request body with
 * only the tolerances that differ from their defaults.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/queries/compare', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/queries/compare')>();
  return { ...original, convertResult: vi.fn() };
});

import { convertResult } from '@/api/queries/compare';
import {
  buildCompareRequest,
  DEFAULT_DAMPING_TOLERANCE_TEXT,
  DEFAULT_FREQ_TOLERANCE_HZ_TEXT,
  DEFAULT_MAX_MODE_DISTANCE_TEXT,
  DEFAULT_QUANTITY_TOLERANCES,
  parseResultsDocumentFile,
  runSideLabel,
  runToResultsDocument,
} from '@/lib/resultsDocument';
import { finishedRun } from '../helpers/runs';

const defaultTolerances = () => ({
  quantities: {},
  frequency_hz: DEFAULT_FREQ_TOLERANCE_HZ_TEXT,
  damping_ratio: DEFAULT_DAMPING_TOLERANCE_TEXT,
  max_mode_distance: DEFAULT_MAX_MODE_DISTANCE_TEXT,
});

describe('runToResultsDocument', () => {
  beforeEach(() => vi.mocked(convertResult).mockReset());

  it('sends the run traces sliced to seqCount and its keys, and labels the side', async () => {
    // Over-allocated arrays: 3 rows in room for 8.
    const t = new Float64Array(8);
    t.set([0, 0.1, 0.2]);
    const v = new Float64Array(8);
    v.set([1, 0.99, 0.98]);
    const run = finishedRun('r1', {
      t,
      columns: { Bus_7_v: v },
      columnNames: ['Bus_7_v'],
      engine: 'andes',
      keys: [{ key: 'bus:7', bucket: 'bus', model: 'Bus', idx: 7, source: 'file' }],
      displayName: 'Base case',
      caseName: 'ieee14',
    });
    vi.mocked(convertResult).mockResolvedValue({
      document: {
        tensa_results: 1,
        engine: { name: 'andes' },
        status: 'completed',
        series: [
          { quantity: 'voltage', of: 'bus:7', unit: 'pu', t: [0, 0.1, 0.2], y: [1, 0.99, 0.98] },
        ],
      },
      skipped: [{ name: 'Line_5_P', reason: 'no key' }],
      notes: [],
    });

    const { side, skipped } = await runToResultsDocument(run);

    expect(convertResult).toHaveBeenCalledWith({
      kind: 'tds',
      engine: 'andes',
      status: 'completed',
      result: {
        t: [0, 0.1, 0.2],
        variables: [{ name: 'Bus_7_v', values: [1, 0.99, 0.98] }],
        truncated: false,
      },
      keys: [{ key: 'bus:7', bucket: 'bus', model: 'Bus', idx: 7, source: 'file' }],
    });
    expect(side.label).toBe('Base case · ieee14');
    expect(side.document.series).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('assumes andes and sends no keys for a run recorded before they were kept', async () => {
    const run = finishedRun('r1');
    vi.mocked(convertResult).mockResolvedValue({
      document: { tensa_results: 1, engine: { name: 'andes' }, status: 'completed', series: [] },
      skipped: [],
      notes: [],
    });

    await runToResultsDocument(run);

    expect(vi.mocked(convertResult).mock.calls[0]![0].engine).toBe('andes');
    expect(vi.mocked(convertResult).mock.calls[0]![0].keys).toEqual([]);
  });

  it('sends the status of how the run ended', async () => {
    vi.mocked(convertResult).mockResolvedValue({
      document: { tensa_results: 1, engine: { name: 'andes' }, status: 'aborted', series: [] },
      skipped: [],
      notes: [],
    });
    await runToResultsDocument(finishedRun('r1', { state: 'aborted' }));
    await runToResultsDocument(finishedRun('r2', { state: 'error' }));
    await runToResultsDocument(finishedRun('r3', { state: 'done' }));
    expect(vi.mocked(convertResult).mock.calls.map((call) => call[0].status)).toEqual([
      'aborted',
      'failed',
      'completed',
    ]);
  });
});

describe('runSideLabel', () => {
  it('is the display name when set, else TDS #ordinal, with the case appended', () => {
    expect(runSideLabel(finishedRun('r1', { displayName: 'Base case', caseName: 'ieee14' }))).toBe(
      'Base case · ieee14',
    );
    expect(runSideLabel(finishedRun('r1', { ordinal: 3 }))).toBe('TDS #3');
    expect(runSideLabel(finishedRun('r1', { ordinal: 3, caseName: 'ieee14' }))).toBe(
      'TDS #3 · ieee14',
    );
  });
});

describe('parseResultsDocumentFile', () => {
  it('accepts a document with engine, status and tensa_results and strips them', () => {
    const text = JSON.stringify({
      tensa_results: 1,
      engine: { name: 'andes', versions: {} },
      status: 'completed',
      study: null,
      series: [{ quantity: 'voltage', of: 'bus:7', unit: 'pu', t: [0], y: [1] }],
      tables: { pflow: { converged: true, rows: [] }, other: { dropped: true } },
    });

    const side = parseResultsDocumentFile(text, 'base.json');

    // The file's own engine and status are dropped; the document carries the
    // stand-ins the view strips again when it packs the request.
    expect(side.document).toEqual({
      tensa_results: 1,
      engine: { name: 'andes' },
      status: 'completed',
      series: [{ quantity: 'voltage', of: 'bus:7', unit: 'pu', t: [0], y: [1] }],
      tables: { pflow: { converged: true, rows: [] } },
    });
    expect(side.label).toBe('base');
  });

  it('throws "not a JSON file" for text that does not parse', () => {
    expect(() => parseResultsDocumentFile('not json {', 'x.json')).toThrow(
      'x.json is not a JSON file',
    );
  });

  it.each([
    ['no series array', {}, 'no series array'],
    [
      'a series entry without a string quantity',
      { series: [{ of: 'bus:7', unit: 'pu', t: [], y: [] }] },
      'series 0 has no string quantity',
    ],
    [
      'a series entry without a t array',
      { series: [{ quantity: 'voltage', of: 'bus:7', unit: 'pu', y: [] }] },
      'series 0 has no t array',
    ],
    [
      'a series entry without a y array',
      { series: [{ quantity: 'voltage', of: 'bus:7', unit: 'pu', t: [] }] },
      'series 0 has no y array',
    ],
  ])('throws "not a results document" for %s', (_what, doc, detail) => {
    expect(() => parseResultsDocumentFile(JSON.stringify(doc), 'x.json')).toThrow(
      `x.json is not a results document: ${detail}`,
    );
  });
});

describe('buildCompareRequest', () => {
  const side = (label: string) => ({
    document: {
      tensa_results: 1 as const,
      engine: { name: 'andes' },
      status: 'completed' as const,
      series: [{ quantity: 'voltage', of: 'bus:7', unit: 'pu', t: [0], y: [1] }],
    },
    label,
  });

  it('sends no tolerances key when every field is at its default text', () => {
    const body = buildCompareRequest(side('A'), side('B'), defaultTolerances());
    expect(body).toEqual({
      reference: side('A').document,
      comparison: side('B').document,
    });
    expect(body).not.toHaveProperty('tolerances');
  });

  it('sends only frequency_hz when only it differs, as a number', () => {
    const body = buildCompareRequest(side('A'), side('B'), {
      ...defaultTolerances(),
      frequency_hz: '0.05',
    });
    expect(body.tolerances).toEqual({ frequency_hz: 0.05 });
  });

  it('sends only the quantity that differs, as a number', () => {
    const body = buildCompareRequest(side('A'), side('B'), {
      ...defaultTolerances(),
      quantities: { voltage: '0.002' },
    });
    expect(body.tolerances).toEqual({ quantities: { voltage: 0.002 } });
  });

  it('sends damping and mode distance when they differ', () => {
    const body = buildCompareRequest(side('A'), side('B'), {
      ...defaultTolerances(),
      damping_ratio: '0.1',
      max_mode_distance: '0.2',
    });
    expect(body.tolerances).toEqual({ damping_ratio: 0.1, max_mode_distance: 0.2 });
  });

  it('the default quantity texts are the server defaults', () => {
    // engines/compare.py: voltage 1e-3 pu, angle 1e-2 rad, rotor speed 1e-3 pu,
    // rotor angle 1e-2 rad, p/q 1 MW/MVAr.
    expect(DEFAULT_QUANTITY_TOLERANCES.voltage).toEqual({ value: 1e-3, text: '0.001', unit: 'pu' });
    expect(DEFAULT_QUANTITY_TOLERANCES.angle).toEqual({ value: 1e-2, text: '0.01', unit: 'rad' });
    expect(DEFAULT_QUANTITY_TOLERANCES.rotor_speed).toEqual({
      value: 1e-3,
      text: '0.001',
      unit: 'pu',
    });
    expect(DEFAULT_QUANTITY_TOLERANCES.rotor_angle).toEqual({
      value: 1e-2,
      text: '0.01',
      unit: 'rad',
    });
    expect(DEFAULT_QUANTITY_TOLERANCES.p).toEqual({ value: 1.0, text: '1', unit: 'MW' });
  });
});
