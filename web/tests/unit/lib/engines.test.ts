/**
 * Tests for `lib/engines.ts`: the label an engine is shown by and the
 * routines of the session's engine read off the engines list.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE,
  SAVE_FORMATS,
  engineLabel,
  engineRoutines,
  engineSaveFormats,
} from '@/lib/engines';
import type { EngineCapabilities, EngineList } from '@/api/types';

function makeEngine(name: string, routines: string[]): EngineCapabilities {
  return {
    name,
    available: true,
    unavailable_reason: null,
    versions: {},
    formats: { read: [], write: [] },
    routines,
    ops: [],
    editing: false,
  };
}

function makeEngineWriting(name: string, write: string[]): EngineCapabilities {
  return {
    ...makeEngine(name, []),
    formats: { read: [], write },
  };
}

const ENGINES: EngineList = {
  engines: [
    makeEngine('andes', ['pflow', 'tds', 'eig', 'cpf', 'se']),
    makeEngine('sienna', ['pflow']),
  ],
};

describe('engineLabel', () => {
  it('names andes ANDES and sienna Sienna', () => {
    expect(engineLabel('andes')).toBe('ANDES');
    expect(engineLabel('sienna')).toBe('Sienna');
  });

  it('shows any other engine by its own name', () => {
    expect(engineLabel('psse')).toBe('psse');
  });

  it('the default engine is andes', () => {
    expect(DEFAULT_ENGINE).toBe('andes');
  });
});

describe('engineRoutines', () => {
  it('answers the routines of a named engine', () => {
    expect(engineRoutines(ENGINES, 'sienna')).toEqual(['pflow']);
  });

  it('answers null for an engine the list does not name', () => {
    expect(engineRoutines(ENGINES, 'psse')).toBeNull();
  });

  it('answers null when the list is not loaded', () => {
    expect(engineRoutines(undefined, 'andes')).toBeNull();
  });

  it('answers null for a null engine', () => {
    expect(engineRoutines(ENGINES, null)).toBeNull();
  });
});

describe('engineSaveFormats', () => {
  it('answers all four in SAVE_FORMATS order, whatever order the capability lists them in', () => {
    const engines: EngineList = {
      engines: [makeEngineWriting('andes', ['json', 'matpower', 'psse-raw', 'xlsx'])],
    };
    expect(engineSaveFormats(engines, 'andes')).toEqual(SAVE_FORMATS);
    expect(engineSaveFormats(engines, 'andes')).toEqual(['xlsx', 'raw', 'm', 'json']);
  });

  it('answers no m for an engine that does not write matpower', () => {
    const engines: EngineList = {
      engines: [makeEngineWriting('andes', ['xlsx', 'psse-raw', 'json'])],
    };
    expect(engineSaveFormats(engines, 'andes')).toEqual(['xlsx', 'raw', 'json']);
  });

  it('answers [] for an engine that writes nothing', () => {
    const engines: EngineList = {
      engines: [makeEngineWriting('andes', [])],
    };
    expect(engineSaveFormats(engines, 'andes')).toEqual([]);
  });

  it('ignores a capability name with no mapping', () => {
    const engines: EngineList = {
      engines: [makeEngineWriting('andes', ['xlsx', 'hdf5', 'matpower'])],
    };
    expect(engineSaveFormats(engines, 'andes')).toEqual(['xlsx', 'm']);
  });

  it('answers the three every server has when the list is null or undefined', () => {
    expect(engineSaveFormats(null, 'andes')).toEqual(['xlsx', 'raw', 'json']);
    expect(engineSaveFormats(undefined, 'andes')).toEqual(['xlsx', 'raw', 'json']);
  });

  it('answers the three when the list has no entry for the engine', () => {
    const engines: EngineList = {
      engines: [makeEngineWriting('sienna', ['matpower'])],
    };
    expect(engineSaveFormats(engines, 'andes')).toEqual(['xlsx', 'raw', 'json']);
  });

  it("answers the default engine's formats for a null engine", () => {
    const engines: EngineList = {
      engines: [
        makeEngineWriting(DEFAULT_ENGINE, ['xlsx', 'matpower']),
        makeEngineWriting('sienna', []),
      ],
    };
    expect(engineSaveFormats(engines, null)).toEqual(['xlsx', 'm']);
    expect(engineSaveFormats(engines, undefined)).toEqual(['xlsx', 'm']);
  });

  it('answers the three when the entry has no formats.write array', () => {
    const entry = makeEngineWriting('andes', ['matpower']) as unknown as Record<string, unknown>;
    delete entry.formats;
    const engines = { engines: [entry] } as unknown as EngineList;
    expect(engineSaveFormats(engines, 'andes')).toEqual(['xlsx', 'raw', 'json']);
  });
});
