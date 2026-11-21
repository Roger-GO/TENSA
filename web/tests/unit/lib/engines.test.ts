/**
 * Tests for `lib/engines.ts`: the label an engine is shown by and the
 * routines of the session's engine read off the engines list.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE, engineLabel, engineRoutines } from '@/lib/engines';
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
