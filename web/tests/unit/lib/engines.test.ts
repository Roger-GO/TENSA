/**
 * Tests for `lib/engines.ts`: the label an engine is shown by and the
 * routines of the session's engine read off the engines list.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE,
  SAVE_FORMATS,
  engineDisturbanceKinds,
  engineHasOp,
  engineLabel,
  engineLoadModels,
  enginePflowMethods,
  engineRoutineOptions,
  engineRoutines,
  engineSaveFormats,
  engineTakesAndesPflowOptions,
  engineVersionsLine,
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

describe('enginePflowMethods', () => {
  const withMethods = (name: string, methods: string[]): EngineCapabilities => ({
    ...makeEngine(name, ['pflow']),
    routine_options: { pflow: { methods } },
  });

  it('answers the methods of the engine’s pflow routine options', () => {
    const engines: EngineList = {
      engines: [
        withMethods('andes', ['NR', 'dishonest', 'NK']),
        withMethods('sienna', ['ac', 'dc', 'ptdf-dc']),
      ],
    };
    expect(enginePflowMethods(engines, 'sienna')).toEqual(['ac', 'dc', 'ptdf-dc']);
    expect(enginePflowMethods(engines, 'andes')).toEqual(['NR', 'dishonest', 'NK']);
  });

  it('answers null when the list is not loaded, the engine is not named, or the entry has no methods', () => {
    const engines: EngineList = { engines: [withMethods('andes', ['NR'])] };
    expect(enginePflowMethods(undefined, 'andes')).toBeNull();
    expect(enginePflowMethods(null, 'andes')).toBeNull();
    expect(enginePflowMethods(engines, null)).toBeNull();
    expect(enginePflowMethods(engines, 'sienna')).toBeNull();
    expect(enginePflowMethods({ engines: [makeEngine('andes', ['pflow'])] }, 'andes')).toBeNull();
  });

  it('answers null for an entry whose methods are not an array of strings', () => {
    const bad = {
      ...makeEngine('andes', ['pflow']),
      routine_options: { pflow: { methods: 'NR' } },
    } as unknown as EngineCapabilities;
    expect(enginePflowMethods({ engines: [bad] }, 'andes')).toBeNull();
  });
});

describe('engineHasOp', () => {
  const withOps = (name: string, ops: string[]): EngineCapabilities => ({
    ...makeEngine(name, []),
    ops,
  });

  it('is true when the engine lists the op', () => {
    const engines: EngineList = {
      engines: [withOps('sienna', ['network_matrix', 'pflow']), withOps('andes', ['ybus'])],
    };
    expect(engineHasOp(engines, 'sienna', 'network_matrix')).toBe(true);
    expect(engineHasOp(engines, 'andes', 'network_matrix')).toBe(false);
  });

  it('is false when anything is missing', () => {
    const engines: EngineList = { engines: [withOps('sienna', ['network_matrix'])] };
    expect(engineHasOp(undefined, 'sienna', 'network_matrix')).toBe(false);
    expect(engineHasOp(null, 'sienna', 'network_matrix')).toBe(false);
    expect(engineHasOp(engines, null, 'network_matrix')).toBe(false);
    expect(engineHasOp(engines, 'andes', 'network_matrix')).toBe(false);
    expect(engineHasOp({ engines: [makeEngine('sienna', [])] }, 'sienna', 'network_matrix')).toBe(
      false,
    );
  });
});

describe('engineTakesAndesPflowOptions', () => {
  it('is true for ANDES and for an engine not known yet, false for Sienna', () => {
    expect(engineTakesAndesPflowOptions('andes')).toBe(true);
    expect(engineTakesAndesPflowOptions(null)).toBe(true);
    expect(engineTakesAndesPflowOptions('sienna')).toBe(false);
  });
});

describe('engineVersionsLine', () => {
  it('answers null for an absent or empty map', () => {
    expect(engineVersionsLine(undefined)).toBeNull();
    expect(engineVersionsLine({})).toBeNull();
  });

  it("answers ANDES's one package", () => {
    expect(engineVersionsLine({ andes: '1.9.3' })).toBe('andes 1.9.3');
  });

  it('puts julia first, then the packages alphabetically, joined with a comma', () => {
    // The expected string is written out by hand: julia, then PowerFlows,
    // PowerNetworkMatrices, PowerSimulations, PowerSystems alphabetically.
    const versions = {
      PowerSystems: '5.12.5',
      julia: '1.11.3',
      PowerSimulationsDynamics: '0.18.1',
      PowerFlows: '0.16.4',
      PowerNetworkMatrices: '0.15.2',
    };
    expect(engineVersionsLine(versions)).toBe(
      'julia 1.11.3, PowerFlows 0.16.4, PowerNetworkMatrices 0.15.2, ' +
        'PowerSimulationsDynamics 0.18.1, PowerSystems 5.12.5',
    );
  });
});

describe('engineRoutineOptions', () => {
  function siennaWithRoutineOptions(): EngineList {
    const sienna = {
      ...makeEngine('sienna', ['matrices', 'pflow', 'eig', 'tds']),
      routine_options: {
        pflow: { methods: ['ac', 'dc', 'ptdf-dc'] },
        tds: {
          streaming: true,
          abort: true,
          disturbances: ['branch_trip', 'bus_fault', 'gen_trip'],
          options: { load_model: ['impedance', 'power', 'as-case'] },
        },
      },
    } as unknown as EngineCapabilities;
    return { engines: [makeEngine('andes', ['pflow', 'tds', 'eig', 'cpf', 'se']), sienna] };
  }

  it('returns the tds block of an engine that carries one', () => {
    expect(engineRoutineOptions(siennaWithRoutineOptions(), 'sienna', 'tds')).toEqual({
      streaming: true,
      abort: true,
      disturbances: ['branch_trip', 'bus_fault', 'gen_trip'],
      options: { load_model: ['impedance', 'power', 'as-case'] },
    });
  });

  it('returns null for a routine the block does not name, and for an engine with no block', () => {
    expect(engineRoutineOptions(siennaWithRoutineOptions(), 'sienna', 'eig')).toBeNull();
    expect(engineRoutineOptions(siennaWithRoutineOptions(), 'andes', 'tds')).toBeNull();
  });

  it('returns null when the list is not loaded or the engine is null', () => {
    expect(engineRoutineOptions(undefined, 'sienna', 'tds')).toBeNull();
    expect(engineRoutineOptions(null, 'sienna', 'tds')).toBeNull();
    expect(engineRoutineOptions(siennaWithRoutineOptions(), null, 'tds')).toBeNull();
  });
});

describe('engineLoadModels', () => {
  const engines: EngineList = {
    engines: [
      makeEngine('andes', ['pflow', 'tds', 'eig']),
      {
        ...makeEngine('sienna', ['pflow', 'eig', 'tds']),
        routine_options: {
          tds: {
            streaming: true,
            abort: true,
            disturbances: ['branch_trip', 'bus_fault', 'gen_trip'],
            options: { load_model: ['impedance', 'power', 'as-case'] },
          },
        },
      } as unknown as EngineCapabilities,
    ],
  };

  it("returns the server's list, in its order, for an engine that takes one", () => {
    expect(engineLoadModels(engines, 'sienna')).toEqual(['impedance', 'power', 'as-case']);
  });

  it('returns null for ANDES and for an unloaded list', () => {
    expect(engineLoadModels(engines, 'andes')).toBeNull();
    expect(engineLoadModels(undefined, 'sienna')).toBeNull();
    expect(engineLoadModels(engines, null)).toBeNull();
  });
});

describe('engineDisturbanceKinds', () => {
  const engines: EngineList = {
    engines: [
      makeEngine('andes', ['pflow', 'tds', 'eig']),
      {
        ...makeEngine('sienna', ['pflow', 'eig', 'tds']),
        routine_options: {
          tds: {
            streaming: true,
            abort: true,
            disturbances: ['branch_trip', 'bus_fault', 'gen_trip'],
            options: { load_model: ['impedance', 'power', 'as-case'] },
          },
        },
      } as unknown as EngineCapabilities,
    ],
  };

  it('returns the accepted kinds for Sienna, null for ANDES and an unloaded list', () => {
    expect(engineDisturbanceKinds(engines, 'sienna')).toEqual([
      'branch_trip',
      'bus_fault',
      'gen_trip',
    ]);
    expect(engineDisturbanceKinds(engines, 'andes')).toBeNull();
    expect(engineDisturbanceKinds(undefined, 'sienna')).toBeNull();
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
