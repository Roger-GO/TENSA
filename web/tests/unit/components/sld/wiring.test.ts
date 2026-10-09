/**
 * Connecting by a drag, as far as it needs no canvas: which bus a place on
 * the diagram is on, what connecting a draft to a bus sets on it, and what
 * moving a device of the system to another bus asks of the server.
 */
import { describe, expect, it } from 'vitest';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import { BAR_LENGTH, BAR_THICKNESS, type BarGeometry } from '@/components/sld/connections';
import {
  attachDraft,
  branchValues,
  busAt,
  busBars,
  busDroppedOn,
  busFields,
  busTitle,
  busUnderBox,
  connectsToBus,
  isBranchKind,
  moveToBus,
  movedModels,
  nearestOnBar,
  wiringHint,
  wiringTitle,
  type BusBar,
} from '@/components/sld/wiring';
import { TOPOLOGY_SCHEMA } from '../../helpers/topologySchema';

const metas = (model: string) => TOPOLOGY_SCHEMA.models[model]!;

function entry(idx: string | number, kind: string, params: TopologyEntry['params']): TopologyEntry {
  return { idx, name: String(idx), kind, params };
}

describe('which bus a place on the diagram is on', () => {
  const nodes = [
    { id: '1', type: 'bus', position: { x: 0, y: 0 }, data: { name: 'BUS1' } },
    { id: '2', type: 'bus', position: { x: 0, y: 40 }, data: { name: '2' } },
    { id: 'load-PQ_1', type: 'load', position: { x: 30, y: 60 }, data: { name: 'PQ_1' } },
  ];
  // The bar of bus 2 was drawn out to the left for a tap.
  const bars = new Map<string, BarGeometry>([['2', { start: -20, end: 92, taps: [] }]]);
  const drawn = busBars(nodes, { bars });

  it('reads the bars of the buses as they are drawn, and of nothing else', () => {
    expect(drawn).toEqual<BusBar[]>([
      {
        id: '1',
        name: 'BUS1',
        box: { left: 0, right: BAR_LENGTH, top: 0, bottom: BAR_THICKNESS },
      },
      { id: '2', name: '2', box: { left: -20, right: 92, top: 40, bottom: 40 + BAR_THICKNESS } },
    ]);
    expect(busTitle(drawn[0]!)).toBe('bus 1 (BUS1)');
    expect(busTitle(drawn[1]!)).toBe('bus 2');
  });

  it('takes a place for the bus whose bar is in reach, and for none past the reach', () => {
    expect(busAt({ x: 46, y: 3 }, drawn, 10)).toBe('1');
    expect(busAt({ x: 46, y: -9 }, drawn, 10)).toBe('1');
    expect(busAt({ x: 46, y: -11 }, drawn, 10)).toBeNull();
    // Beside the tip, by the straight way to the bar.
    expect(busAt({ x: BAR_LENGTH + 6, y: -6 }, drawn, 10)).toBe('1');
    expect(busAt({ x: BAR_LENGTH + 8, y: -8 }, drawn, 10)).toBeNull();
    // On the part of a bar that was drawn out.
    expect(busAt({ x: -15, y: 43 }, drawn, 10)).toBe('2');
  });

  it('takes the nearer of two bars that are both in reach', () => {
    expect(busAt({ x: 46, y: 18 }, drawn, 40)).toBe('1');
    expect(busAt({ x: 46, y: 30 }, drawn, 40)).toBe('2');
  });

  it('takes a symbol for the bus whose bar its box lies on, the nearest to its middle', () => {
    const over = (top: number) => ({ left: 10, right: 106, top, bottom: top + 64 });
    // On both bars: the one its middle is nearer to.
    expect(busUnderBox(over(0), drawn)).toBe('2');
    expect(busUnderBox(over(-20), drawn)).toBe('1');
    // On the upper one alone.
    expect(busUnderBox(over(-62), drawn)).toBe('1');
    // Clear of both.
    expect(busUnderBox(over(-80), drawn)).toBeNull();
    expect(busUnderBox({ left: 200, right: 296, top: 0, bottom: 64 }, drawn)).toBeNull();
  });

  describe('for a component that is dropped', () => {
    // The name of bus 1 under its bar, and the name of bus 2 beside its tip.
    const around = new Map([
      ['1', [{ left: 30, right: 62, top: 10, bottom: 22 }]],
      ['2', [{ left: 100, right: 120, top: 36, bottom: 48 }]],
    ]);

    it('takes the bar in reach first, as a place on the diagram is read', () => {
      expect(busDroppedOn({ x: 46, y: 3 }, drawn, 10, around)).toBe('1');
      expect(busDroppedOn({ x: -15, y: 43 }, drawn, 10, around)).toBe('2');
    });

    it('takes the name of a bus for that bus, where no bar is in reach', () => {
      // Too far under the bar of bus 1 for the bar, and on its name.
      expect(busAt({ x: 46, y: 20 }, drawn, 10)).toBeNull();
      expect(busDroppedOn({ x: 46, y: 20 }, drawn, 10, around)).toBe('1');
      // Beside the tip of bus 2, on its name.
      expect(busDroppedOn({ x: 115, y: 44 }, drawn, 5, around)).toBe('2');
      // A little way off a name still counts, by a part of the reach of a bar.
      expect(busDroppedOn({ x: 122, y: 44 }, drawn, 10, around)).toBe('2');
      expect(busDroppedOn({ x: 126, y: 44 }, drawn, 10, around)).toBeNull();
    });

    it('takes the bar where a place is on the name of one bus and in reach of the bar of another', () => {
      // The name of bus 1 stands just over the bar of bus 2.
      const over = new Map([['1', [{ left: 30, right: 62, top: 28, bottom: 38 }]]]);
      expect(busDroppedOn({ x: 46, y: 36 }, drawn, 10, over)).toBe('2');
    });

    it('takes the name the place is nearer to, and of two it is on, the one with the nearer bar', () => {
      const both = new Map([
        ['1', [{ left: 30, right: 62, top: 10, bottom: 22 }]],
        ['2', [{ left: 40, right: 72, top: 14, bottom: 26 }]],
      ]);
      // On both names, at 14 from the bar of bus 1 and 20 from that of bus 2.
      expect(busDroppedOn({ x: 50, y: 20 }, drawn, 10, both)).toBe('1');
    });

    it('is on no bus on free ground, and with no names to go by', () => {
      expect(busDroppedOn({ x: 300, y: 300 }, drawn, 10, around)).toBeNull();
      expect(busDroppedOn({ x: 46, y: 20 }, drawn, 10, new Map())).toBeNull();
    });
  });

  it('leaves a bar at the place nearest to where the line goes', () => {
    const box = drawn[0]!.box;
    expect(nearestOnBar(box, { x: 30, y: 200 })).toEqual([30, BAR_THICKNESS / 2]);
    expect(nearestOnBar(box, { x: -50, y: 200 })).toEqual([0, BAR_THICKNESS / 2]);
    expect(nearestOnBar(box, { x: 500, y: -20 })).toEqual([BAR_LENGTH, BAR_THICKNESS / 2]);
  });
});

describe('what connecting a draft to a bus sets on it', () => {
  it('knows which kinds are on a bus at all', () => {
    expect(busFields(metas('PQ'))).toEqual(['bus']);
    expect(busFields(metas('Line'))).toEqual(['bus1', 'bus2']);
    expect(busFields(metas('Bus'))).toEqual([]);
    expect(connectsToBus(metas('GENROU'))).toBe(true);
    expect(connectsToBus(metas('IEEEX1'))).toBe(false);
    expect(connectsToBus(null)).toBe(false);
    expect(isBranchKind('Line')).toBe(true);
    expect(isBranchKind('Transformer2W')).toBe(true);
    expect(isBranchKind('PQ')).toBe(false);
  });

  it('puts a device on the bus, and on another bus when it had one', () => {
    expect(attachDraft('PQ load', metas('PQ'), {}, '5')).toEqual({
      patch: { bus: '5' },
      field: 'bus',
    });
    expect(attachDraft('PQ load', metas('PQ'), { bus: 3 }, '5')).toEqual({
      patch: { bus: '5' },
      field: 'bus',
    });
  });

  it('refuses the bus a device is on already, and a kind that is on no bus', () => {
    expect(attachDraft('PQ load', metas('PQ'), { bus: 5 }, '5')).toEqual({
      refused: 'It is on bus 5 already.',
    });
    expect(attachDraft('Bus', metas('Bus'), {}, '5')).toEqual({
      refused: 'A Bus is not connected to a bus, so it stays where it stands.',
    });
    expect(attachDraft('IEEEX1 exciter', null, {}, '5')).toHaveProperty('refused');
  });

  it('gives a line its first open end, and then the other', () => {
    expect(attachDraft('Line', metas('Line'), {}, '4')).toEqual({
      patch: { bus1: '4' },
      field: 'bus1',
      ends: { from: '4', to: null },
    });
    expect(attachDraft('Line', metas('Line'), { bus1: '4' }, '9')).toEqual({
      patch: { bus2: '9' },
      field: 'bus2',
      ends: { from: '4', to: '9' },
    });
    // Its start was cleared in its form: that is the end that is open.
    expect(attachDraft('Line', metas('Line'), { bus1: '', bus2: 9 }, '4')).toEqual({
      patch: { bus1: '4' },
      field: 'bus1',
      ends: { from: '4', to: '9' },
    });
  });

  it('moves the far end of a line that has both, and never puts both ends on one bus', () => {
    expect(attachDraft('Line', metas('Line'), { bus1: '4', bus2: '9' }, '7')).toEqual({
      patch: { bus2: '7' },
      field: 'bus2',
      ends: { from: '4', to: '7' },
    });
    expect(attachDraft('Line', metas('Line'), { bus1: '4' }, '4')).toHaveProperty('refused');
    expect(attachDraft('Line', metas('Line'), { bus1: '4', bus2: 9 }, '9')).toHaveProperty(
      'refused',
    );
  });

  it('starts a line that is drawn with its two buses', () => {
    expect(branchValues('4', '9')).toEqual({ bus1: '4', bus2: '9' });
  });
});

/** Two buses at 69 kV and one at 138 kV, with a load, a shunt and two generators. */
function system(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [entry(1, 'Bus', { Vn: 69 }), entry(2, 'Bus', { Vn: 69 }), entry(3, 'Bus', { Vn: 138 })],
    lines: [],
    transformers: [],
    generators: [
      entry(1, 'PV', { bus: 1, Vn: 69 }),
      entry('GENROU_1', 'GENROU', { bus: 1, gen: 1, Vn: 69 }),
      entry(2, 'Slack', { bus: 2, Vn: 69 }),
    ],
    loads: [entry('PQ_1', 'PQ', { bus: 1, Vn: 69 }), entry('PQ_2', 'PQ', { bus: 2, Vn: 100 })],
    shunts: [entry('Shunt_1', 'Shunt', { bus: 2, Vn: 69 })],
    controllers: [
      entry('EXC_1', 'IEEEX1', { syn: 'GENROU_1' }),
      entry('TG_1', 'TGOV1', { syn: 'GENROU_1' }),
    ],
  };
}

describe('what moving a device of the system to another bus asks of the server', () => {
  it('edits the bus of a load, with the idx the case has for the bus', () => {
    expect(moveToBus(system(), TOPOLOGY_SCHEMA, 'load-PQ_1', '2')).toEqual({
      from: '1',
      to: '2',
      edits: [{ model: 'PQ', idx: 'PQ_1', params: { bus: 2 } }],
      rated: null,
    });
  });

  it('takes the rated voltage along to a bus of another voltage', () => {
    expect(moveToBus(system(), TOPOLOGY_SCHEMA, 'shunt-Shunt_1', '3')).toEqual({
      from: '2',
      to: '3',
      edits: [{ model: 'Shunt', idx: 'Shunt_1', params: { bus: 3, Vn: 138 } }],
      rated: { from: 69, to: 138 },
    });
  });

  it('leaves a rating that was not the rating of the bus it leaves', () => {
    expect(moveToBus(system(), TOPOLOGY_SCHEMA, 'load-PQ_2', '3')).toEqual({
      from: '2',
      to: '3',
      edits: [{ model: 'PQ', idx: 'PQ_2', params: { bus: 3 } }],
      rated: null,
    });
  });

  it('moves every model of a generating unit that names the bus itself, the generator first', () => {
    const move = moveToBus(system(), TOPOLOGY_SCHEMA, 'generator-1', '3');
    expect(move).toEqual({
      from: '1',
      to: '3',
      edits: [
        { model: 'PV', idx: '1', params: { bus: 3, Vn: 138 } },
        { model: 'GENROU', idx: 'GENROU_1', params: { bus: 3, Vn: 138 } },
      ],
      rated: { from: 69, to: 138 },
    });
    // The exciter and the governor name the machine and follow it.
    expect(movedModels('edits' in move ? move.edits : [])).toBe('PV 1 and GENROU_1');
  });

  it('refuses the bus the device is on, a bus the system has not, and a device that is gone', () => {
    expect(moveToBus(system(), TOPOLOGY_SCHEMA, 'load-PQ_1', '1')).toEqual({
      refused: 'PQ_1 is on bus 1 already.',
    });
    expect(moveToBus(system(), TOPOLOGY_SCHEMA, 'load-PQ_1', '9')).toEqual({
      refused: 'The system has no bus 9.',
    });
    expect(moveToBus(system(), TOPOLOGY_SCHEMA, 'load-PQ_9', '2')).toHaveProperty('refused');
    expect(moveToBus(system(), TOPOLOGY_SCHEMA, 'controller-IEEEX1-EXC_1', '2')).toHaveProperty(
      'refused',
    );
  });

  it('refuses a model whose bus the server does not take an edit of', () => {
    const topology = system();
    topology.loads = [entry('X_1', 'Mystery', { bus: 1 })];
    expect(moveToBus(topology, TOPOLOGY_SCHEMA, 'load-X_1', '2')).toEqual({
      refused: 'The bus of a Mystery cannot be changed here. Delete it and add it on bus 2.',
    });
    expect(moveToBus(system(), null, 'load-PQ_1', '2')).toHaveProperty('refused');
  });

  it('names the models it moved', () => {
    expect(movedModels([{ model: 'PQ', idx: 'PQ_1', params: {} }])).toBe('PQ_1');
    expect(
      movedModels([
        { model: 'PV', idx: '2', params: {} },
        { model: 'GENROU', idx: 'GENROU_2', params: {} },
        { model: 'ESD1', idx: 'B', params: {} },
      ]),
    ).toBe('PV 2, GENROU_2 and ESD1 B');
  });
});

describe('what the bar says while a bus is picked', () => {
  const bars: BusBar[] = [
    { id: '4', name: 'Bus 4', box: { left: 0, right: 92, top: 0, bottom: 6 } },
  ];

  it('names what is drawn or moved', () => {
    expect(wiringTitle({ kind: 'draw', model: 'Line', from: null })).toBe('Draw a line');
    expect(wiringTitle({ kind: 'draw', model: 'Transformer2W', from: '4' })).toBe(
      'Draw a transformer',
    );
    expect(wiringTitle({ kind: 'move', nodeId: 'load-PQ_1', name: 'load PQ_1', bus: '4' })).toBe(
      'Move load PQ_1 to another bus',
    );
    expect(
      wiringTitle({ kind: 'move', nodeId: 'draft-1', name: 'draft PQ load 3', bus: null }),
    ).toBe('Connect draft PQ load 3');
  });

  it('says what to press next, and how to stop', () => {
    expect(wiringHint({ kind: 'draw', model: 'Line', from: null }, bars)).toMatch(
      /^Click the bus it starts from and then the bus it goes to, or drag from one to the other\. Esc cancels\.$/,
    );
    expect(wiringHint({ kind: 'draw', model: 'Line', from: '4' }, bars)).toBe(
      'From bus 4 (Bus 4): now click the bus it goes to. Esc cancels.',
    );
    expect(
      wiringHint({ kind: 'move', nodeId: 'load-PQ_1', name: 'load PQ_1', bus: '4' }, bars),
    ).toMatch(/^It is on bus 4 \(Bus 4\)\. Click the bus to move it to/);
    expect(wiringHint({ kind: 'move', nodeId: 'draft-1', name: 'draft', bus: null }, bars)).toBe(
      'Click the bus to connect it to. Esc cancels.',
    );
  });
});
