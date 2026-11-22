import { describe, expect, it } from 'vitest';
import {
  buildCompareRequest,
  DEFAULT_DAMPING_TOLERANCE_TEXT,
  DEFAULT_FREQ_TOLERANCE_HZ_TEXT,
  DEFAULT_MAX_MODE_DISTANCE_TEXT,
  DEFAULT_QUANTITY_TOLERANCES,
  parseResultsDocumentFile,
} from '@/lib/resultsDocument';
import type { CompareSide, CompareTolerancesInput } from '@/api/queries/compare';
import { useCompareViewStore } from '@/store/compareView';

function side(document: CompareSide['document']): CompareSide {
  return { document, label: 'side' };
}

function defaultTolerances(): CompareTolerancesInput {
  return {
    quantities: Object.fromEntries(
      Object.entries(DEFAULT_QUANTITY_TOLERANCES).map(([q, def]) => [q, def.text]),
    ),
    frequency_hz: DEFAULT_FREQ_TOLERANCE_HZ_TEXT,
    damping_ratio: DEFAULT_DAMPING_TOLERANCE_TEXT,
    max_mode_distance: DEFAULT_MAX_MODE_DISTANCE_TEXT,
  };
}

const DOCUMENT = {
  tensa_results: 1,
  engine: { name: 'andes' },
  status: 'completed',
  series: [{ quantity: 'voltage', of: 'bus:1', unit: 'pu', t: [0, 1], y: [1, 1.01] }],
};

describe('DEFAULT_QUANTITY_TOLERANCES', () => {
  it('holds the values of DEFAULT_TOLERANCES in server/src/tensa/engines/compare.py', () => {
    // compare.py DEFAULT_TOLERANCES: voltage 1e-4, angle 1e-4, rotor_speed
    // 1e-4, rotor_angle 1e-2, p, q, p_from and q_from 0.1.
    const expected: Record<string, number> = {
      voltage: 1e-4,
      angle: 1e-4,
      rotor_speed: 1e-4,
      rotor_angle: 1e-2,
      p: 0.1,
      q: 0.1,
      p_from: 0.1,
      q_from: 0.1,
    };
    for (const [quantity, value] of Object.entries(expected)) {
      expect(DEFAULT_QUANTITY_TOLERANCES[quantity]?.value).toBe(value);
      expect(Number(DEFAULT_QUANTITY_TOLERANCES[quantity]?.text)).toBe(value);
    }
    // The server's DEFAULT_FREQ_TOLERANCE_HZ, DEFAULT_DAMPING_TOLERANCE and
    // DEFAULT_MAX_MODE_DISTANCE: a field left at its default is not sent, so
    // it must show what the server applies.
    expect(Number(DEFAULT_FREQ_TOLERANCE_HZ_TEXT)).toBe(0.001);
    expect(Number(DEFAULT_DAMPING_TOLERANCE_TEXT)).toBe(0.001);
    expect(Number(DEFAULT_MAX_MODE_DISTANCE_TEXT)).toBe(0.05);
    // The compare view store starts its fields at the same texts.
    const initial = useCompareViewStore.getInitialState();
    expect(initial.frequencyHz).toBe(DEFAULT_FREQ_TOLERANCE_HZ_TEXT);
    expect(initial.dampingRatio).toBe(DEFAULT_DAMPING_TOLERANCE_TEXT);
    expect(initial.maxModeDistance).toBe(DEFAULT_MAX_MODE_DISTANCE_TEXT);
  });
});

describe('buildCompareRequest', () => {
  it('sends no tolerances when every field is at its default', () => {
    const body = buildCompareRequest(
      side(DOCUMENT as CompareSide['document']),
      side(DOCUMENT as CompareSide['document']),
      defaultTolerances(),
    );
    expect(body.tolerances).toBeUndefined();
  });

  it('sends a changed field as changed and leaves the rest to the server defaults', () => {
    const tolerances = defaultTolerances();
    tolerances.quantities.voltage = '0.005';
    tolerances.damping_ratio = '0.5';
    const body = buildCompareRequest(
      side(DOCUMENT as CompareSide['document']),
      side(DOCUMENT as CompareSide['document']),
      tolerances,
    );
    expect(body.tolerances).toEqual({
      quantities: { voltage: 0.005 },
      damping_ratio: 0.5,
    });
  });
});

describe('parseResultsDocumentFile', () => {
  it('keeps the engine and status of a loaded Sienna document', () => {
    const file = {
      tensa_results: 1,
      engine: { name: 'sienna', versions: { PowerSystems: '5.12.5' } },
      status: 'failed',
      series: [{ quantity: 'rotor_speed', of: 'gen:1-1', unit: 'pu', t: [0, 1], y: [1, 1] }],
    };
    const parsed = parseResultsDocumentFile(JSON.stringify(file), 'run.json');
    expect(parsed.document.engine?.name).toBe('sienna');
    expect(parsed.document.engine?.versions).toEqual({ PowerSystems: '5.12.5' });
    expect(parsed.document.status).toBe('failed');
    expect(parsed.label).toBe('run');
  });

  it('refuses a document without an engine block, naming the field', () => {
    const file = { tensa_results: 1, status: 'completed', series: [] };
    expect(() => parseResultsDocumentFile(JSON.stringify(file), 'run.json')).toThrow(/engine/);
  });

  it('refuses a document without a status, naming the field', () => {
    const file = { tensa_results: 1, engine: { name: 'andes' }, series: [] };
    expect(() => parseResultsDocumentFile(JSON.stringify(file), 'run.json')).toThrow(/status/);
  });

  it('refuses a document that is not JSON', () => {
    expect(() => parseResultsDocumentFile('not json', 'run.json')).toThrow(/not a JSON file/);
  });
});
